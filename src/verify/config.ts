/**
 * Builds the @powerduck/openapi-cli runner configuration for a verification
 * request. Fact tools read an in-memory document; the runner also needs a real
 * spec path (used as an identifier and fallback loader), which the SpecStore
 * always has.
 */

import {
  resolveConfig,
  type AuthConfig,
  type CliConfig,
} from "@powerduck/openapi-cli";
import type { SpecSnapshot } from "../spec/store.js";

export interface RunOverrides {
  baseUrl?: string;
  timeoutMs?: number;
  concurrency?: number;
  headers?: Record<string, string>;
  variables?: Record<string, string>;
  proxy?: string;
  auth?: AuthConfig;
}

export interface ProgressSink {
  /** Emit MCP $/progress when a progress token was supplied by the client. */
  report?: (progress: number, total: number, message?: string) => void;
  /** Cancellation propagated from notifications/cancelled. */
  signal?: AbortSignal;
}

function toKeyValuePairs(
  record: Record<string, string> | undefined,
  separator: string,
): string[] | undefined {
  if (!record) return undefined;
  const entries = Object.entries(record).map(
    ([key, value]) => `${key}${separator}${value}`,
  );
  return entries.length ? entries : undefined;
}

export function buildRunnerConfig(
  snapshot: SpecSnapshot,
  overrides: RunOverrides,
): CliConfig {
  const args: Record<string, unknown> = { spec: snapshot.path };
  if (overrides.baseUrl) args.server = overrides.baseUrl;
  if (overrides.timeoutMs) args.timeout = overrides.timeoutMs;
  if (overrides.concurrency) args.concurrency = overrides.concurrency;
  if (overrides.proxy) args.proxy = overrides.proxy;
  const header = toKeyValuePairs(overrides.headers, ":");
  if (header) args.header = header;
  const variable = toKeyValuePairs(overrides.variables, "=");
  if (variable) args.variable = variable;
  const config = resolveConfig(args as Parameters<typeof resolveConfig>[0]);
  // Tool calls return reports in the MCP response; never write report files.
  config.formats = [];
  config.outputDir = "";
  config.failOnError = false;
  if (overrides.auth) config.auth = overrides.auth;
  return config;
}

/** Resolves the target base URL from an explicit override or the spec servers. */
export function resolveBaseUrl(
  snapshot: SpecSnapshot,
  explicit: string | undefined,
): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const servers = snapshot.document.servers;
  if (Array.isArray(servers)) {
    for (const server of servers) {
      if (
        server &&
        typeof server.url === "string" &&
        server.url.trim() &&
        !server.url.includes("{")
      ) {
        return server.url.trim();
      }
    }
  }
  return undefined;
}

function asStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object of strings.`);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`${field}.${key} must be a string.`);
    }
    output[key] = item;
  }
  return output;
}

/** Maps raw tool arguments into typed runner overrides with validation. */
export function runOverridesFromArgs(
  snapshot: SpecSnapshot,
  args: Record<string, unknown>,
): RunOverrides {
  const baseUrl = resolveBaseUrl(
    snapshot,
    typeof args.baseUrl === "string" ? args.baseUrl : undefined,
  );
  const overrides: RunOverrides = {};
  if (baseUrl) overrides.baseUrl = baseUrl;
  if (typeof args.timeoutMs === "number") {
    overrides.timeoutMs = positiveInteger(args.timeoutMs, "timeoutMs", 30000, 1, 600000);
  }
  if (typeof args.concurrency === "number") {
    overrides.concurrency = positiveInteger(args.concurrency, "concurrency", 5, 1, 20);
  }
  const headers = asStringRecord(args.headers, "headers");
  if (headers) overrides.headers = headers;
  const variables = asStringRecord(args.variables, "variables");
  if (variables) overrides.variables = variables;
  if (typeof args.proxy === "string" && args.proxy.trim()) {
    overrides.proxy = args.proxy.trim();
  }
  return overrides;
}

export function positiveInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min) {
    throw new Error(`${field} must be a number >= ${min}.`);
  }
  return Math.min(Math.round(numberValue), max);
}
