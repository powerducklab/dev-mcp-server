/**
 * Developer MCP tools.
 *
 * Fact tools (M0) expose read-only contract truth. Verification tools (M1)
 * send requests and run contract/scenario tests against a running backend via
 * @powerduck/openapi-cli.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  authRequirements,
  getOperation,
  getSchema,
  listOperations,
  overview,
  type ListOptions,
} from "../spec/facts.js";
import type { SpecStore } from "../spec/store.js";
import { FactError, type OperationLocator } from "../types.js";
import { pingTarget } from "../verify/ping.js";
import { runOverridesFromArgs, positiveInteger } from "../verify/config.js";
import type { ProgressSink } from "../verify/config.js";
import { sendOne } from "../verify/send.js";
import {
  contractFilterFromArgs,
  runContractSuite,
} from "../verify/contract.js";
import {
  runScenarioTool,
  validateScenario,
} from "../verify/scenario.js";
import { detectDrift } from "../verify/drift.js";
import {
  MockManager,
  type MockOptions,
  type MockResponseOverride,
} from "../mock/server.js";
import {
  deleteScenario,
  getScenario,
  listScenarios,
  saveScenario,
} from "../persistence/scenarios.js";
import type { ScenarioDefinition } from "@powerduck/openapi-cli";
import {
  dataModelDeploymentScript,
  dataModelReport,
  reconcileDataModel,
} from "../datamodel/run.js";

const METHOD_PATTERN = "^[!#$%&' *+.^_`|~0-9A-Za-z-]+$".replace(" ", "");

const OPERATION_LOCATOR_PROPERTIES = {
  ref: { type: "string", description: 'Operation reference, e.g. "POST /orders".' },
  operationId: { type: "string", description: "The operationId declared in the specification." },
  method: { type: "string", pattern: METHOD_PATTERN },
  path: { type: "string", description: 'The path, e.g. "/orders/{orderId}".' },
} as const;

const TARGET_PROPERTIES = {
  baseUrl: {
    type: "string",
    description: "Local backend base URL. Defaults to the first spec server URL.",
  },
  timeoutMs: { type: "integer", minimum: 1, maximum: 600000, default: 30000 },
  headers: {
    type: "object",
    description: "Extra headers sent with every request.",
    additionalProperties: { type: "string" },
  },
  variables: {
    type: "object",
    description: "Postman-style {{name}} variables.",
    additionalProperties: { type: "string" },
  },
  proxy: { type: "string", description: "HTTP/HTTPS proxy URL." },
} as const;

const SCENARIO_SCHEMA = {
  type: "object",
  description:
    "ScenarioDefinition: { name, description?, variables?, stopOnFailure?, steps: [{ ref | method+path, name?, skip?, request: { values?, serverUrl?, extract?: [{name, from: body|header|status, path?, key?}], assertions?: [{name, assert, ...}] } }] }",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    stopOnFailure: { type: "boolean" },
    variables: { type: "object", additionalProperties: { type: "string" } },
    steps: { type: "array", items: { type: "object" } },
  },
  required: ["name", "steps"],
} as const;

function operationLocator(args: Record<string, unknown>): OperationLocator {
  const ref = typeof args.ref === "string" ? args.ref.trim() : undefined;
  const operationId = typeof args.operationId === "string" ? args.operationId.trim() : undefined;
  const method = typeof args.method === "string" ? args.method.trim() : undefined;
  const path = typeof args.path === "string" ? args.path.trim() : undefined;
  if (ref || operationId || (method && path)) {
    return {
      ...(ref ? { ref } : {}),
      ...(operationId ? { operationId } : {}),
      ...(method && path ? { method, path } : {}),
    };
  }
  throw new FactError(
    "invalid_arguments",
    "Provide either ref, operationId, or both method and path.",
  );
}

function resolveScenarioArg(
  specPath: string,
  args: Record<string, unknown>,
): unknown {
  if (args.scenario !== undefined) return args.scenario;
  if (typeof args.scenarioName === "string" && args.scenarioName.trim()) {
    return getScenario(specPath, args.scenarioName.trim()).scenario;
  }
  throw new FactError(
    "invalid_arguments",
    "Provide either scenario or scenarioName.",
  );
}

export const devTools: Tool[] = [
  {
    name: "spec_overview",
    description:
      "Get the API title, version, servers, tags, protocols, security schemes, and counts. Call this first to understand the specification.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_operations",
    description:
      "List operations as compact rows (reference, operationId, summary, tags, status codes, auth). Filter by tag, method, protocol, auth, or free-text search. Results are paginated.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Exact tag name." },
        method: { type: "string", pattern: METHOD_PATTERN },
        protocol: { type: "string", description: "http, grpc, graphql, websocket, sse, or mcp." },
        secured: { type: "boolean", description: "Filter by secured operations." },
        search: { type: "string", description: "Case-insensitive substring." },
        pageSize: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        cursor: { type: "string", description: "Opaque nextCursor from a previous page." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_operation",
    description:
      "Get the full implementation contract for one operation: parameters with validation rules, request body JSON Schemas and examples, every documented response (status, headers, body), and effective security. Use this before writing handler code so field names, types, required flags, enums, and response shapes match the spec exactly.",
    inputSchema: {
      type: "object",
      properties: OPERATION_LOCATOR_PROPERTIES,
      additionalProperties: false,
    },
  },
  {
    name: "get_schema",
    description:
      "Get one reusable component schema (dereferenced) by component name or JSON pointer.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Component schema name, e.g. "Order".' },
        ref: { type: "string", description: 'Local pointer, e.g. "#/components/schemas/Order".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: "validate_spec",
    description:
      "Validate the current specification and list errors and warnings with their locations. The document is re-read from disk, so recent edits are reflected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_auth_requirements",
    description:
      "List every security scheme and, when an operation is given, the exact auth that operation requires (scheme type, header/query placement, OAuth flows and scopes). Use before implementing auth middleware or guards.",
    inputSchema: {
      type: "object",
      properties: OPERATION_LOCATOR_PROPERTIES,
      additionalProperties: false,
    },
  },
  {
    name: "ping_target",
    description:
      "Check that the local backend is reachable before testing. Returns status and latency. Use this first when a contract test fails at the connection layer.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        timeoutMs: { type: "integer", minimum: 100, maximum: 60000, default: 5000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_request",
    description:
      "Send one operation request to the running backend with optional path/query/header/body values, variables, and extra assertions. Returns the normalized response and per-assertion pass/fail. Use this to verify a single handler you just implemented.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPERATION_LOCATOR_PROPERTIES,
        ...TARGET_PROPERTIES,
        values: {
          type: "object",
          description: "Request values merged over sampled defaults: { path, query, header, body }.",
        },
        assertions: {
          type: "array",
          description: "Declarative assertions added to the operation's spec assertions.",
          items: { type: "object" },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_contract_tests",
    description:
      "Execute the selected operations against the backend and evaluate the spec contract (status, schema, declared assertions). Returns per-operation results and a summary. Filter by methods, tags, path regexes, or operationIds.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        concurrency: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        methods: { type: "array", items: { type: "string" } },
        paths: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        operationIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "detect_drift",
    description:
      "Probe the running backend against the whole specification and classify mismatches: missing operations (404/405), unreachable endpoints (connection failures), contract violations (wrong status/schema/assertions), and invalid-spec issues. Returns a drift level (none/low/high), counts, and per-operation reasons. Streams progress; supports the same filters as run_contract_tests.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        concurrency: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        methods: { type: "array", items: { type: "string" } },
        paths: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        operationIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "validate_scenario",
    description:
      "Statically validate an ordered multi-step scenario: every step reference must resolve, and extraction/assertion shapes are checked. Never sends a request. Call this before run_scenario.",
    inputSchema: {
      type: "object",
      properties: {
        scenario: SCENARIO_SCHEMA,
        scenarioName: { type: "string", description: "Name of a scenario saved under .powerduck/scenarios/." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_scenario",
    description:
      "Run an ordered, stateful scenario (for example register then login then create order). Steps share variables; each step can extract response values (body JSONPath, header, status) for later steps and add assertions. Streams progress; supports cancellation.",
    inputSchema: {
      type: "object",
      properties: {
        scenario: SCENARIO_SCHEMA,
        scenarioName: { type: "string", description: "Name of a saved scenario to run." },
        ...TARGET_PROPERTIES,
      },
      additionalProperties: false,
    },
  },
];

const persistenceTools: Tool[] = [
  {
    name: "save_scenario",
    description:
      "Validate and save a multi-step scenario next to the specification under .powerduck/scenarios/, so regression flows can be committed and re-run. Throws when validation fails or the name already exists unless overwrite is set.",
    inputSchema: {
      type: "object",
      properties: {
        scenario: SCENARIO_SCHEMA,
        overwrite: { type: "boolean", description: "Replace an existing saved scenario." },
      },
      required: ["scenario"],
      additionalProperties: false,
    },
  },
  {
    name: "list_scenarios",
    description: "List saved scenarios in .powerduck/scenarios/ with step counts and update times.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_scenario",
    description: "Read one saved scenario by name, including every step and assertion.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Scenario name." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_scenario",
    description: "Delete one saved scenario by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

const MOCK_OVERRIDE_SCHEMA = {
  type: "object",
  description:
    'Response overrides keyed by "METHOD /path", e.g. {"POST /payments/charge": {"status": 503}}.',
  additionalProperties: {
    type: "object",
    properties: {
      status: { type: "integer", description: "HTTP status code." },
      media: { type: "string", description: "Response content type." },
      body: {
        description: "Response body; objects are serialized as JSON, strings sent as-is.",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    additionalProperties: false,
  },
} as const;

const mockTools: Tool[] = [
  {
    name: "start_mock_server",
    description:
      "Start a local 127.0.0.1 HTTP mock that answers spec operations with examples or schema-derived samples. Use it to stand in for unavailable dependencies (payment gateways, OTP providers, downstream services) while you implement or run scenarios. Returns a mockId and base URL; point baseUrl at it. Optional overrides simulate failures or custom bodies.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Preferred port; default is ephemeral." },
        basePath: { type: "string", description: "Mount routes under this prefix; defaults to the first server base path." },
        latencyMs: { type: "integer", minimum: 0, maximum: 10000, description: "Artificial response delay." },
        overrides: MOCK_OVERRIDE_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "stop_mock_server",
    description:
      "Stop one mock server by mockId, or all running mocks when mockId is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        mockId: { type: "string", description: "ID from start_mock_server; omit to stop all." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_mock_servers",
    description: "List running mock servers with their base URL, routes, and received request count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_mock_requests",
    description:
      "Inspect requests a mock server received (method, path, query, selected headers, body, matched route). Use it to verify the implementation sent the expected callback or payload. Optionally clear the record after reading.",
    inputSchema: {
      type: "object",
      properties: {
        mockId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        clear: { type: "boolean", description: "Clear the request log after returning it." },
      },
      required: ["mockId"],
      additionalProperties: false,
    },
  },
];

const LIVE_TABLES_SCHEMA = {
  type: "array",
  description:
    "Optional read-only live database tables gathered out-of-band. The MCP server never connects to a database or accepts credentials; pass the evidence yourself. An empty array means an empty live database was connected (forward plan), distinct from omitting it (no database at all).",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "Bare physical table name." },
      schema: { type: "string", description: "Optional schema/owner (dbo, HR)." },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            dataType: { type: "string", description: "Native column type, e.g. varchar(80)." },
            nullable: { type: "boolean" },
            isPrimaryKey: { type: "boolean" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["name", "columns"],
    additionalProperties: false,
  },
} as const;

const LIVE_FOREIGN_KEYS_SCHEMA = {
  type: "array",
  description:
    "Enforced foreign keys observed in the live database, one entry per key column.",
  items: {
    type: "object",
    properties: {
      table: { type: "string", description: "Child (FK-owning) table." },
      column: { type: "string", description: "Child foreign-key column." },
      refTable: { type: "string", description: "Referenced parent table." },
      refColumn: { type: "string", description: "Referenced parent column." },
    },
    required: ["table", "column", "refTable", "refColumn"],
    additionalProperties: false,
  },
} as const;

const DATAMODEL_COMMON_PROPERTIES = {
  dialect: {
    type: "string",
    enum: ["mysql", "sqlserver", "oracle"],
    default: "mysql",
    description: "Target SQL dialect for generated statements.",
  },
  liveTables: LIVE_TABLES_SCHEMA,
  liveForeignKeys: LIVE_FOREIGN_KEYS_SCHEMA,
  tableNameOverrides: {
    type: "object",
    description:
      "Map a logical entity id (e.g. \"schema:Order\") to a physical table name.",
    additionalProperties: { type: "string" },
  },
} as const;

const datamodelTools: Tool[] = [
  {
    name: "datamodel_reconcile",
    description:
      "Derive the relational model (tables, columns, foreign keys, many-to-many link tables) from the OpenAPI component and request/response schemas, and reconcile it against optional live database evidence. Returns the full versioned artifact: per-table status (missing/drift/matched/extra), modeled and enforced relationships, column-level diffs, impacted API operations, additive CREATE/ALTER SQL, an ordered migration plan with blockedBy dependencies, and explicit open questions. Use this to plan a database from the API, map an existing schema, or scope an API-driven migration precisely. Read-only evidence; Powerduck never executes DDL.",
    inputSchema: {
      type: "object",
      properties: DATAMODEL_COMMON_PROPERTIES,
      additionalProperties: false,
    },
  },
  {
    name: "datamodel_report",
    description:
      "Render the same reconciliation as a self-contained Markdown brief with an embedded Mermaid erDiagram (renders on GitHub; paste into a PR, issue or another AI prompt): summary counts, per-table evidence, additive SQL, ordered migration plan, open questions and safeguards. Use datamodel_reconcile for structured JSON; use this for the human-readable, diffable document.",
    inputSchema: {
      type: "object",
      properties: DATAMODEL_COMMON_PROPERTIES,
      additionalProperties: false,
    },
  },
  {
    name: "datamodel_deployment_script",
    description:
      "Generate one reviewable, idempotent forward-only SQL script for a FRESH database from the API model: CREATE TABLE IF NOT EXISTS in foreign-key order, secondary indexes, and optional deterministic sample rows. Dialect-specific for MySQL, SQL Server and Oracle. Generated only, never executed. Use this to initialize a brand-new database; use datamodel_reconcile when a database already exists.",
    inputSchema: {
      type: "object",
      properties: {
        ...DATAMODEL_COMMON_PROPERTIES,
        sampleRows: {
          type: "integer",
          minimum: 0,
          maximum: 50,
          default: 0,
          description:
            "Deterministic sample rows per table; 0 (default) omits the data section. Link tables are never populated.",
        },
      },
      additionalProperties: false,
    },
  },
];

devTools.push(...persistenceTools, ...mockTools, ...datamodelTools);

const TOOL_NAMES = new Set(devTools.map((tool) => tool.name));

/** Executes one tool call and returns a JSON-serializable result. */
export async function executeDevTool(
  name: string,
  args: Record<string, unknown>,
  store: SpecStore,
  sink: ProgressSink = {},
  manager: MockManager = new MockManager(),
): Promise<unknown> {
  if (!TOOL_NAMES.has(name)) {
    throw new FactError("unknown_tool", `Unknown tool: ${name}`);
  }
  const snapshot = await store.load();
  const doc = snapshot.dereferenced;
  const raw = snapshot.document;

  switch (name) {
    case "start_mock_server": {
      const options: MockOptions = {};
      if (typeof args.port === "number") options.port = args.port;
      if (typeof args.basePath === "string") options.basePath = args.basePath;
      if (typeof args.latencyMs === "number") options.latencyMs = args.latencyMs;
      if (args.overrides && typeof args.overrides === "object") {
        options.overrides = args.overrides as Record<string, MockResponseOverride>;
      }
      return manager.start(raw as Record<string, unknown>, options);
    }
    case "stop_mock_server": {
      if (typeof args.mockId === "string" && args.mockId.trim()) {
        const stopped = await manager.stop(args.mockId.trim());
        return { stopped };
      }
      await manager.stopAll();
      return { stopped: "all" };
    }
    case "list_mock_servers":
      return { mocks: manager.list() };
    case "get_mock_requests": {
      if (typeof args.mockId !== "string" || !args.mockId.trim()) {
        throw new FactError("invalid_arguments", "mockId is required.");
      }
      const requests = manager.requests(args.mockId.trim(), {
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        ...(args.clear === true ? { clear: true } : {}),
      });
      return { mockId: args.mockId.trim(), count: requests.length, requests };
    }
  }

  switch (name) {
    case "spec_overview":
      return overview(doc);
    case "list_operations": {
      const options: ListOptions = {};
      if (typeof args.tag === "string") options.tag = args.tag;
      if (typeof args.method === "string") options.method = args.method;
      if (typeof args.protocol === "string") options.protocol = args.protocol;
      if (typeof args.secured === "boolean") options.secured = args.secured;
      if (typeof args.search === "string") options.search = args.search;
      if (typeof args.pageSize === "number") options.pageSize = args.pageSize;
      if (typeof args.cursor === "string") options.cursor = args.cursor;
      return listOperations(doc, options);
    }
    case "get_operation":
      return getOperation(doc, raw, operationLocator(args));
    case "get_schema": {
      const schemaName = typeof args.name === "string" ? args.name.trim() : undefined;
      const schemaRef = typeof args.ref === "string" ? args.ref.trim() : undefined;
      if (!schemaName && !schemaRef) {
        throw new FactError("invalid_arguments", "Provide either a schema name or a $ref pointer.");
      }
      return getSchema(doc, raw, {
        ...(schemaName ? { name: schemaName } : {}),
        ...(schemaRef ? { ref: schemaRef } : {}),
      });
    }
    case "validate_spec": {
      const fresh = await store.load(true);
      return fresh.validation;
    }
    case "get_auth_requirements": {
      const hasLocator =
        args.ref !== undefined ||
        args.operationId !== undefined ||
        args.method !== undefined;
      return hasLocator ? authRequirements(doc, operationLocator(args)) : authRequirements(doc);
    }
    case "ping_target": {
      const overrides = runOverridesFromArgs(snapshot, args);
      const baseUrl = overrides.baseUrl;
      if (!baseUrl) {
        throw new FactError(
          "missing_base_url",
          "Provide baseUrl or declare a concrete server URL in the specification.",
        );
      }
      const timeoutMs =
        typeof args.timeoutMs === "number"
          ? positiveInteger(args.timeoutMs, "timeoutMs", 5000, 100, 60000)
          : 5000;
      return pingTarget(baseUrl, timeoutMs);
    }
    case "send_request": {
      const overrides = runOverridesFromArgs(snapshot, args);
      return sendOne(snapshot, overrides, operationLocator(args), {
        ...(sink.signal ? {signal:sink.signal} : {}),
        values: (args.values ?? undefined) as never,
        variables: (args.variables as Record<string, string>) ?? undefined,
        assertions: (args.assertions as never[]) ?? undefined,
      });
    }
    case "run_contract_tests": {
      const overrides = runOverridesFromArgs(snapshot, args);
      const filter = contractFilterFromArgs(args);
      return runContractSuite(snapshot, overrides, filter, sink);
    }
    case "detect_drift": {
      const overrides = runOverridesFromArgs(snapshot, args);
      const filter = contractFilterFromArgs(args);
      return detectDrift(snapshot, overrides, filter, sink);
    }
    case "validate_scenario":
      return validateScenario(snapshot, resolveScenarioArg(snapshot.path, args));
    case "run_scenario": {
      const overrides = runOverridesFromArgs(snapshot, args);
      return runScenarioTool(
        snapshot,
        resolveScenarioArg(snapshot.path, args),
        overrides,
        sink,
      );
    }
    case "save_scenario": {
      const definition = args.scenario as ScenarioDefinition;
      const validation = validateScenario(snapshot, definition);
      if (!validation.valid) {
        throw new FactError(
          "invalid_scenario",
          "Scenario failed validation.",
          validation.errors,
        );
      }
      return saveScenario(
        snapshot.path,
        definition,
        args.overwrite === true ? { overwrite: true } : {},
      );
    }
    case "list_scenarios":
      return { scenarios: listScenarios(snapshot.path) };
    case "get_scenario": {
      if (typeof args.name !== "string" || !args.name.trim()) {
        throw new FactError("invalid_arguments", "name is required.");
      }
      return getScenario(snapshot.path, args.name.trim());
    }
    case "delete_scenario": {
      if (typeof args.name !== "string" || !args.name.trim()) {
        throw new FactError("invalid_arguments", "name is required.");
      }
      return { deleted: deleteScenario(snapshot.path, args.name.trim()) };
    }
    case "datamodel_reconcile":
      // datamodel resolves internal $ref itself, so it needs the raw document
      // with references and component schemas intact (not the dereferenced copy).
      return reconcileDataModel(raw, args);
    case "datamodel_report":
      return dataModelReport(raw, args);
    case "datamodel_deployment_script":
      return dataModelDeploymentScript(raw, args);
    default:
      throw new FactError("unknown_tool", `Unknown tool: ${name}`);
  }
}
