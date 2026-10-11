import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MockManager, buildRoutes } from "../src/mock/server.js";
import { executeDevTool } from "../src/mcp/tools.js";
import { SpecStore } from "../src/spec/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(here, "fixtures", "petstore.yaml");
let spec: Record<string, unknown>;

beforeAll(async () => {
  const snapshot = await new SpecStore(specPath).load(true);
  spec = snapshot.document as Record<string, unknown>;
});

describe("mock route table", () => {
  it("derives the server base path and samples every HTTP operation", () => {
    const { routes, basePath } = buildRoutes(spec);
    expect(basePath).toBe("/v1");
    const list = routes.find((route) => route.method === "GET" && route.path === "/pets");
    expect(list?.status).toBe(200);
    const parsed = JSON.parse(list?.body ?? "null");
    expect(Array.isArray(parsed)).toBe(true);
    const created = routes.find((route) => route.method === "POST" && route.path === "/pets");
    expect(created?.status).toBe(201);
  });

  it("applies status, media, body, and header overrides", () => {
    const { routes } = buildRoutes(spec, {
      overrides: {
        "POST /pets": {
          status: 503,
          body: { error: "gateway unavailable" },
          headers: { "X-Downstream": "payment" },
        },
      },
    });
    const created = routes.find((route) => route.method === "POST" && route.path === "/pets");
    expect(created?.status).toBe(503);
    expect(JSON.parse(created?.body ?? "")).toEqual({ error: "gateway unavailable" });
    expect(created?.headers["X-Downstream"]).toBe("payment");
  });

  it("drops response header overrides that carry CR/LF in the value or name", () => {
    const { routes } = buildRoutes(spec, {
      overrides: {
        "POST /pets": {
          headers: {
            "X-Clean": "ok",
            "X-Inject": "1\r\nSet-Cookie: pwned=1",
            "X-Bad-Name\r\nX-Evil": "z",
          },
        },
      },
    });
    const created = routes.find((route) => route.method === "POST" && route.path === "/pets");
    expect(created?.headers["X-Clean"]).toBe("ok");
    expect(created?.headers["X-Inject"]).toBeUndefined();
    expect(Object.keys(created?.headers ?? {}).some((key) => /[\r\n]/.test(key))).toBe(false);
  });
});

