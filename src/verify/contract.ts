/**
 * Batch contract verification against a running backend.
 *
 * Mirrors openapi-cli's runTests but executes against the in-memory live
 * document so the MCP never depends on a stale file on disk.
 */

import {
  buildSummary,
  collectOperations,
  executeStep,
  type TestReport,
  type TestResult,
} from "@powerduck/openapi-cli";
import { createClient } from "@powerduck/openapi-request";
import type { SpecSnapshot } from "../spec/store.js";
import { FactError } from "../types.js";
import { buildRunnerConfig, type ProgressSink, type RunOverrides } from "./config.js";

export interface ContractFilter {
  methods?: string[];
  paths?: string[];
  tags?: string[];
  operationIds?: string[];
}

export interface ContractSuiteResult {
  summary: TestReport["summary"];
  results: TestResult[];
  generatedAt: string;
  version: string;
}

import packageJson from "../../package.json";
const VERSION = packageJson.version;

function asStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new FactError("invalid_arguments", `${field} must be an array of strings.`);
  }
  return value as string[];
}

export function contractFilterFromArgs(args: Record<string, unknown>): ContractFilter {
  const filter: ContractFilter = {};
  const methods = asStringList(args.methods, "methods");
  if (methods) filter.methods = methods.map((m) => m.toLowerCase());
  const paths = asStringList(args.paths, "paths");
  if (paths) filter.paths = paths;
  const tags = asStringList(args.tags, "tags");
  if (tags) filter.tags = tags;
  const operationIds = asStringList(args.operationIds, "operationIds");
  if (operationIds) filter.operationIds = operationIds;
  return filter;
}

export async function runContractSuite(
  snapshot: SpecSnapshot,
  overrides: RunOverrides,
  filter: ContractFilter,
  sink: ProgressSink = {},
): Promise<ContractSuiteResult> {
  const config = buildRunnerConfig(snapshot, overrides);
  if (Object.keys(filter).length) config.filter = filter;
  const operations = collectOperations(snapshot.dereferenced, config);
  if (operations.length === 0) {
    throw new FactError(
      "no_operations",
      "No operations match the current specification and filter.",
    );
  }

  const client = createClient();
  const concurrency = Math.max(1, Math.min(config.concurrency ?? 5, operations.length));
  let nextIndex = 0;
  const results: TestResult[] = [];
  const startedAt = Date.now();
  let cancelled = false;

  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < operations.length) {
      if (sink.signal?.aborted) {
        cancelled = true;
        return;
      }
      const op = operations[nextIndex++];
      if (!op) return;
      const stepOptions: Parameters<typeof executeStep>[2] = {
        config,
        spec: snapshot.dereferenced,
      };
      if (config.variables) stepOptions.variables = config.variables;
      if (sink.signal) stepOptions.signal = sink.signal;
      const execution = await executeStep(client, op, stepOptions);
      results.push(execution.result);
      if (sink.signal?.aborted) cancelled = true;
      sink.report?.(results.length, operations.length, `${op.method.toUpperCase()} ${op.path}`);
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const summary = buildSummary(results, Date.now() - startedAt);
  if (cancelled) {
    summary.skipped += operations.length - results.length;
    summary.total = operations.length;
  }
  return {
    summary,
    results,
    generatedAt: new Date().toISOString(),
    version: VERSION,
  };
}
