import http from "node:http";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { codeScanTools, scanCode } from "../code-scan/run.js";
import { FactError } from "../types.js";
import type { ProgressSink } from "../verify/config.js";
import { cloudHandoff, type CloudLink } from "./cloud.js";

export const publicationTools: Tool[] = [
  {
    name: "publish_code_docs",
    description:
      "Scan project source and return a browsable API documentation URL rendered by Powerduck. Default target local: loopback-only preview, available until this MCP session closes; repeated calls update the same project URL. target cloud: returns an authorizationUrl for the user to open and confirm publication in Powerduck Cloud; then call get_code_docs_status for the public URL. Never claim a pending Cloud publication is published. Review scan diagnostics for incomplete inferred contracts. Does not execute project code or save source files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...codeScanTools[1]!.inputSchema.properties,
        target: { type: "string", enum: ["local", "cloud"], default: "local" },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "get_code_docs_status",
    description:
      "Get the documentation URL or pending authorization state for a publication created in this MCP session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["publicationId"],
      properties: { publicationId: { type: "string" } },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];
interface Publication {
  id: string;
  key: string;
  target: string;
  status: string;
  text: string;
  report: unknown;
  diagnostics: unknown;
  url?: string;
  authorizationUrl?: string;
  error?: string;
  link?: CloudLink;
  close?: () => void;
}
const html =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Powerduck API</title><link rel="icon" href="data:,"><link rel="stylesheet" href="./viewer.css"></head><body><div id="root"></div><script src="./viewer.js" defer></script></body></html>';
/** Owns bounded previews and pending authorizations for one MCP session. */
export class PublicationManager {
  private publications = new Map<string, Publication>();
  private server: http.Server | undefined;
  private starting: Promise<void> | undefined;
  private address = "";
  private closed = false;
  private busy = false;
  private assets: Map<string, Buffer> | undefined;
  private compressedAssets: Map<string, Buffer> | undefined;
  constructor(private assetDirectory?: string) {}
  private snapshot(p: Publication) {
    return {
      publicationId: p.id,
      target: p.target,
      status: p.status,
      ...(p.url ? { url: p.url } : {}),
      ...(p.authorizationUrl ? { authorizationUrl: p.authorizationUrl } : {}),
      ...(p.error ? { error: p.error } : {}),
      report: p.report,
      diagnostics: p.diagnostics,
    };
  }
  status(args: Record<string, unknown>) {
    if (
      Object.keys(args).some((k) => k !== "publicationId") ||
      typeof args.publicationId !== "string"
    )
      throw new FactError("invalid_arguments", "publicationId is required.");
    const p = this.publications.get(args.publicationId);
    if (!p)
      throw new FactError(
        "publication_not_found",
        "Publication does not exist in this MCP session.",
      );
    return this.snapshot(p);
  }
  async publish(
    args: Record<string, unknown>,
    root: string,
    sink: ProgressSink = {},
  ) {
    if (this.closed)
      throw new FactError("publication_closed", "MCP session is closed.");
    if (this.busy)
      throw new FactError(
        "publication_busy",
        "Another publication is being prepared. Retry after it completes.",
      );
    const { target = "local", ...scanArgs } = args;
    if (target !== "local" && target !== "cloud")
      throw new FactError(
        "invalid_arguments",
        "target must be local or cloud.",
      );
    this.busy = true;
    try {
      const result = (await scanCode(scanArgs, root, sink)) as {
        document: Record<string, unknown>;
        documentValid: boolean;
        report: unknown;
        diagnostics: unknown;
      };
      if (!result.documentValid)
        throw new FactError(
          "invalid_generated_document",
          "Generated OpenAPI is invalid; inspect scan_code_to_openapi diagnostics before publishing.",
          result.diagnostics,
        );
      if (this.closed || sink.signal?.aborted)
        throw new FactError("cancelled", "Publication cancelled.");
      const key = `${target}:${await realpath(path.resolve(root, (scanArgs.directory as string | undefined) ?? "."))}`;
      let p = [...this.publications.values()].find((item) => item.key === key);
      if (!p && this.publications.size >= 16)
        throw new FactError(
          "publication_limit",
          "This MCP session already has 16 publications. Reconnect to release them.",
        );
      if (p?.status === "awaiting_authorization") return this.snapshot(p);
      const text = JSON.stringify(result.document);
      if (target === "local") await this.start();
      if (this.closed || sink.signal?.aborted)
        throw new FactError("cancelled", "Publication cancelled.");
      p ??= {
        id: randomBytes(24).toString("hex"),
        key,
        target,
        status: "preparing",
        text: "",
        report: null,
        diagnostics: null,
      };
      const publication = p;
      publication.text = text;
      publication.report = result.report;
      publication.diagnostics = result.diagnostics;
      delete publication.error;
      if (target === "local") {
        publication.status = "published";
        publication.url = `http://${this.address}/docs/${p.id}/`;
      } else {
        const handoff = await cloudHandoff(
          { name: "Source API", text, ...(p.link ? { existing: p.link } : {}) },
          async (link) => {
            publication.link = link;
            publication.url = `https://www.powerduck.com/view/docs/${encodeURIComponent(link.publicToken!)}`;
            publication.status = "published";
            delete publication.authorizationUrl;
          },
          (error) => {
            publication.status = "failed";
            publication.error = error.message;
            delete publication.authorizationUrl;
          },
        );
        if (this.closed || sink.signal?.aborted) {
          handoff.close();
          throw new FactError("cancelled", "Publication cancelled.");
        }
        publication.close = handoff.close;
        publication.authorizationUrl = handoff.authorizationUrl;
        publication.status = "awaiting_authorization";
      }
      this.publications.set(p.id, p);
      return this.snapshot(p);
    } finally {
      this.busy = false;
    }
  }
  private async start() {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.listen();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async listen() {
    const require = createRequire(
      typeof __filename === "string" ? __filename : import.meta.url,
    );
    const dir =
      this.assetDirectory ??
      path.join(
        path.dirname(require.resolve("@powerduck/dev-mcp-server/package.json")),
        "dist/viewer",
      );
    this.assets = new Map(
      await Promise.all(
        ["viewer.js", "viewer.css"].map(
          async (name) => [name, await readFile(path.join(dir, name))] as const,
        ),
      ),
    );
    this.compressedAssets = new Map(
      await Promise.all(
        ["viewer.js", "viewer.css"].map(
          async (name) =>
            [name, await readFile(path.join(dir, `${name}.gz`))] as const,
        ),
      ),
    );
    if (this.closed)
      throw new FactError("publication_closed", "MCP session is closed.");
    const server = http.createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      // The bundled OpenAPI validator compiles JSON Schema with Ajv.
      // Allow its code generation, but never inline or remote scripts.
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-eval'; font-src 'self' data:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      if (
        req.headers.host !== this.address ||
        (req.headers.origin && req.headers.origin !== `http://${this.address}`)
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const match =
        /^\/docs\/([a-f0-9]{48})\/(viewer\.js|viewer\.css|oas\.json)?$/.exec(
          req.url ?? "",
        );
      const p = match ? this.publications.get(match[1]!) : undefined;
      if (!p || p.target !== "local") {
        res.writeHead(404).end();
        return;
      }
      const name = match![2];
      let body =
        name === "oas.json" ? p.text : name ? this.assets!.get(name) : html;
      if (name === "viewer.js" || name === "viewer.css") {
        res.setHeader("Cache-Control", "private, max-age=86400");
        res.setHeader("Vary", "Accept-Encoding");
        if (/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
          res.setHeader("Content-Encoding", "gzip");
          body = this.compressedAssets!.get(name);
        }
      }
      res.setHeader(
        "Content-Type",
        name === "oas.json"
          ? "application/json"
          : name === "viewer.js"
            ? "text/javascript"
            : name === "viewer.css"
              ? "text/css"
              : "text/html; charset=utf-8",
      );
      res.end(req.method === "HEAD" ? undefined : body);
    });
    server.maxConnections = 32;
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (this.closed) {
      server.close();
      throw new FactError("publication_closed", "MCP session is closed.");
    }
    this.address = `127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    this.server = server;
  }
  close() {
    this.closed = true;
    for (const p of this.publications.values()) p.close?.();
    this.publications.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.assets = undefined;
    this.compressedAssets = undefined;
  }
}
