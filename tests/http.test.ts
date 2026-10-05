import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SpecStore } from "../src/spec/store.js";
import { startHttpServer, type HttpHandle } from "../src/mcp/transportHttp.js";
import { devTools } from "../src/mcp/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(here, "fixtures", "petstore.yaml");
const TOKEN = "test-secret-token";

let handle: HttpHandle;

beforeAll(async () => {
  handle = await startHttpServer({
    specStore: new SpecStore(specPath),
    port: 0,
    token: TOKEN,
  });
});

afterAll(async () => {
  await handle.close();
});

describe("streamable http transport", () => {
  it("serves an unauthenticated health probe", async () => {
    const response = await fetch(`${handle.url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("rejects requests outside the endpoint", async () => {
    const response = await fetch(`${handle.url}/other`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it("requires a bearer token", async () => {
    const noToken = await fetch(`${handle.url}${handle.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toContain("Bearer");

    const badToken = await fetch(`${handle.url}${handle.endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(badToken.status).toBe(401);
  });

  it("completes an MCP handshake and lists every registered tool", async () => {
    const client = new Client(
      { name: "http-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${handle.url}${handle.endpoint}`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
    );
    await client.connect(transport as unknown as Transport);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(devTools.length);

    const overview = await client.callTool({ name: "spec_overview", arguments: {} });
    const firstContent = (overview.content as Array<{ type: string }> | undefined)?.[0];
    expect(firstContent?.type).toBe("text");

    await client.close();
  });

  it("lets a second independent client complete its own handshake", async () => {
    // Regression: the server used one shared transport, so a reconnect, retry,
    // or a second agent re-sending initialize got "-32600 Server already
    // initialized". Each session must be isolated.
    const connect = async (name: string) => {
      const client = new Client(
        { name, version: "0.0.0" },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}${handle.endpoint}`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
      );
      await client.connect(transport as unknown as Transport);
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      return client;
    };

    const first = await connect("http-test-client-a");
    const second = await connect("http-test-client-b");

    await first.close();
    await second.close();
  });

  it("rejects a non-initialize POST without a session id", async () => {
    const response = await fetch(`${handle.url}${handle.endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error?: { code?: number };
    };
    expect(body.error?.code).toBe(-32000);
  });

  it("rejects an unknown session id with 404", async () => {
    const response = await fetch(`${handle.url}${handle.endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "Mcp-Session-Id": "does-not-exist",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error?: { code?: number };
    };
    expect(body.error?.code).toBe(-32001);
  });
});
