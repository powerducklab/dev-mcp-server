/**
 * Local HTTP mock server for dependencies that are not ready yet (third-party
 * payment gateways, OTP providers, downstream services).
 *
 * The mock is deliberately conservative:
 * - listens on all interfaces (127.0.0.1 plus the LAN IP) and never executes
 *   scripts or fetches remote refs;
 * - answers CORS preflights and allows cross-origin callers;
 * - responds with spec examples or schema-derived samples;
 * - records incoming requests so an agent can assert what the implementation
 *   actually sent (for example a payment callback payload).
 */

import http from "node:http";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { sampleFromSchema } from "@powerduck/openapi-request";

type AnyObj = Record<string, unknown>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const MAX_SPEC_JSON = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECORDED_REQUESTS = 200;
const MAX_LATENCY_MS = 10_000;

export interface MockRoute {
  method: string;
  /** OpenAPI path template, e.g. "/pets/{petId}". */
  path: string;
  parts: string[];
  status: number;
  media: string;
  body: string;
  headers: Record<string, string>;
}

export interface MockResponseOverride {
  /** HTTP status code, e.g. 503 to simulate an unavailable dependency. */
  status?: number;
  /** Override response content type. */
  media?: string;
  /** Object is serialized as JSON; a string is sent as-is. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockOptions {
  /** Preferred port; defaults to an ephemeral port. */
  port?: number;
  /** Prefix every route is mounted under. Defaults to the first server base path. */
  basePath?: string;
  /** Artificial delay in milliseconds for every response. */
  latencyMs?: number;
  /** Overrides keyed by "METHOD /path", e.g. "POST /payments/charge". */
  overrides?: Record<string, MockResponseOverride>;
  /** Renderer document id this mock belongs to; enables per-document routing. */
  documentId?: string;
  /** Human-readable document name shown alongside the document id. */
  documentName?: string;
}

export interface RecordedRequest {
  timestamp: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  bodyJson?: unknown;
  matchedRoute: string | null;
}

export interface MockInstance {
  id: string;
  url: string;
  /** Same server reachable through the first non-internal LAN IPv4, if any. */
  lanUrl: string | null;
  basePath: string;
  routes: Array<{ method: string; path: string; status: number }>;
  requestCount: number;
  /** Renderer document id this mock serves, when the caller provided one. */
  documentId?: string;
  /** Renderer document name this mock serves, when the caller provided one. */
  documentName?: string;
}

interface RunningMock {
  id: string;
  server: http.Server;
  url: string;
  lanUrl: string | null;
  basePath: string;
  documentId?: string;
  documentName?: string;
  routeTable: MockRoute[];
  routes: Array<{ method: string; path: string; status: number }>;
  requests: RecordedRequest[];
}

/** Inlines local $ref values with cycle, depth, and budget guards. */
function resolveLocalSchema(
  value: unknown,
  spec: AnyObj,
  refs: Set<string> = new Set(),
  depth = 0,
  budget = { remaining: 5000 },
): unknown {
  budget.remaining -= 1;
  if (budget.remaining < 0) return {};
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => resolveLocalSchema(item, spec, refs, depth + 1, budget));
  }
  const record = value as AnyObj;
  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    if (!ref.startsWith("#/") || refs.has(ref)) return {};
    let target: unknown = spec;
    for (const segment of ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (target === null || typeof target !== "object") return {};
      target = (target as AnyObj)[segment];
    }
    return resolveLocalSchema(
      target,
      spec,
      new Set([...refs, ref]),
      depth + 1,
      budget,
    );
  }
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 200)
      .filter(([key]) => !["__proto__", "constructor", "prototype"].includes(key))
      .map(([key, item]) => [
        key,
        resolveLocalSchema(item, spec, refs, depth + 1, budget),
      ]),
  );
}

function firstServerBasePath(spec: AnyObj): string {
  const servers = spec.servers;
  if (!Array.isArray(servers)) return "";
  for (const server of servers) {
    if (server && typeof server === "object") {
      const url = (server as AnyObj).url;
      if (typeof url === "string" && !url.includes("{") && /^https?:\/\//.test(url)) {
        try {
          const pathname = new URL(url).pathname.replace(/\/$/, "");
          if (pathname && pathname !== "/") return pathname;
        } catch {
          // Ignore malformed server URLs.
        }
      }
    }
  }
  return "";
}

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath) return "";
  let value = basePath.trim();
  if (!value) return "";
  if (!value.startsWith("/")) value = `/${value}`;
  return value.replace(/\/$/, "");
}

function overrideKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function serializeBody(media: string, example: unknown): string {
  if (typeof example === "string") return example;
  return JSON.stringify(example);
}

/** Builds the route table from the specification and optional overrides. */
export function buildRoutes(spec: AnyObj, options: MockOptions = {}): {
  routes: MockRoute[];
  basePath: string;
} {
  if (!spec || typeof spec !== "object" || !spec.paths) {
    throw new Error("An OpenAPI document with paths is required.");
  }
  if (JSON.stringify(spec).length > MAX_SPEC_JSON) {
    throw new Error("Mock specification exceeds 2 MB.");
  }
  const basePath = normalizeBasePath(
    options.basePath !== undefined ? options.basePath : firstServerBasePath(spec),
  );
  const overrides = options.overrides ?? {};
  const paths = spec.paths as Record<string, AnyObj>;
  const routes: MockRoute[] = [];

  for (const [urlPath, item] of Object.entries(paths)) {
    if (!urlPath.startsWith("/") || !item || typeof item !== "object") continue;
    for (const [rawMethod, operation] of Object.entries(item)) {
      const method = rawMethod.toLowerCase();
      if (!HTTP_METHODS.includes(method) || !operation || typeof operation !== "object") {
        continue;
      }
      const op = operation as AnyObj;
      if (op["x-protocol"] && op["x-protocol"] !== "http") continue;
      const responses = (op.responses ?? {}) as Record<string, AnyObj>;
      const [statusText, rawResponse] =
        Object.entries(responses).find(([status]) => /^2\d\d$/.test(status)) ??
        Object.entries(responses).find(([status]) => /^[1-5]\d\d$/.test(status)) ??
        ["200", {}];
      const response = resolveLocalSchema(rawResponse, spec) as AnyObj;
      const content = (response.content ?? {}) as Record<string, AnyObj>;
      const [media, mediaEntry] = Object.entries(content)[0] ?? [
        "application/json",
        {},
      ];
      if (/[\r\n]/.test(media)) throw new Error("Invalid mock response content type.");
      if (/event-stream|ndjson|json-seq/i.test(media)) continue;

      let status = Number(statusText);
      let finalMedia = media;
      const override = overrides[overrideKey(method, urlPath)];
      const example = pickExample(mediaEntry, spec);
      let body = serializeBody(media, example);
      const extraHeaders: Record<string, string> = {};
      if (override) {
        if (typeof override.status === "number") status = override.status;
        if (typeof override.media === "string") finalMedia = override.media;
        if (override.body !== undefined) {
          body =
            typeof override.body === "string"
              ? override.body
              : JSON.stringify(override.body);
        }
        if (override.headers && typeof override.headers === "object") {
          for (const [key, value] of Object.entries(override.headers)) {
            // Header injection guard: CR/LF must be rejected in BOTH the name
            // and the value. The value is the actual injection point, so a
            // tainted value is dropped even when the name is clean.
            if (
              typeof value === "string" &&
              !/[\r\n]/.test(key) &&
              !/[\r\n]/.test(value)
            ) {
              extraHeaders[key] = value;
            }
          }
        }
      }
      if (Buffer.byteLength(body) > 1024 * 1024) {
        throw new Error(`Mock example for ${method.toUpperCase()} ${urlPath} exceeds 1 MB.`);
      }
      routes.push({
        method: method.toUpperCase(),
        path: urlPath,
        parts: urlPath.split("/"),
        status,
        media: finalMedia,
        body,
        headers: extraHeaders,
      });
    }
  }
  if (routes.length === 0) throw new Error("No HTTP operations to mock.");
  return { routes, basePath };
}

function pickExample(mediaEntry: AnyObj, spec?: AnyObj): unknown {
  const content = resolveLocalSchema(mediaEntry, spec ?? {}) as AnyObj;
  if (content.example !== undefined) return content.example;
  const examples = content.examples as Record<string, AnyObj> | undefined;
  const firstExample = examples
    ? Object.values(examples).find((value) => value && "value" in value)
    : undefined;
  if (firstExample && firstExample.value !== undefined) return firstExample.value;
  const schema = (content.schema ?? null) as AnyObj | null;
  if (schema?.default !== undefined) return schema.default;
  if (schema?.example !== undefined) return schema.example;
  if (schema) {
    return sampleFromSchema(resolveLocalSchema(schema, spec ?? {}) as never, 0, {
      includeReadOnly: true,
      includeWriteOnly: false,
    });
  }
  return {};
}

