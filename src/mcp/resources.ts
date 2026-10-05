/**
 * MCP resources expose the same facts as stable URIs, so agents can attach
 * contract context directly to a conversation.
 */

import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import {
  getOperation,
  getSchema,
  listOperations,
  overview,
} from "../spec/facts.js";
import type { SpecStore } from "../spec/store.js";
import { FactError } from "../types.js";

const SCHEME = "powerduck://spec/";

export async function listSpecResources(
  store: SpecStore,
): Promise<Resource[]> {
  const snapshot = await store.load();
  return [
    {
      uri: `${SCHEME}source`,
      name: "OpenAPI source",
      description: "The raw OpenAPI document exactly as authored.",
      mimeType: snapshot.mediaType,
    },
    {
      uri: `${SCHEME}overview`,
      name: "API overview",
      description: "Servers, tags, protocols, security schemes, and counts.",
      mimeType: "application/json",
    },
    {
      uri: `${SCHEME}operations`,
      name: "Operations index",
      description: "Compact index of all operations (up to 500).",
      mimeType: "application/json",
    },
  ];
}

export const specResourceTemplates: ResourceTemplate[] = [
  {
    uriTemplate: `${SCHEME}operation/{ref}`,
    name: "Operation contract",
    description:
      'Full contract for one operation. Use the reference form "METHOD /path", URL-encoded, e.g. operation/POST%20/orders.',
    mimeType: "application/json",
  },
  {
    uriTemplate: `${SCHEME}schema/{name}`,
    name: "Component schema",
    description: "A dereferenced component schema by name.",
    mimeType: "application/json",
  },
];

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export async function readSpecResource(
  uri: string,
  store: SpecStore,
): Promise<ResourceContents> {
  if (!uri.startsWith(SCHEME)) {
    throw new FactError("resource_not_found", `Unknown resource: ${uri}`);
  }
  const snapshot = await store.load();
  const doc = snapshot.dereferenced;
  const raw = snapshot.document;
  const rel = decodeURIComponent(uri.slice(SCHEME.length));

  if (rel === "source") {
    return { uri, mimeType: snapshot.mediaType, text: snapshot.sourceText };
  }
  if (rel === "overview") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(overview(doc), null, 2),
    };
  }
  if (rel === "operations") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(listOperations(doc, { pageSize: 500 }), null, 2),
    };
  }
  if (rel.startsWith("operation/")) {
    const ref = rel.slice("operation/".length);
    const fact = getOperation(doc, raw, { ref });
    return { uri, mimeType: "application/json", text: JSON.stringify(fact, null, 2) };
  }
  if (rel.startsWith("schema/")) {
    const name = rel.slice("schema/".length);
    const fact = getSchema(doc, raw, { name });
    return { uri, mimeType: "application/json", text: JSON.stringify(fact, null, 2) };
  }
  throw new FactError("resource_not_found", `Unknown resource: ${uri}`);
}
