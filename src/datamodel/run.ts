/**
 * Data-model tools: deterministic OpenAPI -> relational model reconciliation,
 * powered by @powerduck/datamodel.
 *
 * The MCP server itself never connects to a database and never accepts
 * credentials. A coding agent may, however, pass read-only live evidence
 * (tables, columns, enforced foreign keys) that it gathered out-of-band, and
 * the same deterministic engine produces a bidirectional reconciliation:
 * modeled tables missing from the database, drifting tables, live tables the
 * API does not describe, and the additive SQL to converge them.
 *
 * Everything here is a pure function over the parsed specification; the tool
 * registration in mcp/tools.ts only maps MCP arguments onto these helpers.
 */

import {
  buildDeploymentScript,
  buildMermaidErDiagram,
  buildReconciliation,
  exportReconciliationMarkdown,
  extractEntities,
  type DataModelReconciliation,
  type DeploymentResult,
  type DialectId,
  type LiveForeignKey,
  type LiveTable,
  type TableNameOverrides,
} from "@powerduck/datamodel";
import { FactError } from "../types.js";

const DIALECT_IDS: readonly DialectId[] = ["mysql", "sqlserver", "oracle"];
const MAX_LIVE_TABLES = 1000;
const MAX_LIVE_COLUMNS = 1000;
const MAX_LIVE_FOREIGN_KEYS = 5000;
const MAX_SAMPLE_ROWS = 50;

export interface DataModelInputs {
  dialectId: DialectId;
  liveTables?: LiveTable[];
  liveForeignKeys?: LiveForeignKey[];
  overrides?: TableNameOverrides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeDialect(value: unknown): DialectId {
  if (value === undefined || value === null) return "mysql";
  if (typeof value !== "string" || !DIALECT_IDS.includes(value as DialectId)) {
    throw new FactError(
      "invalid_arguments",
      `dialect must be one of ${DIALECT_IDS.join(", ")}.`,
    );
  }
  return value as DialectId;
}

function normalizeOverrides(value: unknown): TableNameOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new FactError("invalid_arguments", "tableNameOverrides must be an object.");
  }
  const overrides: TableNameOverrides = {};
  for (const [key, val] of Object.entries(value)) {
    if (nonEmptyString(key) && nonEmptyString(val)) {
      overrides[key] = String(val).trim();
    }
  }
  return Object.keys(overrides).length ? overrides : undefined;
}

function normalizeLiveTables(value: unknown): LiveTable[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new FactError("invalid_arguments", "liveTables must be an array.");
  }
  if (value.length > MAX_LIVE_TABLES) {
    throw new FactError(
      "invalid_arguments",
      `liveTables supports at most ${MAX_LIVE_TABLES} entries.`,
    );
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || !nonEmptyString(entry.name)) {
      throw new FactError(
        "invalid_arguments",
        `liveTables[${index}].name is required.`,
      );
    }
    const rawColumns = Array.isArray(entry.columns) ? entry.columns : [];
    if (rawColumns.length > MAX_LIVE_COLUMNS) {
      throw new FactError(
        "invalid_arguments",
        `liveTables[${index}].columns supports at most ${MAX_LIVE_COLUMNS} entries.`,
      );
    }
    const columns = rawColumns.map((col, columnIndex) => {
      if (!isRecord(col) || !nonEmptyString(col.name)) {
        throw new FactError(
          "invalid_arguments",
          `liveTables[${index}].columns[${columnIndex}].name is required.`,
        );
      }
      return {
        name: String(col.name).trim(),
        ...(nonEmptyString(col.dataType) ? { dataType: String(col.dataType).trim() } : {}),
        ...(typeof col.nullable === "boolean" ? { nullable: col.nullable } : {}),
        ...(typeof col.isPrimaryKey === "boolean"
          ? { isPrimaryKey: col.isPrimaryKey }
          : {}),
      };
    });
    return {
      name: String(entry.name).trim(),
      ...(nonEmptyString(entry.schema) ? { schema: String(entry.schema).trim() } : {}),
      columns,
    };
  });
}

