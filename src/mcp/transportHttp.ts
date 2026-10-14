/**
 * Streamable HTTP transport (MCP spec) with a shared Bearer token.
 *
 * Intended for container or remote dev environments where stdio is not
 * available. The server binds to loopback by default, sessions are stateful so
 * progress notifications stream over SSE, and every MCP request must present
 * the token. The token is generated when the caller does not supply one.
 *
 * Each MCP session owns a dedicated SDK server and Streamable HTTP transport.
 * The stateful SDK transport rejects a second `initialize` on the same
 * transport with `-32600 Server already initialized`, so sharing one transport
 * across reconnects, retries, or multiple agents breaks immediately; the
 * session map below is what keeps those handshakes isolated.
 */

import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { SpecStore } from "../spec/store.js";
import { FactError } from "../types.js";
import {
  createDevMcpServer,
  type CreateServerOptions,
} from "./createServer.js";

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_ENDPOINT = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const REALM = "powerduck-dev-mcp";
/** Hard cap on live sessions so reconnect loops cannot exhaust the process. */
const MAX_SESSIONS = 64;
/** Idle sessions are reclaimed after this long without traffic. */
const SESSION_IDLE_MS = 10 * 60 * 1000;
/** How often expired sessions are swept. */
const SWEEP_INTERVAL_MS = 30 * 1000;

export interface StartHttpOptions extends CreateServerOptions {
  specStore: SpecStore;
  port?: number;
  host?: string;
  /** MCP endpoint path; defaults to /mcp. */
  endpoint?: string;
  /** Shared Bearer token. A 24-byte random token is generated when omitted. */
  token?: string;
}

export interface HttpHandle {
  server: http.Server;
  url: string;
  endpoint: string;
  token: string;
  close: () => Promise<void>;
}

interface SessionRecord {
  id: string;
  mcp: Server;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastActivityAt: number;
  closing: boolean;
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return DEFAULT_ENDPOINT;
  const value = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (!/^\/[a-z0-9/_-]*$/i.test(value)) {
    throw new FactError(
      "invalid_arguments",
      "Endpoint must be a simple path such as /mcp.",
    );
  }
  return value;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "string" && candidate.trim() !== "") {
    return candidate.trim();
  }
  return undefined;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  sendJson(res, status, { jsonrpc: "2.0", id: null, error: { code, message } });
}

