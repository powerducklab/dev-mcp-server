/**
 * Embeds the developer MCP server in-process and calls it with an MCP client.
 *
 * Run from the package root after `npm run build`:
 *   node examples/programmatic.mjs [path/to/openapi.yaml]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevMcpServer, SpecStore } from "@powerduck/dev-mcp-server";

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath =
  process.argv[2] ?? path.join(here, "..", "tests", "fixtures", "petstore.yaml");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createDevMcpServer(new SpecStore(specPath));
const client = new Client(
  { name: "programmatic-example", version: "0.0.0" },
  { capabilities: {} },
);

await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const { tools } = await client.listTools();
console.log("Tools:", tools.map((tool) => tool.name).join(", "));

const overview = await client.callTool({ name: "spec_overview", arguments: {} });
console.log("Overview:", overview.content[0].text);

// Derive a relational model (tables, foreign keys, link tables) and additive
// SQL from the OpenAPI schemas. Pass liveTables/liveForeignKeys gathered
// out-of-band to reconcile against an existing database; the server never
// connects to a database itself.
const dataModel = await client.callTool({
  name: "datamodel_reconcile",
  arguments: { dialect: "mysql" },
});
const reconciliation = JSON.parse(dataModel.content[0].text);
console.log("Data model summary:", JSON.stringify(reconciliation.summary));

await client.close();
await server.close();
