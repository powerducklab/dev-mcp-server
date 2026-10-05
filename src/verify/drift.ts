/**
 * Drift detection: compares the running implementation with the specification.
 *
 * The contract suite already exercises every operation; drift detection adds
 * the classification a developer acts on:
 * - missing: the server answers 404/405, the operation is not implemented;
 * - unreachable: the connection itself failed;
 * - contract_violation: the endpoint responded but broke status/schema/assertions;
 * - spec_issue: the specification itself is invalid.
 */

import type { TestResult } from "@powerduck/openapi-cli";
import type { SpecSnapshot } from "../spec/store.js";
import type { ProgressSink, RunOverrides } from "./config.js";
import {
  contractFilterFromArgs,
  runContractSuite,
  type ContractFilter,
} from "./contract.js";

export type DriftKind = "missing" | "unreachable" | "contract_violation";

export interface DriftItem {
  ref: string;
  operationId: string;
  kind: DriftKind;
  responseStatus?: number;
  reasons: string[];
}

export interface DriftReport {
  generatedAt: string;
  baseUrl: string | undefined;
  driftLevel: "none" | "low" | "high";
  summary: {
    total: number;
    conforming: number;
    missing: number;
    contractViolations: number;
    unreachable: number;
    skipped: number;
    specIssues: number;
  };
  drift: DriftItem[];
  specIssues: Array<{ message: string; path?: string }>;
}

const MAX_SPEC_ISSUES = 20;
const MISSING_STATUSES = new Set([404, 405]);

function refOf(result: TestResult): string {
  return `${result.method.toUpperCase()} ${result.path}`;
}

function classify(result: TestResult): DriftItem | null {
  if (result.status === "passed") return null;
  if (result.status === "skipped") return null;

  const responseStatus = result.response?.status;
  if (
    result.status === "error" ||
    responseStatus === 0 ||
    (!responseStatus && result.error)
  ) {
    return {
      ref: refOf(result),
      operationId: result.operationId,
      kind: "unreachable",
      ...(responseStatus ? { responseStatus } : {}),
      reasons: [result.error ?? "Request failed without a response."],
    };
  }
  if (responseStatus && MISSING_STATUSES.has(responseStatus)) {
    return {
      ref: refOf(result),
      operationId: result.operationId,
      kind: "missing",
      responseStatus,
      reasons: [
        `Server responded ${responseStatus}: the operation is not implemented or not routed.`,
      ],
    };
  }

  const reasons: string[] = [];
  for (const assertion of result.assertions ?? []) {
    if (!assertion.passed) {
      reasons.push(
        assertion.error ? `${assertion.name}: ${assertion.error}` : assertion.name,
      );
    }
  }
  if (result.error) reasons.push(result.error);
  if (reasons.length === 0) {
    reasons.push(
      `Response ${responseStatus ?? "without status"} does not satisfy the specification.`,
    );
  }
  return {
    ref: refOf(result),
    operationId: result.operationId,
    kind: "contract_violation",
    ...(responseStatus ? { responseStatus } : {}),
    reasons,
  };
}

export async function detectDrift(
  snapshot: SpecSnapshot,
  overrides: RunOverrides,
  filter: ContractFilter,
  sink: ProgressSink = {},
): Promise<DriftReport> {
  const suite = await runContractSuite(snapshot, overrides, filter, sink);

  const drift: DriftItem[] = [];
  let conforming = 0;
  let skipped = 0;
  for (const result of suite.results) {
    if (result.status === "passed") {
      conforming += 1;
      continue;
    }
    if (result.status === "skipped") {
      skipped += 1;
      continue;
    }
    const item = classify(result);
    if (item) drift.push(item);
  }

  const validation = snapshot.validation;
  const specIssues =
    validation && !validation.valid
      ? validation.issues
          .filter(
            (issue) =>
              issue.severity === "error" && typeof issue.message === "string",
          )
          .slice(0, MAX_SPEC_ISSUES)
          .map((issue) => ({
            message: issue.message,
            ...(typeof issue.path === "string" ? { path: issue.path } : {}),
          }))
      : [];

  const missing = drift.filter((item) => item.kind === "missing").length;
  const unreachable = drift.filter((item) => item.kind === "unreachable").length;
  const contractViolations = drift.filter(
    (item) => item.kind === "contract_violation",
  ).length;
  const blocking = missing + unreachable + specIssues.length;
  const driftLevel: DriftReport["driftLevel"] =
    blocking > 0 ? "high" : contractViolations > 0 ? "low" : "none";

  return {
    generatedAt: new Date().toISOString(),
    baseUrl: overrides.baseUrl,
    driftLevel,
    summary: {
      total: suite.results.length,
      conforming,
      missing,
      contractViolations,
      unreachable,
      skipped,
      specIssues: specIssues.length,
    },
    drift,
    specIssues,
  };
}

export { contractFilterFromArgs };
