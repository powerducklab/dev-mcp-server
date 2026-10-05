/**
 * Pure fact extraction over an OpenAPI document.
 *
 * Every function here is deterministic and side-effect free. The MCP layer is
 * a thin transport over these functions so the same logic is unit-testable
 * without a JSON-RPC client.
 */

import {
  type CompactOperation,
  FactError,
  type HeaderFact,
  type MediaFact,
  type OperationFact,
  type OperationLocator,
  type OverviewFact,
  type PagedOperations,
  type ParameterFact,
  type RequestBodyFact,
  type ResponseFact,
  type SecuritySchemeFact,
  type ServerFact,
} from "../types.js";

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

const IDEMPOTENT_METHODS = new Set([
  "get",
  "head",
  "put",
  "delete",
  "options",
  "trace",
]);
const MAX_INLINE_DEPTH = 6;

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Resolves a local JSON pointer ("#/components/schemas/Foo"). */
export function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = doc;
  for (const segment of ref.slice(2).split("/")) {
    const token = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(current) || !(token in current)) return undefined;
    current = current[token];
  }
  return current;
}

/**
 * Inlines internal $ref values so a subtree is self-contained. Cycles and the
 * depth budget collapse back to the original $ref string, keeping output finite.
 */
function inlineRefs(
  node: unknown,
  root: Record<string, any>,
  seen: Set<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > MAX_INLINE_DEPTH) return node;
  if (isObject(node)) {
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (seen.has(ref)) return { $ref: ref };
      const target = resolvePointer(root, ref);
      if (target === undefined) return node;
      const nextSeen = new Set(seen).add(ref);
      return inlineRefs(target, root, nextSeen, depth + 1);
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      output[key] = inlineRefs(value, root, seen, depth + 1);
    }
    return output;
  }
  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, root, seen, depth + 1));
  }
  return node;
}

function inferProtocol(operation: unknown, pathItem: unknown): string {
  const explicit =
    (isObject(operation) && operation["x-protocol"]) ||
    (isObject(pathItem) && pathItem["x-protocol"]);
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().toLowerCase();
  }
  if ((isObject(operation) && operation["x-grpc"]) || (isObject(pathItem) && pathItem["x-grpc"])) {
    return "grpc";
  }
  if ((isObject(operation) && operation["x-graphql"]) || (isObject(pathItem) && pathItem["x-graphql"])) {
    return "graphql";
  }
  if ((isObject(operation) && operation["x-mcp"]) || (isObject(pathItem) && pathItem["x-mcp"])) {
    return "mcp";
  }
  if ((isObject(operation) && (operation["x-ws"] || operation["x-websocket"])) ||
      (isObject(pathItem) && pathItem["x-ws"])) {
    return "websocket";
  }
  const responses = isObject(operation) ? operation.responses : undefined;
  for (const response of Object.values(isObject(responses) ? responses : {})) {
    if (isObject(response) && response.content?.["text/event-stream"]) {
      return "sse";
    }
  }
  return "http";
}

interface OperationEntry {
  method: string;
  path: string;
  pathItem: Record<string, any>;
  operation: Record<string, any>;
  protocol: string;
}

function iterateOperations(doc: Record<string, any>): OperationEntry[] {
  const paths = isObject(doc.paths) ? doc.paths : {};
  const entries: OperationEntry[] = [];
  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!isObject(rawPathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = rawPathItem[method];
      if (!isObject(operation)) continue;
      entries.push({
        method: method.toUpperCase(),
        path,
        pathItem: rawPathItem,
        operation,
        protocol: inferProtocol(operation, rawPathItem),
      });
    }
  }
  return entries;
}

