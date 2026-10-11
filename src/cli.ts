import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import { loadDevConfig, resolveFrom } from "./config/index.js";
import { startStdioServer } from "./mcp/transportStdio.js";
import { startHttpServer } from "./mcp/transportHttp.js";
import { SpecStore } from "./spec/store.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
) as { version: string };

interface CommonOptions {
  spec?: string;
  config?: string;
  baseUrl?: string;
  allowHosts?: string;
  project?: string;
  mockPort?: string;
}

interface HttpOptions extends CommonOptions {
  port?: string;
  host?: string;
  endpoint?: string;
  token?: string;
}

function optionalPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("Port must be an integer between 0 and 65535.");
  }
  return parsed;
}

function resolveSpec(options: CommonOptions, configDir: string): string {
  const { config } = loadDevConfig(options.config);
  const specPath = resolveFrom(configDir, options.spec ?? config.spec);
  if (!specPath) {
    throw new Error(
      'Provide the OpenAPI document with --spec or a "spec" field in powerduck.dev.json.',
    );
  }
  return specPath;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("powerduck-dev-mcp")
    .description(
      "Developer MCP server: accurate OpenAPI facts, verification, mocks, and scenarios.",
    )
    .version(pkg.version)
    .option("--spec <path>", "Path to the OpenAPI document (JSON or YAML).")
    .option("--config <path>", "Path to a powerduck.dev.json file.")
    .option("--base-url <url>", "Default local backend base URL.")
    .option("--allow-hosts <hosts>", "Explicit comma-separated backend IP allowlist (DNS targets are not supported).")
    .option("--project <dir>", "Backend project root.")
    .option("--mock-port <number>", "Preferred port for the first mock server.")
    .action(async (options: CommonOptions) => {
      const { configDir, config } = loadDevConfig(options.config);
      const specPath = resolveSpec(options, configDir);
      const mockPort = optionalPort(options.mockPort);
      await startStdioServer({
        specPath,
        ...(options.baseUrl ?? config.baseUrl ? { defaultBaseUrl: options.baseUrl ?? config.baseUrl } : {}),
        allowHosts: options.allowHosts?.split(',').map(host => host.trim()).filter(Boolean) ?? config.allowHosts ?? [],
        ...(mockPort !== undefined ? { mockPort } : {}),
      });
    });

  program
    .command("http")
    .description("Serve over MCP Streamable HTTP with a Bearer token.")
    .option("--port <number>", "TCP port (default 3333, 0 for ephemeral).")
    .option("--host <host>", "Bind host (default 127.0.0.1).")
    .option("--endpoint <path>", "MCP endpoint path (default /mcp).")
    .option("--token <token>", "Shared Bearer token; generated when omitted.")
    .option("--mock-port <number>", "Preferred port for the first mock server.")
    .action(async (subOptions: HttpOptions, command: Command) => {
      const options = {
        ...(command.parent?.opts() as CommonOptions),
        ...subOptions,
      } as HttpOptions;
      const { configDir, config } = loadDevConfig(options.config);
      const specPath = resolveSpec(options, configDir);
      const mockPort = optionalPort(options.mockPort);
      const handle = await startHttpServer({
        specStore: new SpecStore(specPath),
        ...(options.baseUrl ?? config.baseUrl ? { defaultBaseUrl: options.baseUrl ?? config.baseUrl } : {}),
        allowHosts: options.allowHosts?.split(',').map(host => host.trim()).filter(Boolean) ?? config.allowHosts ?? [],
        ...(options.port !== undefined ? { port: Number(options.port) } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.token ? { token: options.token } : {}),
        ...(mockPort !== undefined ? { mockPort } : {}),
      });
      const shutdown = async (): Promise<void> => {
        await handle.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      console.error(
        `[powerduck-dev-mcp] Streamable HTTP listening on ${handle.url}${handle.endpoint}`,
      );
      console.error(`[powerduck-dev-mcp] Bearer token: ${handle.token}`);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(
    "[powerduck-dev-mcp]",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
