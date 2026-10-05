/**
 * Single-operation verification: send one request to the local backend and
 * report the normalized response plus spec-derived assertion results.
 */

import {
  createClient,
  type RequestValues,
} from "@powerduck/openapi-request";
import {
  executeStep,
  type DeclarativeAssertion,
  type TestResult,
} from "@powerduck/openapi-cli";
import type { SpecSnapshot } from "../spec/store.js";
import type { OperationLocator } from "../types.js";
import { buildRunnerConfig, type RunOverrides } from "./config.js";
import { locateOperation } from "./operations.js";

export interface SendInput {
  values?: RequestValues;
  variables?: Record<string, string>;
  assertions?: DeclarativeAssertion[];
  /** Per-call target override; wins over the configured base URL. */
  baseUrl?: string;
}

function asRequestValues(value: unknown): RequestValues | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("values must be an object with path/query/header/body keys.");
  }
  return value as RequestValues;
}

function asAssertions(value: unknown): DeclarativeAssertion[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("assertions must be an array.");
  }
  return value.filter((item): item is DeclarativeAssertion => {
    return !!item && typeof item === "object" && typeof (item as DeclarativeAssertion).assert === "string";
  });
}

export async function sendOne(
  snapshot: SpecSnapshot,
  overrides: RunOverrides,
  locator: OperationLocator,
  input: SendInput,
): Promise<TestResult> {
  const config = buildRunnerConfig(snapshot, {
    ...overrides,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  });
  const op = locateOperation(snapshot, locator);
  const client = createClient();
  const options: Parameters<typeof executeStep>[2] = {
    config,
    spec: snapshot.dereferenced,
  };
  const values = asRequestValues(input.values);
  if (values) options.values = values;
  if (input.variables) options.variables = input.variables;
  const assertions = asAssertions(input.assertions);
  if (assertions) options.extraAssertions = assertions;
  if (input.baseUrl) options.serverUrl = input.baseUrl;
  const execution = await executeStep(client, op, options);
  return execution.result;
}