function normalizeLiveForeignKeys(value: unknown): LiveForeignKey[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new FactError("invalid_arguments", "liveForeignKeys must be an array.");
  }
  if (value.length > MAX_LIVE_FOREIGN_KEYS) {
    throw new FactError(
      "invalid_arguments",
      `liveForeignKeys supports at most ${MAX_LIVE_FOREIGN_KEYS} entries.`,
    );
  }
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.table) ||
      !nonEmptyString(entry.column) ||
      !nonEmptyString(entry.refTable) ||
      !nonEmptyString(entry.refColumn)
    ) {
      throw new FactError(
        "invalid_arguments",
        `liveForeignKeys[${index}] requires non-empty table, column, refTable, refColumn strings.`,
      );
    }
    return {
      table: String(entry.table).trim(),
      column: String(entry.column).trim(),
      refTable: String(entry.refTable).trim(),
      refColumn: String(entry.refColumn).trim(),
    };
  });
}

function normalizeSampleRows(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FactError(
      "invalid_arguments",
      "sampleRows must be a non-negative integer.",
    );
  }
  return Math.min(value, MAX_SAMPLE_ROWS);
}

/** Validate and normalize the shared data-model tool arguments. */
export function normalizeDataModelInputs(
  args: Record<string, unknown>,
): DataModelInputs {
  const liveTables = normalizeLiveTables(args.liveTables);
  const liveForeignKeys = normalizeLiveForeignKeys(args.liveForeignKeys);
  const overrides = normalizeOverrides(args.tableNameOverrides);
  return {
    dialectId: normalizeDialect(args.dialect),
    ...(liveTables !== undefined ? { liveTables } : {}),
    ...(liveForeignKeys !== undefined ? { liveForeignKeys } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
  };
}

/**
 * Build the full, versioned reconciliation artifact from the raw specification
 * (internal $ref values must be intact) and optional live evidence.
 */
export function reconcileDataModel(
  doc: unknown,
  args: Record<string, unknown>,
): DataModelReconciliation {
  const input = normalizeDataModelInputs(args);
  const hasLive = Array.isArray(input.liveTables);
  return buildReconciliation({
    doc,
    dialectId: input.dialectId,
    ...(hasLive
      ? { liveTables: input.liveTables as LiveTable[], liveForeignKeys: input.liveForeignKeys ?? [] }
      : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
  });
}

export interface DataModelReport {
  dialect: DialectId;
  summary: DataModelReconciliation["summary"];
  /** Standalone Mermaid erDiagram source. */
  mermaid: string;
  /** Self-contained human/agent brief embedding the Mermaid diagram. */
  markdown: string;
}

/** Build the human-facing Markdown brief and its Mermaid erDiagram. */
export function dataModelReport(
  doc: unknown,
  args: Record<string, unknown>,
): DataModelReport {
  const reconciliation = reconcileDataModel(doc, args);
  return {
    dialect: reconciliation.dialect,
    summary: reconciliation.summary,
    mermaid: buildMermaidErDiagram(reconciliation),
    markdown: exportReconciliationMarkdown(reconciliation),
  };
}

export interface DataModelDeployment extends DeploymentResult {
  dialect: DialectId;
}

/**
 * Build one reviewable forward-only deployment script for a fresh database:
 * CREATE TABLE statements in foreign-key order, secondary indexes, and
 * (optionally) deterministic sample rows. Generated only; never executed.
 */
export function dataModelDeploymentScript(
  doc: unknown,
  args: Record<string, unknown>,
): DataModelDeployment {
  const input = normalizeDataModelInputs(args);
  const sampleRows = normalizeSampleRows(args.sampleRows);
  const entities = extractEntities(doc);
  const result = buildDeploymentScript(input.dialectId, entities, {
    ifNotExists: true,
    ...(input.overrides ? { overrides: input.overrides } : {}),
    sampleRows,
  });
  return { ...result, dialect: input.dialectId };
}