describe("mock server lifecycle", () => {
  const manager = new MockManager();

  afterAll(async () => {
    await manager.stopAll();
  });

  it("serves examples, matches path parameters, and records requests", async () => {
    const mock = await manager.start(spec);
    expect(mock.basePath).toBe("/v1");
    expect(mock.routes.length).toBeGreaterThan(0);

    const list = await fetch(`${mock.url}/v1/pets`);
    expect(list.status).toBe(200);
    expect(list.headers.get("x-powerduck-mock")).toBe("examples");
    expect(Array.isArray(await list.json())).toBe(true);

    const one = await fetch(`${mock.url}/v1/pets/abc-123`);
    expect(one.status).toBe(200);

    const missing = await fetch(`${mock.url}/v1/nope`);
    expect(missing.status).toBe(404);

    const created = await fetch(`${mock.url}/v1/pets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "t-1", "Authorization": "Bearer secret", "Cookie": "sid=secret", "X-Api-Key": "secret", "X-Client-Secret": "secret" },
      body: JSON.stringify({ name: "Rex" }),
    });
    expect(created.status).toBe(201);

    const requests = manager.requests(mock.id);
    const post = requests.find((request) => request.method === "POST");
    expect(post?.matchedRoute).toBe("POST /pets");
    expect(post?.bodyJson).toEqual({ name: "Rex" });
    expect(post?.headers["x-request-id"]).toBe("t-1");
    for (const key of ["authorization", "cookie", "x-api-key", "x-client-secret"]) expect(post?.headers[key]).toBe("***");
    expect(JSON.stringify(post)).not.toContain("Bearer secret");

    const stopped = await manager.stop(mock.id);
    expect(stopped).toBe(true);
  });

  it("honors a preferred port for the first mock", async () => {
    const preferred = new MockManager({ preferredPort: 43981 });
    const mock = await preferred.start(spec);
    expect(mock.url).toBe("http://127.0.0.1:43981");
    const response = await fetch(`${mock.url}/v1/pets`);
    expect(response.status).toBe(200);
    await preferred.stopAll();
  });

  it("falls back to an ephemeral port when the preferred port is busy", async () => {
    const holder = new MockManager({ preferredPort: 43983 });
    const first = await holder.start(spec);
    expect(first.url).toBe("http://127.0.0.1:43983");

    // The preferred port is only a hint: a second manager must not fail when it
    // is already taken, but bind an ephemeral port instead.
    const other = new MockManager({ preferredPort: 43983 });
    const second = await other.start(spec);
    expect(second.url).not.toBe(first.url);
    expect(second.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${second.url}/v1/pets`);
    expect(response.status).toBe(200);

    await holder.stopAll();
    await other.stopAll();
  });

  it("still rejects a busy port that the caller requested explicitly", async () => {
    const holder = new MockManager();
    const first = await holder.start(spec, { port: 43985 });
    const other = new MockManager();
    await expect(other.start(spec, { port: 43985 })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await holder.stopAll();
  });

  it("simulates failures through overrides", async () => {
    const mock = await manager.start(spec, {
      overrides: { "POST /pets": { status: 503, body: "down" } },
    });
    const response = await fetch(`${mock.url}/v1/pets`, { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("down");
    await manager.stop(mock.id);
  });

  it("does not advertise a LAN url and answers CORS preflight and simple requests", async () => {
    const mock = await manager.start(spec);
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(mock.lanUrl).toBeNull();
    expect((manager as any).mocks.get(mock.id).server.address().address).toBe("127.0.0.1");

    const preflight = await fetch(`${mock.url}/v1/pets`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "*",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    const simple = await fetch(`${mock.url}/v1/pets`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(simple.status).toBe(200);
    expect(simple.headers.get("access-control-allow-origin")).toBe(
      "*",
    );

    const recorded = manager.requests(mock.id);
    expect(recorded.every((request) => request.method !== "OPTIONS")).toBe(true);
    await manager.stop(mock.id);
  });

  it("carries the renderer document identity through start, list and describe", async () => {
    const mock = await manager.start(spec, {
      documentId: "doc-42",
      documentName: "Checkout API.yaml",
    });
    expect(mock.documentId).toBe("doc-42");
    expect(mock.documentName).toBe("Checkout API.yaml");
    expect(
      manager.list().find((entry) => entry.id === mock.id)?.documentId,
    ).toBe("doc-42");
    await manager.stop(mock.id);
  });

  it("omits document identity fields when the caller provides none", async () => {
    const mock = await manager.start(spec);
    expect(mock.documentId).toBeUndefined();
    expect(mock.documentName).toBeUndefined();
    await manager.stop(mock.id);
  });
});

describe("mock MCP tools", () => {
  const manager = new MockManager();
  const store = new SpecStore(specPath);

  afterAll(async () => {
    await manager.stopAll();
  });

  it("starts, inspects, and stops through executeDevTool", async () => {
    const started = (await executeDevTool(
      "start_mock_server",
      {},
      store,
      {},
      manager,
    )) as { id: string; url: string; routes: Array<{ path: string }> };
    expect(started.id).toMatch(/^mock-/);
    expect(started.routes.length).toBeGreaterThan(0);

    await fetch(`${started.url}/v1/pets`);

    const recorded = (await executeDevTool(
      "get_mock_requests",
      { mockId: started.id, clear: true },
      store,
      {},
      manager,
    )) as { count: number };
    expect(recorded.count).toBe(1);

    const cleared = (await executeDevTool(
      "get_mock_requests",
      { mockId: started.id },
      store,
      {},
      manager,
    )) as { count: number };
    expect(cleared.count).toBe(0);

    const stopped = (await executeDevTool(
      "stop_mock_server",
      { mockId: started.id },
      store,
      {},
      manager,
    )) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
  });
});


describe("mock resource and recording boundaries", () => {
  it("scrubs nested JSON and query credentials before recording", async () => {
    const manager = new MockManager();
    try {
      const mock = await manager.start(spec);
      await fetch(`${mock.url}/v1/pets?access_token=query-secret&api%5Fkey=query-key&name=Rex`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "body-secret", rows: [{ clientSecret: "nested-secret", name: "Rex" }], accessToken: "camel-secret" }),
      });
      const record = manager.requests(mock.id)[0]!;
      expect(record.query).toEqual({ access_token: "***", api_key: "***", name: "Rex" });
      expect(record.bodyJson).toEqual({ password: "***", rows: [{ clientSecret: "***", name: "Rex" }], accessToken: "***" });
      expect(JSON.parse(record.body)).toEqual(record.bodyJson);
      expect(record.bodyRedacted).toBe(true);
      for (const value of ["query-secret", "query-key", "body-secret", "nested-secret", "camel-secret"]) expect(JSON.stringify(record)).not.toContain(value);
    } finally { await manager.stopAll(); }
  });

  it("scrubs form bodies and omits malformed, opaque and truncated bodies", async () => {
    const manager = new MockManager();
    try {
      const mock = await manager.start(spec);
      for (const [type, body] of [
        ["application/x-www-form-urlencoded", "password=hidden&password=hidden2&name=Rex"],
        ["application/json", '{"password":"hidden"'],
        ["text/plain", "password=hidden"],
        ["multipart/form-data; boundary=abc", "private content"],
        ["application/json", JSON.stringify({ name: "x".repeat(70 * 1024), password: "hidden" })],
      ] as const) await fetch(`${mock.url}/v1/pets`, { method: "POST", headers: { "Content-Type": type }, body });
      const records = manager.requests(mock.id);
      expect(new URLSearchParams(records[0]!.body).get("password")).toBe("***");
      expect(new URLSearchParams(records[0]!.body).get("name")).toBe("Rex");
      for (const record of records.slice(1)) { expect(record.body).toBe("***"); expect(record.bodyJson).toBeUndefined(); }
      expect(JSON.stringify(records)).not.toContain("hidden");
    } finally { await manager.stopAll(); }
  });

  it("caps simultaneous starts at eight and releases capacity after stop", async () => {
    const manager = new MockManager();
    try {
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => manager.start(spec)));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(8);
      expect(manager.list()).toHaveLength(8);
      await manager.stop(manager.list()[0]!.id);
      await manager.start(spec);
      expect(manager.list()).toHaveLength(8);
    } finally { await manager.stopAll(); }
  });

  it("stopAll includes pending starts and cancels outstanding latency timers", async () => {
    const manager = new MockManager();
    const mock = await manager.start(spec, { latencyMs: 10000 });
    const entry = (manager as any).mocks.get(mock.id);
    const response = fetch(`${mock.url}/v1/pets`).catch(() => null);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const check = () => {
        if (entry.timers.size) return resolve();
        if (Date.now() > deadline) return reject(new Error("No latency timer"));
        setTimeout(check, 5);
      };
      check();
    });
    const pending = manager.start(spec);
    await manager.stopAll();
    await pending;
    await response;
    expect(manager.list()).toEqual([]);
    expect(entry.timers.size).toBe(0);
    expect(entry.requests).toEqual([]);
  });
});