function mergeParameters(entry: OperationEntry): Record<string, any>[] {
  const merged = new Map<string, Record<string, any>>();
  for (const parameter of asArray<Record<string, any>>(entry.pathItem.parameters)) {
    if (isObject(parameter) && parameter.name && parameter.in) {
      merged.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  for (const parameter of asArray<Record<string, any>>(entry.operation.parameters)) {
    if (isObject(parameter) && parameter.name && parameter.in) {
      merged.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  return [...merged.values()];
}

function effectiveSecurity(
  doc: Record<string, any>,
  operation: Record<string, any>,
): Record<string, string[]>[] {
  const source = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(doc.security)
      ? doc.security
      : [];
  return source.filter(isObject).map((requirement) => {
    const scopes: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(requirement)) {
      scopes[name] = Array.isArray(value) ? value.map(String) : [];
    }
    return scopes;
  });
}

function buildSecuritySchemes(
  doc: Record<string, any>,
): SecuritySchemeFact[] {
  const schemes = isObject(doc.components?.securitySchemes)
    ? doc.components.securitySchemes
    : {};
  const result: SecuritySchemeFact[] = [];
  for (const [name, rawScheme] of Object.entries(schemes)) {
    const scheme = isObject(rawScheme) ? rawScheme : {};
    const flows: Record<string, string[]> = {};
    if (isObject(scheme.flows)) {
      for (const [flowName, flow] of Object.entries(scheme.flows)) {
        if (isObject(flow) && isObject(flow.scopes)) {
          flows[flowName] = Object.keys(flow.scopes);
        }
      }
    }
    const fact: SecuritySchemeFact = {
      name,
      type: typeof scheme.type === "string" ? scheme.type : "unknown",
      flows,
    };
    if (text(scheme.scheme)) fact.scheme = scheme.scheme;
    if (text(scheme.bearerFormat)) fact.bearerFormat = scheme.bearerFormat;
    if (text(scheme.in)) fact.in = scheme.in;
    if (text(scheme.name)) fact.parameterName = scheme.name;
    if (text(scheme.openIdConnectUrl)) fact.openIdConnectUrl = scheme.openIdConnectUrl;
    result.push(fact);
  }
  return result;
}

function buildServers(servers: unknown): ServerFact[] {
  return asArray<Record<string, any>>(servers)
    .filter((server) => typeof server?.url === "string")
    .map((server) => ({
      url: server.url,
      ...(text(server.description) ? { description: server.description } : {}),
      variables: isObject(server.variables) ? Object.keys(server.variables) : [],
    }));
}

function compactOperation(
  doc: Record<string, any>,
  entry: OperationEntry,
): CompactOperation {
  const parameters = mergeParameters(entry);
  const responses = isObject(entry.operation.responses)
    ? entry.operation.responses
    : {};
  return {
    ref: `${entry.method} ${entry.path}`,
    ...(text(entry.operation.operationId)
      ? { operationId: entry.operation.operationId }
      : {}),
    method: entry.method,
    path: entry.path,
    ...(text(entry.operation.summary) ? { summary: entry.operation.summary } : {}),
    tags: asArray<string>(entry.operation.tags).filter((t) => typeof t === "string"),
    secured: effectiveSecurity(doc, entry.operation).length > 0,
    statusCodes: Object.keys(responses),
    hasParameters: parameters.length > 0,
    hasRequestBody: isObject(entry.operation.requestBody),
    protocol: entry.protocol,
  };
}

export function overview(doc: Record<string, any>): OverviewFact {
  const entries = iterateOperations(doc);
  const tagSet = new Set<string>();
  const protocols = new Set<string>();
  for (const entry of entries) {
    for (const tag of asArray<string>(entry.operation.tags)) {
      if (typeof tag === "string") tagSet.add(tag);
    }
    protocols.add(entry.protocol);
  }
  const schemas = isObject(doc.components?.schemas) ? doc.components.schemas : {};
  return {
    title: text(doc.info?.title) ?? "Untitled API",
    version: text(doc.info?.version) ?? "0.0.0",
    ...(text(doc.info?.description) ? { description: doc.info.description } : {}),
    ...(text(doc.openapi) ? { openapiVersion: doc.openapi } : {}),
    servers: buildServers(doc.servers),
    endpointCount: entries.length,
    tags: [...tagSet].sort(),
    protocols: [...protocols].sort(),
    schemaCount: Object.keys(schemas).length,
    securitySchemes: buildSecuritySchemes(doc),
  };
}

export interface ListOptions {
  tag?: string;
  method?: string;
  protocol?: string;
  secured?: boolean;
  search?: string;
  pageSize?: number;
  cursor?: string;
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { offset?: number };
    return Number.isInteger(decoded.offset) && (decoded.offset ?? 0) >= 0
      ? (decoded.offset ?? 0)
      : 0;
  } catch {
    throw new FactError("invalid_cursor", "The pagination cursor is malformed.");
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function listOperations(
  doc: Record<string, any>,
  options: ListOptions = {},
): PagedOperations {
  const methodFilter = options.method?.trim().toUpperCase();
  const protocolFilter = options.protocol?.trim().toLowerCase();
  const tagFilter = options.tag?.trim().toLowerCase();
  const needle = options.search?.trim().toLowerCase();
  const secured = options.secured;

  const filtered = iterateOperations(doc)
    .map((entry) => compactOperation(doc, entry))
    .filter((op) => {
      if (methodFilter && op.method !== methodFilter) return false;
      if (protocolFilter && op.protocol !== protocolFilter) return false;
      if (tagFilter && !op.tags.some((tag) => tag.toLowerCase() === tagFilter)) {
        return false;
      }
      if (secured !== undefined && op.secured !== secured) return false;
      if (needle) {
        const haystack = [
          op.ref,
          op.operationId ?? "",
          op.summary ?? "",
          op.path,
          op.tags.join(" "),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

  const total = filtered.length;
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 500);
  const offset = decodeCursor(options.cursor);
  const page = filtered.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    items: page,
    total,
    ...(nextOffset < total ? { nextCursor: encodeCursor(nextOffset) } : {}),
  };
}

function findEntry(
  doc: Record<string, any>,
  locator: OperationLocator,
): OperationEntry {
  const entries = iterateOperations(doc);
  let match: OperationEntry | undefined;
  if (locator.operationId) {
    match = entries.find(
      (entry) => entry.operation.operationId === locator.operationId,
    );
  } else if (locator.method && locator.path) {
    const method = locator.method.trim().toUpperCase();
    match = entries.find(
      (entry) =>
        entry.method === method && entry.path === locator.path!.trim(),
    );
  } else if (locator.ref) {
    match = entries.find((entry) => `${entry.method} ${entry.path}` === locator.ref!.trim());
  }
  if (!match) {
    throw new FactError(
      "operation_not_found",
      `No operation matches ${
        locator.ref ??
        locator.operationId ??
        `${locator.method ?? ""} ${locator.path ?? ""}`.trim()
      }.`,
    );
  }
  return match;
}

function buildMedia(
  content: Record<string, any>,
  root: Record<string, any>,
): Record<string, MediaFact> {
  const output: Record<string, MediaFact> = {};
  for (const [mediaType, media] of Object.entries(content)) {
    if (!isObject(media)) continue;
    const fact: MediaFact = {
      schema: media.schema ? inlineRefs(media.schema, root) : {},
      examples: isObject(media.examples) ? Object.keys(media.examples) : [],
    };
    if ("example" in media) fact.example = media.example;
    output[mediaType] = fact;
  }
  return output;
}

export function getOperation(
  doc: Record<string, any>,
  rawDoc: Record<string, any>,
  locator: OperationLocator,
): OperationFact {
  const entry = findEntry(doc, locator);
  const { operation, method, path } = entry;

  const parameters: ParameterFact[] = mergeParameters(entry)
    .map((parameter) => {
      const location = parameter.in as ParameterFact["in"];
      const fact: ParameterFact = {
        name: String(parameter.name),
        in: location,
        required:
          location === "path" ? true : Boolean(parameter.required),
        deprecated: Boolean(parameter.deprecated),
        schema:
          (parameter.schema
            ? (inlineRefs(parameter.schema, rawDoc) as Record<string, unknown>)
            : {}) as Record<string, unknown>,
      };
      if (text(parameter.description)) fact.description = parameter.description;
      if ("example" in parameter) fact.example = parameter.example;
      return fact;
    })
    .sort((a, b) => {
      // Path parameters first, then required, then alphabetical.
      if ((a.in === "path") !== (b.in === "path")) return a.in === "path" ? -1 : 1;
      if (a.required !== b.required) return a.required ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  let requestBody: RequestBodyFact | undefined;
  if (isObject(operation.requestBody) && isObject(operation.requestBody.content)) {
    requestBody = {
      required: Boolean(operation.requestBody.required),
      ...(text(operation.requestBody.description)
        ? { description: operation.requestBody.description }
        : {}),
      content: buildMedia(operation.requestBody.content, rawDoc),
    };
  }

  const responses: ResponseFact[] = Object.entries(
    isObject(operation.responses) ? operation.responses : {},
  ).map(([status, rawResponse]) => {
    const response = isObject(rawResponse) ? rawResponse : {};
    const headers: HeaderFact[] = [];
    for (const [name, rawHeader] of Object.entries(
      isObject(response.headers) ? response.headers : {},
    )) {
      const header = isObject(rawHeader) ? rawHeader : {};
      headers.push({
        name,
        required: Boolean(header.required),
        ...(text(header.description) ? { description: header.description } : {}),
        schema: (header.schema
          ? (inlineRefs(header.schema, rawDoc) as Record<string, unknown>)
          : {}) as Record<string, unknown>,
      });
    }
    return {
      status,
      ...(text(response.description) ? { description: response.description } : {}),
      headers,
      content: isObject(response.content)
        ? buildMedia(response.content, rawDoc)
        : {},
    };
  });

  const requirements = effectiveSecurity(doc, operation);
  const schemes = buildSecuritySchemes(doc);
  const requiredNames = new Set(requirements.flatMap((requirement) => Object.keys(requirement)));
  const security = schemes.filter((scheme) => requiredNames.has(scheme.name));

  return {
    ref: `${method} ${path}`,
    ...(text(operation.operationId) ? { operationId: operation.operationId } : {}),
    method,
    path,
    ...(text(operation.summary) ? { summary: operation.summary } : {}),
    ...(text(operation.description) ? { description: operation.description } : {}),
    tags: asArray<string>(operation.tags).filter((t) => typeof t === "string"),
    deprecated: Boolean(operation.deprecated),
    idempotent: IDEMPOTENT_METHODS.has(method.toLowerCase()),
    protocol: entry.protocol,
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    security,
    servers: buildServers(operation.servers ?? doc.servers),
  };
}

export interface SchemaLocator {
  name?: string;
  ref?: string;
}

export function getSchema(
  doc: Record<string, any>,
  rawDoc: Record<string, any>,
  locator: SchemaLocator,
): { name?: string; schema: unknown } {
  let schema: unknown;
  let name: string | undefined;
  if (locator.ref) {
    schema = resolvePointer(rawDoc, locator.ref);
    const segments = locator.ref.split("/");
    name = segments[segments.length - 1];
  } else if (locator.name) {
    name = locator.name;
    schema = rawDoc.components?.schemas?.[locator.name];
  }
  if (schema === undefined) {
    throw new FactError(
      "schema_not_found",
      `No schema matches ${locator.ref ?? locator.name ?? "(empty locator)"}.`,
    );
  }
  return {
    ...(name ? { name } : {}),
    schema: inlineRefs(schema, rawDoc),
  };
}

export function authRequirements(
  doc: Record<string, any>,
  locator?: OperationLocator,
): { global: SecuritySchemeFact[]; operation?: SecuritySchemeFact[] } {
  const global = buildSecuritySchemes(doc).filter((scheme) =>
    (doc.security ?? []).some(
      (requirement: unknown) => isObject(requirement) && scheme.name in requirement,
    ),
  );
  if (!locator) return { global };
  const operation = getOperation(doc, doc, locator);
  return { global, operation: operation.security };
}