export async function startHttpServer(
  options: StartHttpOptions,
): Promise<HttpHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const endpoint = normalizeEndpoint(options.endpoint);
  const token = options.token?.trim() || generateToken();

  const { specStore, ...serverOptions } = options;
  // When the host shares a MockManager (the embedded Electron case), it owns
  // the mock lifecycle; closing one MCP session must not call stopAll on mocks
  // shared with the UI. Standalone servers let each session own its manager.
  const sharedMockManager = options.mockManager;
  const sessions = new Map<string, SessionRecord>();

  function touch(sessionId: string): void {
    const record = sessions.get(sessionId);
    if (record) record.lastActivityAt = Date.now();
  }

  async function destroySession(sessionId: string): Promise<void> {
    const record = sessions.get(sessionId);
    if (!record || record.closing) return;

    // Unregister before awaiting so a re-entrant close is a no-op.
    record.closing = true;
    sessions.delete(sessionId);

    try {
      await record.transport.close();
    } catch {
      // The socket may already be gone; teardown must still proceed.
    }
    try {
      await record.mcp.close();
    } catch {
      // Closing an already-closed server is not an error condition.
    }
  }

  /**
   * Runs a fresh initialize handshake on a dedicated server/transport pair.
   * The session is registered from the transport's `onsessioninitialized`
   * callback while the handshake is handled, so no follow-up request can race
   * an untracked session.
   */
  async function openSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    if (sessions.size >= MAX_SESSIONS) {
      sendRpcError(
        res,
        429,
        -32000,
        `Too many concurrent MCP sessions (limit ${MAX_SESSIONS}).`,
      );
      return;
    }

    const mcp = createDevMcpServer(specStore, {
      ...serverOptions,
      keepMocksOnClose: !!sharedMockManager,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string): void => {
        const now = Date.now();
        sessions.set(sessionId, {
          id: sessionId,
          mcp,
          transport,
          createdAt: now,
          lastActivityAt: now,
          closing: false,
        });
      },
      onsessionclosed: (sessionId: string): void => {
        void destroySession(sessionId);
      },
    });

    const rollback = async (): Promise<void> => {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    };

    try {
      await mcp.connect(transport as unknown as Transport);
    } catch {
      await rollback();
      if (!res.headersSent) {
        sendRpcError(res, 500, -32603, "Failed to initialize the MCP session.");
      }
      return;
    }

    try {
      // The initialize response (including the Mcp-Session-Id header) is written
      // here by the SDK; nothing else may touch the response afterwards.
      await transport.handleRequest(req, res, parsedBody);
    } catch {
      if (transport.sessionId && sessions.has(transport.sessionId)) {
        await destroySession(transport.sessionId);
      } else {
        await rollback();
      }
      if (!res.headersSent) {
        sendRpcError(
          res,
          500,
          -32603,
          "Failed to handle the initialize request.",
        );
      }
      return;
    }

    // No session id means the SDK rejected the payload and already answered;
    // release the server instead of leaking it.
    if (!transport.sessionId) {
      await rollback();
    }
  }

  /**
   * Reads and JSON-parses a POST body. Returns `undefined` for an empty body.
   * Writes the response and returns `null` when the request is malformed.
   */
  function readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) {
          chunks.push(chunk);
        } else {
          tooLarge = true;
        }
      });
      req.on("end", () => {
        if (tooLarge) {
          sendJson(res, 413, { error: "payload_too_large" });
          resolve(null);
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve(undefined);
          return;
        }
        if (!/^application\/json/i.test(req.headers["content-type"] ?? "")) {
          sendJson(res, 415, { error: "unsupported_media_type" });
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          sendJson(res, 400, { error: "invalid_json" });
          resolve(null);
        }
      });
      req.on("error", () => {
        if (!res.headersSent) sendJson(res, 400, { error: "bad_request" });
        resolve(null);
      });
    });
  }

  async function dispatch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sessionId = readHeader(
      req.headers["mcp-session-id"] as string | string[] | undefined,
    );

    if (req.method === "POST") {
      const parsedBody = await readJsonBody(req, res);
      if (parsedBody === null && res.headersSent) return;
      if (parsedBody === null) return;

      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record || record.closing) {
          sendRpcError(res, 404, -32001, "Unknown or expired MCP session.");
          return;
        }
        touch(sessionId);
        await record.transport.handleRequest(req, res, parsedBody);
        touch(sessionId);
        return;
      }

      // A POST without a session id is only accepted to open a new session.
      if (!isInitializeRequest(parsedBody)) {
        sendRpcError(
          res,
          400,
          -32000,
          "Missing mcp-session-id header and the payload is not an initialize request. The session may have expired; re-initialize before retrying.",
        );
        return;
      }

      await openSession(req, res, parsedBody);
      return;
    }

    // GET (SSE channel) and DELETE (session termination) require a live session.
    if (!sessionId) {
      sendRpcError(
        res,
        400,
        -32000,
        "Missing mcp-session-id header. Send an initialize request over POST first.",
      );
      return;
    }
    const record = sessions.get(sessionId);
    if (!record || record.closing) {
      sendRpcError(res, 404, -32001, "Unknown or expired MCP session.");
      return;
    }
    touch(sessionId);
    // DELETE fires the transport's onsessionclosed hook, which destroys the
    // session; GET simply serves the SSE channel.
    await record.transport.handleRequest(req, res);
  }

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: "invalid_request_target" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (url.pathname !== endpoint) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (
      req.method !== "POST" &&
      req.method !== "GET" &&
      req.method !== "DELETE"
    ) {
      res.writeHead(405, { Allow: "POST, GET, DELETE" });
      res.end();
      return;
    }

    const authorization = req.headers.authorization ?? "";
    const [scheme, provided] = authorization.split(" ");
    if (scheme !== "Bearer" || !provided || !tokenMatches(provided, token)) {
      sendJson(
        res,
        401,
        { error: "unauthorized" },
        { "WWW-Authenticate": `Bearer realm="${REALM}"` },
      );
      return;
    }

    void dispatch(req, res).catch(() => {
      if (!res.headersSent) {
        sendRpcError(
          res,
          500,
          -32603,
          "Internal error while handling the MCP request.",
        );
      } else {
        res.end();
      }
    });
  });

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const record of [...sessions.values()]) {
      if (record.lastActivityAt < cutoff) {
        void destroySession(record.id);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    clearInterval(sweeper);
    server.close();
    throw new FactError("internal_error", "HTTP server failed to bind.");
  }
  const url = `http://${host}:${address.port}`;

  const close = async (): Promise<void> => {
    clearInterval(sweeper);
    await Promise.allSettled(
      [...sessions.keys()].map((sessionId) => destroySession(sessionId)),
    );
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, url, endpoint, token, close };
}
