/**
 * Public fact shapes returned by the developer MCP.
 *
 * These are stable, JSON-serializable contracts handed to AI coding agents.
 * Schema fragments are passed through as plain JSON Schema objects; the MCP
 * does not invent fields the specification does not declare.
 */

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace";

export interface ServerFact {
  url: string;
  description?: string;
  /** Names of variables the server URL still requires. */
  variables: string[];
}

export interface SecuritySchemeFact {
  name: string;
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  parameterName?: string;
  openIdConnectUrl?: string;
  /** OAuth2 flow names and the scopes each declares. */
  flows: Record<string, string[]>;
}

export interface CompactOperation {
  /** Stable reference, e.g. "POST /orders". */
  ref: string;
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  tags: string[];
  /** A non-empty security requirement applies to this operation. */
  secured: boolean;
  statusCodes: string[];
  hasParameters: boolean;
  hasRequestBody: boolean;
  protocol: string;
}

export interface ParameterFact {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  deprecated: boolean;
  /** Compact JSON Schema describing the parameter value. */
  schema: Record<string, unknown>;
  example?: unknown;
}

export interface MediaFact {
  /** Dereferenced JSON Schema for the payload. */
  schema: unknown;
  example?: unknown;
  /** Named examples declared by the specification. */
  examples: string[];
}

export interface HeaderFact {
  name: string;
  required: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

export interface ResponseFact {
  status: string;
  description?: string;
  headers: HeaderFact[];
  content: Record<string, MediaFact>;
}

export interface RequestBodyFact {
  required: boolean;
  description?: string;
  content: Record<string, MediaFact>;
}

export interface OperationFact {
  ref: string;
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  idempotent: boolean;
  protocol: string;
  parameters: ParameterFact[];
  requestBody?: RequestBodyFact;
  responses: ResponseFact[];
  /** Effective security requirements after operation-level overrides. */
  security: SecuritySchemeFact[];
  servers: ServerFact[];
}

export type IssueSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  message: string;
  severity: IssueSeverity;
  path?: string;
}

export interface ValidationFact {
  valid: boolean;
  openapiVersion?: string;
  issues: ValidationIssue[];
}

export interface OverviewFact {
  title: string;
  version: string;
  description?: string;
  openapiVersion?: string;
  servers: ServerFact[];
  endpointCount: number;
  tags: string[];
  protocols: string[];
  schemaCount: number;
  securitySchemes: SecuritySchemeFact[];
}

export interface PagedOperations {
  items: CompactOperation[];
  total: number;
  nextCursor?: string;
}

export interface OperationLocator {
  /** "METHOD /path" reference. */
  ref?: string;
  operationId?: string;
  method?: string;
  path?: string;
}

/** A failed tool call whose cause is the caller's input, not the server. */
export class FactError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "FactError";
    this.code = code;
    this.details = details;
  }
}
