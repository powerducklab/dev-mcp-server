# @powerduck/dev-mcp-server

A developer-facing [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI coding agents (Claude Code, Codex CLI, Cursor, Claude Desktop) **accurate, dereferenced OpenAPI facts** for the backend you are implementing, plus **real verification against your local server**: ping, single requests, contract tests, and ordered multi-step scenarios. It also derives a relational data model from the schemas and reconciles it with an optional live database, generating additive SQL without ever executing it.

> [Powerduck](https://www.powerduck.com/) — design, debug, and verify APIs with AI.

This server is for the **people building the API**. It answers questions like "what exactly must `POST /orders` accept and return?" so the agent writes handlers that match the specification. It is **not** the server that exposes an API to AI clients for calling a running service; that is a separate package.

## What it provides

### Contract facts

Read-only truth, re-read from disk on every request (the document is cached by file mtime, so edits are visible without reconnecting):

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `spec_overview` | Title, version, servers, tags, protocols, security schemes, counts. | — |
| `list_operations` | Compact, filterable, paginated operation index. | `tag`, `method`, `protocol`, `secured`, `search`, `pageSize` (1–500, default 100), `cursor` |
| `get_operation` | Full implementation contract: parameters with validation rules, request body schemas/examples, every response (status, headers, body), effective security, servers. | One of `ref` (`"POST /orders"`), `operationId`, or `method` + `path` |
| `get_schema` | One dereferenced component schema. | `name` or `ref` (`#/components/schemas/...`) |
| `validate_spec` | Re-reads the file and returns errors/warnings with locations. | — |
| `get_auth_requirements` | All security schemes and, for an operation, the exact auth it requires. | Optional operation locator |

### Verification against a running backend

These tools execute real requests through [`@powerduck/openapi-cli`](https://www.powerduck.com/) and report normalized responses plus spec-derived assertion results. `baseUrl` defaults to the first concrete server URL in the specification.

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `ping_target` | Reachability probe; returns status and latency. | `baseUrl`, `timeoutMs` (100–60000, default 5000) |
| `send_request` | Send one operation with overrides and return per-assertion results. | locator, `baseUrl`, `timeoutMs`, `headers`, `variables`, `proxy`, `values` (`{path, query, header, body}`), `assertions[]` |
| `run_contract_tests` | Batch-run operations and evaluate the contract; returns a summary and per-operation results. | `baseUrl`, `concurrency` (1–20), `methods[]`, `tags[]`, `paths[]` (regex), `operationIds[]`, plus the common target options |
| `detect_drift` | One-pass classification of implementation drift: missing operations (404/405), unreachable endpoints, contract violations, and invalid-spec issues; returns a `none`/`low`/`high` level with per-operation reasons. | Same filters and target options as `run_contract_tests` |
| `validate_scenario` | Statically resolve an ordered multi-step scenario; never sends traffic. | `scenario` |
| `run_scenario` | Run an ordered, stateful scenario with shared variables, extraction, and assertions. | `scenario`, `baseUrl`, `timeoutMs`, `variables` |

Common target options: `baseUrl`, `timeoutMs` (up to 600000), `headers` (string map), `variables` (`{{name}}` string map), and `proxy`.

A scenario is an ordered list of operations with a shared variable scope:

```json
{
  "name": "create then fetch a pet",
  "stopOnFailure": true,
  "steps": [
    {
      "ref": "POST /pets",
      "request": {
        "extract": [{ "name": "petId", "from": "body", "path": "$.id" }],
        "assertions": [{ "name": "created", "assert": "status", "value": 201 }]
      }
    },
    {
      "ref": "GET /pets/{petId}",
      "request": {
        "values": { "path": { "petId": "{{petId}}" } },
        "assertions": [
          { "name": "ok", "assert": "status", "value": 200 },
          { "name": "id roundtrips", "assert": "jsonPath", "path": "$.id", "exists": true }
        ]
      }
    }
  ]
}
```

Each step supports `extract` (`from: body | header | status`, with `path` JSONPath or header `key`), declarative `assertions` (`status`, `header`, `bodyContains`, `bodyEquals`, `jsonPath`, `responseTime`), per-step `values`/`serverUrl`, and `skip`. A runnable copy lives in [`examples/scenario.create-fetch.json`](examples/scenario.create-fetch.json).

Long runs emit `notifications/progress` when the client passes a progress token, and honor `notifications/cancelled` (the scenario aborts and remaining steps are reported as skipped).

Documents that are not OpenAPI 3.x are upgraded to 3.2 when that conversion is safe; otherwise facts are served best-effort from the original document and `validate_spec` reports the problems. Internal `$ref` values are inlined (cycle-safe); unresolved references fall back to the original `$ref`.

### Resources

| URI | Content |
| --- | --- |
| `powerduck://spec/source` | Raw source document (YAML or JSON). |
| `powerduck://spec/overview` | JSON overview. |
| `powerduck://spec/operations` | JSON operation index (up to 500). |
| `powerduck://spec/operation/{ref}` | One operation; `ref` is the URL-encoded `"METHOD /path"`, e.g. `operation/POST%20/orders`. |
| `powerduck://spec/schema/{name}` | One component schema. |

### Local mocks for unavailable dependencies

When a dependency is not implemented yet (a payment gateway, an OTP provider, a downstream service), start a loopback-only mock that answers spec operations with examples or schema-derived samples, then point your scenario at it:

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `start_mock_server` | Start a `127.0.0.1` mock; returns `mockId`, base URL, and the route table. | `port?`, `basePath?` (defaults to the first server base path), `latencyMs?`, `overrides?` |
| `get_mock_requests` | Inspect recorded requests (method, path, query, selected headers, parsed body, matched route). | `mockId`, `limit?` (1–200), `clear?` |
| `list_mock_servers` | List running mocks, routes, and request counts. | — |
| `stop_mock_server` | Stop one mock, or all when `mockId` is omitted. | `mockId?` |

`overrides` is keyed by `"METHOD /path"` to simulate failures or custom payloads:

```json
{
  "POST /payments/charge": {
    "status": 503,
    "body": { "error": "gateway unavailable" },
    "headers": { "X-Downstream": "payment" }
  }
}
```

Mocks never execute scripts or fetch remote references, bind to loopback only, cap bodies at 1 MB, and stop automatically when the MCP server disconnects. Use `get_mock_requests` to assert what your implementation actually sent — for example the payment callback payload.

### Saving regression scenarios

Scenarios worth keeping are stored next to the specification as project artifacts that can be committed:

| Tool | Purpose |
| --- | --- |
| `save_scenario` | Validates a scenario, then writes `.powerduck/scenarios/<name>.json` (set `overwrite` to replace). |
| `list_scenarios` | Lists saved scenarios with step counts and update times. |
| `get_scenario` | Reads one saved scenario by name. |
| `delete_scenario` | Deletes one saved scenario by name. |

`validate_scenario` and `run_scenario` accept either an inline `scenario` or a `scenarioName` that loads a saved file. The server only writes inside the `.powerduck/` directory next to the specification; names are reduced to safe file slugs.

### Data-model reconciliation and SQL

The same deterministic engine that powers Powerduck's Data Model tool, [`@powerduck/datamodel`](https://www.npmjs.com/package/@powerduck/datamodel), turns the OpenAPI component and request/response schemas into a relational model (tables, columns, foreign keys, many-to-many link tables) and reconciles it against an optional live database. The MCP server itself never connects to a database and never accepts credentials; you may pass read-only live evidence gathered out-of-band for bidirectional comparison. All SQL is generated, never executed, and proposed statements are additive only (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN`).

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `datamodel_reconcile` | The full versioned artifact: per-table status (`missing`/`drift`/`matched`/`extra`), modeled and enforced relationships, column-level diffs, impacted API operations, additive CREATE/ALTER SQL, an ordered migration plan with `blockedBy`, and explicit open questions. | `dialect` (`mysql`/`sqlserver`/`oracle`, default `mysql`), optional `liveTables[]`, `liveForeignKeys[]`, `tableNameOverrides` |
| `datamodel_report` | The same result as a self-contained Markdown brief with an embedded Mermaid `erDiagram` (renders on GitHub; paste into a PR, issue, or another prompt). Use the reconcile tool for structured JSON. | same as `datamodel_reconcile` |
| `datamodel_deployment_script` | One idempotent forward-only script for a **fresh** database: `CREATE TABLE IF NOT EXISTS` in foreign-key order, secondary indexes, and optional deterministic sample rows. | common arguments plus `sampleRows` (0–50, default 0; link tables are never populated) |

`liveTables` entries are `{ name, schema?, columns: [{ name, dataType?, nullable?, isPrimaryKey? }] }`. Pass an empty array to signal that an empty database was connected (a forward plan), which is distinct from omitting it (no database at all). `liveForeignKeys` entries are `{ table, column, refTable, refColumn }`: a modeled edge that matches a live constraint is reported as enforced, while a live constraint the model omits is drawn as a live-only relationship — including edges to tables the API does not describe, which come back as orphan tables for reverse engineering.

Planned for later milestones: resumable SSE event stores for resumable Streamable HTTP sessions.

## Run

Requires Node.js `>= 20.11`.

```bash
npx -y @powerduck/dev-mcp-server --spec /absolute/path/to/openapi.yaml
```

For local development, build from source and run the binary directly:

```bash
npm install
npm run build
node dist/cli.mjs --spec tests/fixtures/petstore.yaml
```

### CLI options

| Option | Description |
| --- | --- |
| `--spec <path>` | Path to the OpenAPI document (JSON or YAML). Required unless provided by config. |
| `--config <path>` | Path to a `powerduck.dev.json` file (defaults to `./powerduck.dev.json` when present). |
| `--base-url <url>` | Default local backend base URL used by verification tools when a call omits `baseUrl`. |
| `--project <dir>` | Backend project root (used by upcoming code-aware tools). |
| `--mock-port <number>` | Preferred port for the first mock started without an explicit `port` (0–65535; later mocks use ephemeral ports). Applies to both the stdio command and `http`. |

### Project config (`powerduck.dev.json`)

```json
{
  "spec": "./openapi/openapi.yaml",
  "baseUrl": "http://localhost:8080",
  "project": "./backend"
}
```

Relative paths resolve against the directory containing the config file. CLI flags override config values. This file is safe to commit; put secrets in environment variables, never in the config.

## Connect an editor

Use an absolute spec path in every configuration.

### Claude Code

```bash
claude mcp add powerduck-dev -- npx -y @powerduck/dev-mcp-server --spec /abs/path/openapi.yaml
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "powerduck-dev": {
      "command": "npx",
      "args": ["-y", "@powerduck/dev-mcp-server", "--spec", "/abs/path/openapi.yaml"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.powerduck-dev]
command = "npx"
args = ["-y", "@powerduck/dev-mcp-server", "--spec", "/abs/path/openapi.yaml"]
```

### Cursor

`.cursor/mcp.json` in the project root:

```json
{
  "mcpServers": {
    "powerduck-dev": {
      "command": "npx",
      "args": ["-y", "@powerduck/dev-mcp-server", "--spec", "/abs/path/openapi.yaml"]
    }
  }
}
```

### Streamable HTTP transport

For containers or remote dev machines where stdio is unavailable, run the built-in Streamable HTTP server (stateful sessions, progress over SSE) protected by a shared Bearer token:

```bash
npx -y @powerduck/dev-mcp-server http \
  --spec ./openapi/openapi.yaml \
  --port 3333 \
  --host 127.0.0.1 \
  --endpoint /mcp \
  --mock-port 4010 \
  --token "$POWERDUCK_MCP_TOKEN"
```

`--mock-port` only pins the first mock server started through `start_mock_server` without an explicit `port`; subsequent mocks always bind ephemeral ports to avoid collisions.

The endpoint URL and the token are printed to **stderr** at startup. When `--token` is omitted, a 24-byte random token is generated and printed once. `--port 0` picks an ephemeral port. An unauthenticated `GET /health` returns `{"status":"ok"}` for connectivity checks; every MCP request requires `Authorization: Bearer <token>` and is rejected with `401` and a `WWW-Authenticate: Bearer` challenge otherwise. The server binds to loopback by default — bind to `0.0.0.0` only behind a trusted network or TLS reverse proxy.

Point an editor at the HTTP server with a URL entry instead of a command, for example:

```json
{
  "mcpServers": {
    "powerduck-dev": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The same 23 tools, resources, mocks, scenarios, and data-model reconciliation are available over both transports. HTTP clients must send `Accept: application/json, text/event-stream` as required by the MCP Streamable HTTP specification.

## Use a local build before publishing

The `npx` configurations above only resolve once the package is published to npm. To point an editor at a local checkout, build it and launch the emitted binary with `node`:

```bash
npm install
npm run build
```

```toml
# ~/.codex/config.toml
[mcp_servers.powerduck-dev]
command = "node"
args = ["/abs/path/to/openapi-dev-mcp-server/dist/cli.mjs", "--spec", "/abs/path/openapi.yaml"]
```

The same substitution applies to the JSON editors: set `"command": "node"` and `args[0]` to the absolute `dist/cli.mjs`. The Powerduck desktop app's **MCP & Coding** panel writes this form automatically when **Use local build** is enabled (it targets the copy bundled with the app). `node` must be on the `PATH` of the editor process.

## Embed programmatically

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevMcpServer, SpecStore } from "@powerduck/dev-mcp-server";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createDevMcpServer(new SpecStore("/abs/path/openapi.yaml"));
const client = new Client(
  { name: "my-app", version: "0.0.0" },
  { capabilities: {} },
);
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const result = await client.callTool({ name: "spec_overview", arguments: {} });
console.log(result.content[0].text);
```

A runnable copy lives in [`examples/programmatic.mjs`](examples/programmatic.mjs) (`node examples/programmatic.mjs [spec-path]` after build).

## Develop

```bash
npm run typecheck   # strict TypeScript
npm test            # vitest: facts, in-process MCP client/server, and verification E2E
npm run build       # tsc + tsup (ESM .mjs and CJS .cjs)
```

## License

MIT © Powerduck limited