it("bounds recording bytes independently of request count and can clear the log", async () => {
  const manager = new MockManager();
  try {
    const mock = await manager.start(spec);
    for (let i = 0; i < 40; i++) await fetch(`${mock.url}/v1/pets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(60 * 1024), i }),
    });
    const records = manager.requests(mock.id);
    expect(records.length).toBeLessThan(40);
    expect(records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)), 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
    manager.requests(mock.id, { clear: true });
    expect(manager.requests(mock.id)).toEqual([]);
    await fetch(`${mock.url}/v1/pets`);
    expect(manager.requests(mock.id)).toHaveLength(1);
  } finally { await manager.stopAll(); }
});

it("notifies subscribers for lifecycle and recordings, and supports unsubscribe", async () => {
  const manager = new MockManager();
  let changes = 0;
  const unsubscribe = manager.onChanged(() => { changes++; });
  try {
    const mock = await manager.start(spec);
    expect(changes).toBe(1);
    await (await fetch(`${mock.url}/v1/pets`)).text();
    expect(changes).toBe(2);
    manager.requests(mock.id, { clear: true });
    expect(changes).toBe(3);
    await manager.stop(mock.id);
    expect(changes).toBe(4);
    unsubscribe();
    await manager.start(spec);
    expect(changes).toBe(4);
  } finally { unsubscribe(); await manager.stopAll(); }
});
