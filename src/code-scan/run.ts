import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { FactError } from "../types.js";
import type { ProgressSink } from "../verify/config.js";

const frameworks = ["express", "fastify", "nest", "fastapi", "flask", "gin", "chi", "spring", "aspnet", "axum", "laravel"];
export const scanCapabilities = {
  frameworks, openapiVersion: "3.2.0", readOnly: true, executesProjectCode: false,
  aiEnabled: false, timeoutMs: 120000, maxFiles: 10000,
  maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxResultBytes: 8 * 1024 * 1024,
};
export const codeScanTools: Tool[] = [
  {
    name: "get_code_scan_capabilities",
    description: "List supported source frameworks, output version and code-scanning resource limits. Does not read the project or require an existing OpenAPI file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "scan_code_to_openapi",
    description: "Scan source code inside the configured project root (defaults to the specification directory) and return an OpenAPI 3.2 document, completeness report and diagnostics. Does not execute project code, call AI, or write files. Missing or invalid specifications do not block scanning. Inspect unresolved gaps before using the generated contract.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        directory: { type: "string", default: ".", description: "Project-relative subdirectory to scan; cannot escape the configured root." },
        frameworks: { type: "array", items: { type: "string", enum: frameworks }, minItems: 1, uniqueItems: true },
        includeTests: { type: "boolean", default: false },
        timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 120000 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

// Workers isolate synchronous AST parsing. Termination, not Promise.race, stops
// CPU/file work on cancellation. One scan per process also bounds HTTP sessions.
let active = false;
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { scanProject } = require(workerData.modulePath);
  let last = 0;
  const result = await scanProject({ ...workerData.options, onProgress(phase) {
    const now = Date.now();
    if (now - last >= 100) { last = now; parentPort.postMessage({ progress: phase }); }
  }});
  const converted = await result.convert();
  const payload = { document: converted.document, report: result.report,
    diagnostics: converted.diagnostics, ok: converted.ok, documentValid: converted.documentValid };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > workerData.maxResultBytes) {
    parentPort.postMessage({ error: 'scan_result_too_large' });
  } else parentPort.postMessage({ result: json });
})().catch(() => parentPort.postMessage({ error: 'scan_failed' }));
`;

export async function scanCode(args: Record<string, unknown>, projectRoot: string, sink: ProgressSink = {}): Promise<unknown> {
  const allowed = new Set(["directory", "frameworks", "includeTests", "timeoutMs"]);
  const bad = Object.keys(args).find(key => !allowed.has(key));
  if (bad || (args.directory !== undefined && (typeof args.directory !== "string" || !args.directory.trim() || args.directory.length > 4096 || args.directory.includes("\0"))) ||
      (args.includeTests !== undefined && typeof args.includeTests !== "boolean") ||
      (args.frameworks !== undefined && (!Array.isArray(args.frameworks) || !args.frameworks.length || args.frameworks.length > frameworks.length || args.frameworks.some(f => typeof f !== "string" || !frameworks.includes(f))))) {
    throw new FactError("invalid_arguments", "Invalid scan options. See the tool input schema.");
  }
  const timeoutMs = args.timeoutMs ?? scanCapabilities.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new FactError("invalid_arguments", "timeoutMs must be an integer between 100 and 120000.");
  }
  if (sink.signal?.aborted) throw new FactError("cancelled", "Code scan cancelled.");
  let root: string;
  try {
    const base = await realpath(projectRoot);
    root = await realpath(path.resolve(base, (args.directory as string | undefined) ?? "."));
    const relative = path.relative(base, root);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new FactError("scan_path_denied", "Scan directory must stay inside the configured project root.");
    }
    if (!(await stat(root)).isDirectory()) throw new FactError("invalid_arguments", "Scan target must be a directory.");
  } catch (error) {
    if (error instanceof FactError) throw error;
    throw new FactError("scan_path_unavailable", "The configured project directory is unavailable.");
  }
  if (active) throw new FactError("scan_busy", "Another code scan is running. Retry after it completes.");
  if (sink.signal?.aborted) throw new FactError("cancelled", "Code scan cancelled.");
  active = true;
  let worker: Worker | undefined;
  try {
    const modulePath = createRequire(typeof __filename === "string" ? __filename : import.meta.url).resolve("@powerduck/code-to-openapi");
    worker = new Worker(workerSource, {
      eval: true, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 8 },
      workerData: { modulePath, maxResultBytes: scanCapabilities.maxResultBytes, options: {
        root, frameworks: args.frameworks, includeTests: args.includeTests ?? false,
        maxFiles: scanCapabilities.maxFiles, maxFileBytes: scanCapabilities.maxFileBytes,
        maxTotalBytes: scanCapabilities.maxTotalBytes,
      } },
    });
    worker.stdout?.resume(); worker.stderr?.resume();
    const running = worker;
    return await new Promise((resolve, reject) => {
      let settled = false;
      let progress = 0;
      const finish = (error?: FactError, result?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        sink.signal?.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => finish(new FactError("cancelled", "Code scan cancelled."));
      const timer = setTimeout(() => finish(new FactError("scan_timeout", "Code scan exceeded its time limit.")), timeoutMs);
      sink.signal?.addEventListener("abort", cancel, { once: true });
      if (sink.signal?.aborted) cancel();
      running.on("message", (message: { progress?: string; error?: string; result?: string }) => {
        if (settled) return;
        if (message.progress) { try { sink.report?.(++progress, 0, message.progress); } catch { /* Progress must not fail the scan. */ } }
        else if (message.error) finish(new FactError(message.error, "Code scan could not complete. Try a smaller source directory and check source syntax."));
        else if (message.result) {
          try { finish(undefined, JSON.parse(message.result)); }
          catch { finish(new FactError("scan_failed", "Invalid code scan result.")); }
        }
      });
      running.once("error", () => finish(new FactError("scan_failed", "Code scan worker failed or exceeded its memory limit.")));
      running.once("exit", () => finish(new FactError("scan_failed", "Code scan worker exited without a result.")));
    });
  } finally {
    try { await worker?.terminate(); } finally { active = false; }
  }
}
