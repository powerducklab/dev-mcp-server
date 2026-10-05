import { collectOperations, type CliConfig } from "@powerduck/openapi-cli";
import type { SpecSnapshot } from "../spec/store.js";
import { FactError, type OperationLocator } from "../types.js";

export type OperationInfo = ReturnType<typeof collectOperations>[number];

const EMPTY_CONFIG = {} as CliConfig;

/** All operations in the live document, ignoring any batch filter. */
export function allOperations(snapshot: SpecSnapshot): OperationInfo[] {
  return collectOperations(snapshot.dereferenced, EMPTY_CONFIG);
}

/** Resolves one operation for execution using the same locator rules as facts. */
export function locateOperation(
  snapshot: SpecSnapshot,
  locator: OperationLocator,
): OperationInfo {
  const operations = allOperations(snapshot);
  let match: OperationInfo | undefined;
  if (locator.operationId) {
    match = operations.find((op) => op.operationId === locator.operationId);
  } else if (locator.method && locator.path) {
    const method = locator.method.toUpperCase();
    match = operations.find(
      (op) => op.method.toUpperCase() === method && op.path === locator.path,
    );
  } else if (locator.ref) {
    match = operations.find(
      (op) => `${op.method.toUpperCase()} ${op.path}` === locator.ref!.trim(),
    );
  }
  if (!match) {
    throw new FactError(
      "operation_not_found",
      `No executable operation matches ${
        locator.ref ??
        locator.operationId ??
        `${locator.method ?? ""} ${locator.path ?? ""}`.trim()
      }.`,
    );
  }
  return match;
}