function matchRoute(
  routes: MockRoute[],
  method: string,
  parts: string[],
): MockRoute | null {
  return (
    routes.find(
      (route) =>
        route.method === method &&
        route.parts.length === parts.length &&
        route.parts.every((segment, index) => {
          if (/^\{[^}]+\}$/.test(segment)) return true;
          return segment === parts[index];
        }),
    ) ?? null
  );
}

const RECORDED_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "user-agent",
  "x-request-id",
  "idempotency-key",
]);

function createMockHandler(
  routes: MockRoute[],
  basePath: string,
  latencyMs: number,
  requests: RecordedRequest[],
): http.RequestListener {
  return (req, res) => {
    const cors = corsHeaders(req);
    const send = (statusCode: number, headers: http.OutgoingHttpHeaders, chunk?: string) => {
      setTimeout(() => {
        // The server may have been stopped (and the socket destroyed) while an
        // artificial latency was still pending. Never write to a finished or
        // destroyed response, and never let a late timer raise an uncaught error.
        if (res.writableEnded || res.destroyed) return;
        try {
          res.writeHead(statusCode, { ...cors, ...headers });
          res.end(req.method === "HEAD" || statusCode === 204 ? undefined : chunk);
        } catch {
          res.destroy();
        }
      }, latencyMs);
    };

    // Answer CORS preflights immediately and do not record them as traffic.
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let truncated = false;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes <= MAX_BODY_BYTES) chunks.push(chunk);
      else truncated = true;
    });
    req.on("end", () => {
      const absolute = new URL(req.url ?? "/", "http://127.0.0.1");
      let pathname = absolute.pathname;
      if (basePath && pathname.startsWith(basePath)) {
        pathname = pathname.slice(basePath.length) || "/";
      }
      const parts = pathname.split("/");
      const route = matchRoute(routes, req.method ?? "GET", parts);

      const headerMap: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (RECORDED_HEADERS.has(key) || key.startsWith("x-")) {
          headerMap[key] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
        }
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = truncated ? `${rawBody}\n…[truncated]` : rawBody;
      const recorded: RecordedRequest = {
        timestamp: new Date().toISOString(),
        method: req.method ?? "GET",
        path: pathname,
        query: Object.fromEntries(absolute.searchParams.entries()),
        headers: headerMap,
        body,
        matchedRoute: route ? `${route.method} ${route.path}` : null,
      };
      if (
        body &&
        /json/i.test(headerMap["content-type"] ?? "")
      ) {
        try {
          recorded.bodyJson = JSON.parse(body);
        } catch {
          // Keep the raw body when it is not valid JSON.
        }
      }
      requests.push(recorded);
      if (requests.length > MAX_RECORDED_REQUESTS) {
        requests.splice(0, requests.length - MAX_RECORDED_REQUESTS);
      }

      if (!route) {
        send(
          404,
          { "Content-Type": "application/json", "X-Powerduck-Mock": "no-match" },
          JSON.stringify({ error: "No matching mock operation" }),
        );
        return;
      }
      send(
        route.status,
        {
          "Content-Type": route.media,
          "X-Powerduck-Mock": "examples",
          ...route.headers,
          ...(route.status === 204 ? {} : { "Content-Length": Buffer.byteLength(route.body) }),
        },
        route.body,
      );
    });
    req.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid mock request" }));
      }
    });
  };
}

export interface MockManagerOptions {
  /**
   * Port used for the first mock when the tool call does not specify one.
   * Later mocks always use ephemeral ports to avoid collisions.
   */
  preferredPort?: number;
}

/** Owns the lifecycle of local mock servers for one MCP server instance. */
export class MockManager {
  private readonly mocks = new Map<string, RunningMock>();
  private preferredPort: number | undefined;

  constructor(options: MockManagerOptions = {}) {
    if (typeof options.preferredPort === "number" && options.preferredPort > 0) {
      this.preferredPort = Math.trunc(options.preferredPort);
    }
  }

