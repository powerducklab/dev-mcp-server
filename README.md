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

Mocks never execute scripts or fetch remote references and bind to loopback only. Each manager allows at most 8 running mocks. Responses are capped at 1 MB each and 8 MB total per mock. Request recording keeps at most 200 entries and 2 MB per mock: sensitive header, query, JSON and form fields are redacted before storage; opaque, malformed or truncated bodies are omitted. Field-name redaction is not a general personal-data detector. CORS permits cross-origin requests without browser credentials. Stopping a mock also cancels pending latency timers; all mocks stop when the MCP server disconnects.

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

### Verification transport update

Verification uses `@powerduck/openapi-cli` 0.2.13. Cancellation now reaches active
single requests and contract-suite requests, in addition to ordered scenarios.
Programmatic global variables also reach single-operation execution. Contract
workers use an index cursor instead of repeatedly shifting the operation array.
CLI transport behavior, including explicit errors for unsupported GraphQL/MCP
custom proxy/TLS, applies to these tools. MCP callers provide authentication via
request headers; programmatic callers can also supply `RunOverrides.auth`.

Version 0.7.3 also makes clean installs reproducible: the lockfile uses registry
packages instead of links into neighboring repositories, Commander matches the
advertised Node version, and the Terser build dependency is declared explicitly.

### 0.7.4 — malformed HTTP request isolation

Mock and MCP HTTP listeners return HTTP 400 for invalid request targets instead
of allowing URL parsing errors to escape their request callbacks and terminate
the hosting process. MCP rejects these requests before authentication without
creating a session. Regression tests send raw malformed HTTP requests and then
verify that the same listeners still serve ordinary requests.

### Extended HTTP methods

HTTP operation discovery includes all nine fixed OpenAPI 3.2 methods (including `trace` and `query`) and custom verbs in `additionalOperations`, such as `PROPFIND`, `REPORT`, and `CUSTOM-VERB`. Shared method helpers come from `@powerduck/openapi-parser/methods`; path metadata is not interpreted as an operation. Custom verbs must be valid HTTP tokens. Use OpenAPI 3.2 when declaring QUERY or `additionalOperations`.

### Response contracts and reproducible example

`run_contract_tests` and drift checks now validate declared response status,
media type and JSON schema with Ajv, without type coercion or remote schema
fetching. Format validation is not enabled; unsupported non-JSON response schema
checks report a limitation instead of claiming a pass. The validator reports
field paths (for example `/total must be number`) without embedding response data.

See [the contract-total example](examples/contract-total/README.md) for a real
loopback backend that fails on a string total and passes after returning a number.
No model, account or Mock is involved. `MockOptions.onResponseComplete` is an
optional observer called after a real response finishes; observer failures do not
interrupt serving. It receives only the status code.

Response schema checks skip body/media requirements for HEAD, 204 and 304
responses; their declared status is still checked (0.7.7 regression fix).

### Verification network policy

`--base-url` (or `baseUrl` in `powerduck.dev.json`) supplies the default target
for verification tools; a tool's `baseUrl` still takes precedence. By default,
verification reaches only loopback. To opt in to a remote backend, configure
`allowHosts: ["192.168.1.20"]` or `--allow-hosts 192.168.1.20`. Remote entries
must currently be IP literals: DNS targets are rejected until the runner can pin
DNS resolution. Metadata/link-local addresses are always denied. Verification
does not follow redirects or use proxies. Scenario step targets use the same
policy. Runtime `auth` supports `none`, `bearer`, `basic`, and `apikey` and is not
written to the project config.

Bundle external OpenAPI references into the document before loading it. MCP
verification refuses embedded Postman scripts because their additional network
requests cannot yet be restricted; use declarative assertions or the desktop
Debug workspace for script execution.

Restricted MCP verification currently supports HTTP and SSE. GraphQL and session
protocols are rejected until the published runner dependencies enforce the same
redirect and target policy. Use the desktop Debug workspace for these protocols.

