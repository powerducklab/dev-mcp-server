/**
 * stdio transport for AI coding clients (Claude Code, Codex CLI, Cursor,
 * Claude Desktop). stdout is the JSON-RPC channel, so all accidental logging
 * is diverted to stderr for the lifetime of the server.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SpecStore } from "../spec/store.js";
import { createDevMcpServer } from "./createServer.js";

export interface StdioHandle {
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface StartStdioOptions {
  specPath: string;
  name?: string;
  version?: string;
  handleSignals?: boolean;
  mockPort?: number;
}

function divertConsoleToStderr(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    dir: console.dir,
  };
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = toStderr as typeof console.dir;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.dir = original.dir;
  };
}

export async function startStdioServer(
  options: StartStdioOptions,
): Promise<StdioHandle> {
  const restoreConsole = divertConsoleToStderr();
  const store = new SpecStore(options.specPath);
  const server = createDevMcpServer(store, {
    ...(options.name ? { name: options.name } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(typeof options.mockPort === "number" ? { mockPort: options.mockPort } : {}),
  });
  const transport = new StdioServerTransport();

  let settleClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });
  let shuttingDown = false;
  const detachSignals: Array<() => void> = [];

  const finish = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const detach of detachSignals) detach();
    restoreConsole();
    settleClosed();
  };

  transport.onerror = (error: Error): void => {
    console.error("[dev-mcp:stdio] transport error:", error);
  };
  transport.onclose = (): void => finish();

  await server.connect(transport);

  if (options.handleSignals !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        void server.close().catch(() => {
          /* already closing */
        });
      };
      process.once(signal, handler);
      detachSignals.push(() => process.removeListener(signal, handler));
    }
  }

  return {
    closed,
    close: async () => {
      try {
        await server.close();
      } finally {
        finish();
      }
    },
  };
}