  async start(spec: AnyObj, options: MockOptions = {}): Promise<MockInstance> {
    const { routes, basePath } = buildRoutes(spec, options);
    const latencyMs = Math.max(
      0,
      Math.min(MAX_LATENCY_MS, Math.trunc(options.latencyMs ?? 0)),
    );
    const requests: RecordedRequest[] = [];
    const server = http.createServer(
      createMockHandler(routes, basePath, latencyMs, requests),
    );
    const id = `mock-${randomUUID()}`;
    const explicitPort =
      typeof options.port === "number" && options.port > 0
        ? Math.trunc(options.port)
        : null;
    let chosenPort = explicitPort;
    if (
      chosenPort === null &&
      this.preferredPort !== undefined &&
      this.mocks.size === 0
    ) {
      // The preferred port is a hint consumed by the first mock, not a hard
      // requirement; a bind collision on it falls back to an ephemeral port.
      chosenPort = this.preferredPort;
      this.preferredPort = undefined;
    }

    await new Promise<void>((resolve, reject) => {
      // An explicitly requested port honors the caller's intent and must
      // surface a bind failure; a hinted/ephemeral port may retry on port 0.
      const canFallback = explicitPort === null;
      let fallbackAttempted = false;
      server.on("error", (error: { code?: string }) => {
        const bindError =
          error.code === "EADDRINUSE" || error.code === "EACCES";
        if (canFallback && bindError && !fallbackAttempted) {
          fallbackAttempted = true;
          server.listen(0, "0.0.0.0", resolve);
          return;
        }
        reject(error);
      });
      server.listen(chosenPort ?? 0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.closeServer(server);
      throw new Error("Mock server failed to bind a port.");
    }
    const lanIp = findLanIpv4();
    const documentId =
      typeof options.documentId === "string" && options.documentId.trim()
        ? options.documentId.trim().slice(0, 200)
        : undefined;
    const documentName =
      typeof options.documentName === "string" && options.documentName.trim()
        ? options.documentName.trim().slice(0, 200)
        : undefined;
    const running: RunningMock = {
      id,
      server,
      url: `http://127.0.0.1:${address.port}`,
      lanUrl: lanIp ? `http://${lanIp}:${address.port}` : null,
      ...(documentId ? { documentId } : {}),
      ...(documentName ? { documentName } : {}),
      basePath,
      routeTable: routes,
      routes: routes.map((route) => ({
        method: route.method,
        path: route.path,
        status: route.status,
      })),
      requests,
    };
    this.mocks.set(id, running);
    return this.describe(running);
  }

  async stop(id: string): Promise<boolean> {
    const entry = this.mocks.get(id);
    if (!entry) return false;
    this.mocks.delete(id);
    await this.closeServer(entry.server);
    return true;
  }

  async stopAll(): Promise<void> {
    const entries = [...this.mocks.values()];
    this.mocks.clear();
    await Promise.all(entries.map((entry) => this.closeServer(entry.server)));
  }

  list(): MockInstance[] {
    return [...this.mocks.values()].map((entry) => this.describe(entry));
  }

  requests(
    id: string,
    options: { limit?: number; clear?: boolean } = {},
  ): RecordedRequest[] {
    const entry = this.mocks.get(id);
    if (!entry) throw new Error(`Unknown mock server: ${id}`);
    const limit =
      typeof options.limit === "number"
        ? Math.max(1, Math.min(MAX_RECORDED_REQUESTS, Math.trunc(options.limit)))
        : MAX_RECORDED_REQUESTS;
    const slice = entry.requests.slice(-limit);
    if (options.clear) entry.requests.length = 0;
    return slice;
  }

  private describe(entry: RunningMock): MockInstance {
    return {
      id: entry.id,
      url: entry.url,
      lanUrl: entry.lanUrl,
      basePath: entry.basePath,
      routes: entry.routes,
      requestCount: entry.requests.length,
      ...(entry.documentId ? { documentId: entry.documentId } : {}),
      ...(entry.documentName ? { documentName: entry.documentName } : {}),
    };
  }

  private async closeServer(server: http.Server): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}


/** Permissive CORS headers so browser-based clients can call the mock directly. */
function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const requested = req.headers["access-control-request-headers"];
  return {
    "Access-Control-Allow-Origin":
      typeof req.headers.origin === "string" ? req.headers.origin : "*",
    "Access-Control-Allow-Methods":
      "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      typeof requested === "string" && requested.trim()
        ? requested
        : "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** First routable LAN IPv4 address, used to advertise the mock on the network. */
function findLanIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return null;
}