### Generate a contract from source code

`scan_code_to_openapi` performs deterministic, read-only source analysis and
returns `document` (OpenAPI 3.2), `report`, `diagnostics`, `ok`, and
`documentValid`. It does not execute the project, use AI, or save/overwrite files.
Partial extraction is explicitly reported; inspect unresolved gaps before using
its output as an API contract.

Configure the source boundary with `--project /absolute/backend` or `project`
in `powerduck.dev.json` (relative to that config). Programmatic hosts use
`projectRoot` in `createDevMcpServer`, `startStdioServer`, or `startHttpServer`.
Without it, the specification's parent directory is the boundary. The caller's
`directory` may choose a subdirectory but cannot escape it, including through a
symlink. Only scan projects you trust; this is an analysis boundary, not an OS
sandbox for malicious repositories.

```json
{"directory":"src","frameworks":["express"],"includeTests":false,"timeoutMs":60000}
```

The configured `--spec` file need not exist for these two tools; this lets an
agent generate its first specification. Existing contract tools still require
a readable specification. Results are returned to the connected MCP client, so
choose a project root appropriate for that client's access.

`get_code_scan_capabilities` takes no arguments and lists the supported
frameworks and current limits. Scanning supports Express, Fastify, NestJS,
FastAPI, Flask, Gin, Chi, Spring, ASP.NET, Axum and Laravel. It respects the
scanner's ignored-file policy. Source extraction runs in a worker, with a
512 MiB JS heap limit, a maximum two-minute timeout, 10,000 source files,
2 MiB per source file, 64 MiB of indexed source and an 8 MiB result limit.
Only one scan runs per process, across HTTP sessions. Cancellation and timeout
terminate the worker before freeing the scan slot. Worker output never goes to
stdio MCP framing. Progress reports are throttled.

Stable error codes: `invalid_arguments`, `scan_path_denied`,
`scan_path_unavailable`, `scan_busy`, `cancelled`, `scan_timeout`,
`scan_result_too_large`, and `scan_failed`.

Other existing capabilities already cover contract validation, live drift,
scenarios, mock lifecycle, and data-model SQL/report generation. Automatic
source-gap fixes, document merge/overwrite and arbitrary SQL execution are not
exposed by the new tools; those need separate review and write semantics.

### Generate a documentation link from code

Ask your coding agent: “Use Powerduck to generate API documentation for this project and give me the link.”

`publish_code_docs({"directory":".","target":"local"})` scans within the host-configured `--project` root and returns a `url`, `publicationId`, completeness `report`, and `diagnostics`. It uses the official `@powerduck/oas-document` viewer with locally bundled assets. No project code executes, no source files change, and no login or external upload is required. Review inferred-contract gaps before relying on the documentation.

Local links bind only to `127.0.0.1` on the **MCP host machine**. They last until that MCP session ends. Repeating the call for the same directory updates the same link; refresh the page to see changes. A remote MCP host's loopback URL is not accessible from another computer. Each session supports up to 16 publications.

For a shareable link, explicitly use `target: "cloud"`. The result initially has `status: "awaiting_authorization"` and an `authorizationUrl`. Open that URL in a browser on the MCP host, sign in to Powerduck Cloud, and confirm hosting. The API definition is uploaded only through that confirmation flow. Call `get_code_docs_status({"publicationId":"..."})` to receive the final documentation URL. Authorization expires after ten minutes. MCP receives no login cookies or account credentials. Do not present the authorization URL as the finished documentation link.

Subsequent Cloud calls for the same directory in the same MCP session update the existing Cloud document. Cloud links remain available after MCP exits, but the association with the source project is currently session-scoped: a new session creates a new Cloud publication. Existing Cloud account quotas apply.

The desktop tool catalog includes localized titles and descriptions for both tools in all 16 supported languages. The documentation renderer preserves the API's own titles and descriptions.
