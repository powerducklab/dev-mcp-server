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
      headers: { "Content-Type": "application/json", "X-Request-Id": "t-1" },
      body: JSON.stringify({ name: "Rex" }),
    });
    expect(created.status).toBe(201);

    const requests = manager.requests(mock.id);
    const post = requests.find((request) => request.method === "POST");
    expect(post?.matchedRoute).toBe("POST /pets");
    expect(post?.bodyJson).toEqual({ name: "Rex" });
    expect(post?.headers["x-request-id"]).toBe("t-1");

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

  it("advertises a LAN url and answers CORS preflight and simple requests", async () => {
    const mock = await manager.start(spec);
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    if (mock.lanUrl !== null) {
      expect(mock.lanUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
    }

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
      "http://localhost:5173",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

    const simple = await fetch(`${mock.url}/v1/pets`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(simple.status).toBe(200);
    expect(simple.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
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
