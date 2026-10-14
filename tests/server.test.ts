import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SpecStore } from "../src/spec/store.js";
import { createDevMcpServer } from "../src/mcp/createServer.js";
import { startFakeBackend, type FakeBackend } from "./helpers/fakeBackend.js";

const fixturePath = fileURLToPath(
  new URL(path.join("fixtures", "petstore.yaml"), import.meta.url),
);

const EXPECTED_TOOLS = [
  "scan_code_to_openapi",
  "get_code_scan_capabilities",
  "spec_overview",
  "list_operations",
  "get_operation",
  "get_schema",
  "validate_spec",
  "get_auth_requirements",
  "ping_target",
  "send_request",
  "run_contract_tests",
  "detect_drift",
  "validate_scenario",
  "run_scenario",
  "start_mock_server",
  "stop_mock_server",
  "list_mock_servers",
  "get_mock_requests",
  "save_scenario",
  "list_scenarios",
  "get_scenario",
  "delete_scenario",
  "datamodel_reconcile",
  "datamodel_report",
  "datamodel_deployment_script",
].sort();

async function connectClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createDevMcpServer(new SpecStore(fixturePath));
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseText(result: any): any {
  const first = result?.content?.[0];
  if (!first || typeof first !== "object" || !("text" in first)) {
    throw new Error("Expected a text result");
  }
  return JSON.parse(String(first.text));
}

function resourceText(result: {
  contents: Array<{ text?: string; blob?: string }>;
}): string {
  const first = result.contents[0];
  if (!first || typeof first.text !== "string") {
    throw new Error("Expected a text resource");
  }
  return first.text;
}

describe("dev MCP server over in-memory transport", () => {
  const sessions: Array<{ client: Client; server: { close: () => Promise<void> } }> = [];
  let backend: FakeBackend;

  beforeAll(async () => {
    backend = await startFakeBackend();
  });

  afterAll(async () => {
    await backend.close();
  });

  afterEach(async () => {
    while (sessions.length) {
      const session = sessions.pop();
      await session?.client.close();
      await session?.server.close();
    }
  });

  it("advertises the fact tool set", async () => {
    const session = await connectClient();
    sessions.push(session);
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("answers spec_overview", async () => {
    const session = await connectClient();
    sessions.push(session);
    const result = await session.client.callTool({ name: "spec_overview", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(parseText(result).title).toBe("Petstore API");
  });

  it("paginates list_operations across calls", async () => {
    const session = await connectClient();
    sessions.push(session);
    const first = parseText(
      await session.client.callTool({
        name: "list_operations",
        arguments: { pageSize: 2 },
      }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(4);
    const second = parseText(
      await session.client.callTool({
        name: "list_operations",
        arguments: { pageSize: 2, cursor: first.nextCursor },
      }),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
  });

  it("resolves an operation by operationId", async () => {
    const session = await connectClient();
    sessions.push(session);
    const result = parseText(
      await session.client.callTool({
        name: "get_operation",
        arguments: { operationId: "createPet" },
      }),
    );
    expect(result.ref).toBe("POST /pets");
    expect(result.requestBody.required).toBe(true);
  });

  it("returns a structured error for an unknown operation", async () => {
    const session = await connectClient();
    sessions.push(session);
    const result = await session.client.callTool({
      name: "get_operation",
      arguments: { ref: "GET /missing" },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result).error).toBe("operation_not_found");
  });

  it("validates the live specification", async () => {
    const session = await connectClient();
    sessions.push(session);
    const result = parseText(
      await session.client.callTool({ name: "validate_spec", arguments: {} }),
    );
    expect(result.valid).toBe(true);
  });

  it("lists fixed resources and templates", async () => {
    const session = await connectClient();
    sessions.push(session);
    const resources = await session.client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual([
      "powerduck://spec/source",
      "powerduck://spec/overview",
      "powerduck://spec/operations",
    ]);
    const templates = await session.client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "powerduck://spec/operation/{ref}",
      "powerduck://spec/schema/{name}",
    ]);
  });

  it("reads the raw source and a templated schema", async () => {
    const session = await connectClient();
    sessions.push(session);
    const source = await session.client.readResource({
      uri: "powerduck://spec/source",
    });
    expect(source.contents[0]?.mimeType).toBe("application/yaml");
    expect(resourceText(source)).toContain("Petstore API");

    const schema = await session.client.readResource({
      uri: "powerduck://spec/schema/Pet",
    });
    const parsed = JSON.parse(resourceText(schema));
    expect(parsed.schema.required).toEqual(["id", "name"]);

    const operation = await session.client.readResource({
      uri: "powerduck://spec/operation/POST%20/pets",
    });
    const opParsed = JSON.parse(resourceText(operation));
    expect(opParsed.ref).toBe("POST /pets");
  });

  it("runs contract verification through JSON-RPC", async () => {
    const session = await connectClient();
    sessions.push(session);
    const report = parseText(
      await session.client.callTool({
        name: "run_contract_tests",
        arguments: { baseUrl: backend.url, operationIds: ["listPets"], timeoutMs: 10000 },
      }),
    );
    expect(report.summary.passed).toBe(1);
    expect(report.results[0].status).toBe("passed");
  });

  it("validates a bad scenario without traffic", async () => {
    const session = await connectClient();
    sessions.push(session);
    const result = parseText(
      await session.client.callTool({
        name: "validate_scenario",
        arguments: { scenario: { name: "broken", steps: [{ ref: "GET /missing" }] } },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not present in the spec");
  });
});
