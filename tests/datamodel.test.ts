import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SpecStore } from "../src/spec/store.js";
import { devTools, executeDevTool } from "../src/mcp/tools.js";
import {
  dataModelDeploymentScript,
  dataModelReport,
  reconcileDataModel,
} from "../src/datamodel/run.js";
import { FactError } from "../src/types.js";

const fixturePath = fileURLToPath(
  new URL(path.join("fixtures", "petstore.yaml"), import.meta.url),
);

function store() {
  return new SpecStore(fixturePath);
}

// A two-entity model with an object $ref (Order.customer -> Customer), which
// the engine turns into a foreign key.
const shopDoc = {
  openapi: "3.1.0",
  info: { title: "Shop", version: "1.0.0" },
  paths: {},
  components: {
    schemas: {
      Customer: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string", maxLength: 100 },
        },
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "integer" },
          total: { type: "number" },
          customer: { $ref: "#/components/schemas/Customer" },
        },
      },
    },
  },
};

describe("datamodel tool registration", () => {
  it("registers the three datamodel tools", () => {
    const names = devTools.map((tool) => tool.name);
    expect(names).toContain("datamodel_reconcile");
    expect(names).toContain("datamodel_report");
    expect(names).toContain("datamodel_deployment_script");
  });
});

describe("datamodel_reconcile (via MCP tool, petstore)", () => {
  it("builds a forward plan from the raw spec with $ref intact", async () => {
    const result = (await executeDevTool("datamodel_reconcile", {}, store())) as any;
    expect(result.summary.modeledTables).toBe(3);
    expect(result.dialect).toBe("mysql");
    expect(result.migrationPlan.every((step: any) => step.kind === "create_table")).toBe(true);
    expect(result.migrationPlan).toHaveLength(3);
    expect(result.openQuestions.some((q: any) => q.code === "no_live_database")).toBe(true);
  });

  it("renders a Markdown brief with an embedded Mermaid diagram", async () => {
    const result = (await executeDevTool("datamodel_report", {}, store())) as any;
    expect(result.markdown).toContain("Data Model Reconciliation");
    expect(result.markdown).toContain("```mermaid");
    expect(result.mermaid.startsWith("erDiagram")).toBe(true);
    expect(result.summary.modeledTables).toBe(3);
  });

  it("generates a forward-only deployment script, dialect-aware", async () => {
    const mysql = (await executeDevTool(
      "datamodel_deployment_script",
      {},
      store(),
    )) as any;
    expect(mysql.dialect).toBe("mysql");
    expect(mysql.tableCount).toBe(3);
    expect(mysql.insertRowCount).toBe(0);
    expect(mysql.sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(mysql.sql).not.toContain("INSERT");

    const sqlserver = (await executeDevTool(
      "datamodel_deployment_script",
      { dialect: "sqlserver", sampleRows: 2 },
      store(),
    )) as any;
    expect(sqlserver.dialect).toBe("sqlserver");
    expect(sqlserver.sql).toContain("[");
    expect(sqlserver.sql).toContain("INSERT");
    expect(sqlserver.insertRowCount).toBeGreaterThan(0);
  });
});

describe("reconcileDataModel relationships and live evidence", () => {
  it("derives a foreign key and orders creates by dependency", () => {
    const result = reconcileDataModel(shopDoc, {});
    expect(result.summary.modeledTables).toBe(2);
    expect(result.summary.relationships).toBe(1);
    const edge = result.relationships[0]!;
    expect(edge.fromTable).toBe("orders");
    expect(edge.toTable).toBe("customers");
    const customerStep = result.migrationPlan.find((s) => s.target === "customers");
    const orderStep = result.migrationPlan.find((s) => s.target === "orders");
    expect(customerStep!.order).toBeLessThan(orderStep!.order);
    expect(orderStep!.blockedBy).toContain(customerStep!.order);
  });

  it("treats an empty liveTables array as a connected empty database", () => {
    const result = reconcileDataModel(shopDoc, { liveTables: [] });
    expect(result.source.database?.connected).toBe(true);
    expect(result.summary.missing).toBe(2);
    expect(result.openQuestions.some((q) => q.code === "no_live_database")).toBe(false);
  });

  it("marks matched tables and enforces the edge when live FK evidence is given", () => {
    const liveTables = [
      {
        name: "customers",
        columns: [
          { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
          { name: "name", dataType: "varchar(100)", nullable: false },
        ],
      },
      {
        name: "orders",
        columns: [
          { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
          { name: "customer", dataType: "bigint", nullable: false },
          { name: "total", dataType: "decimal(18,4)", nullable: false },
        ],
      },
    ];
    const liveForeignKeys = [
      { table: "orders", column: "customer", refTable: "customers", refColumn: "id" },
    ];
    const result = reconcileDataModel(shopDoc, { liveTables, liveForeignKeys });
    expect(result.tables.map((t) => `${t.table}:${t.status}`).sort()).toEqual([
      "customers:matched",
      "orders:matched",
    ]);
    expect(result.summary.enforcedRelationships).toBe(1);
    const enforcedEdge = result.relationships[0]!;
    expect(enforcedEdge.enforced).toBe(true);
    expect(enforcedEdge.origin).toBe("both");
    // Matched tables with no live index catalog still surface review-only
    // index checks, never executable DDL. A fully matched/enforced schema must
    // therefore contain no actionable step and no CREATE TABLE step.
    expect(result.migrationPlan.every((step) => step.requiresReview)).toBe(true);
    expect(result.migrationPlan.some((step) => step.kind === "create_table")).toBe(false);
  });

  it("reports a live-only table as an orphan for reverse engineering", () => {
    const result = reconcileDataModel(shopDoc, {
      liveTables: [
        { name: "audit_log", columns: [{ name: "id", isPrimaryKey: true }] },
      ],
    });
    expect(result.orphanTables.map((o) => o.table)).toEqual(["audit_log"]);
    expect(result.openQuestions.some((q) => q.code === "table_not_in_model")).toBe(true);
  });
});

describe("data-model argument validation", () => {
  it("rejects an unsupported dialect", () => {
    expect(() => reconcileDataModel(shopDoc, { dialect: "sqlite" as never })).toThrow(
      /dialect must be one of/,
    );
    try {
      reconcileDataModel(shopDoc, { dialect: "sqlite" as never });
    } catch (error) {
      expect(error).toBeInstanceOf(FactError);
      expect((error as FactError).code).toBe("invalid_arguments");
    }
  });

  it("rejects a non-array liveTables", () => {
    expect(() => reconcileDataModel(shopDoc, { liveTables: {} as never })).toThrow(FactError);
  });

  it("rejects a foreign key missing required fields with its index", () => {
    try {
      reconcileDataModel(shopDoc, {
        liveTables: [],
        liveForeignKeys: [{ table: "orders" }] as never,
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FactError);
      expect((error as FactError).message).toContain("[0]");
    }
  });

  it("rejects negative sampleRows", () => {
    expect(() => dataModelDeploymentScript(shopDoc, { sampleRows: -1 })).toThrow(FactError);
  });
});

describe("dataModelReport", () => {
  it("embeds the open-question guidance when no database is provided", () => {
    const report = dataModelReport(shopDoc, {});
    expect(report.markdown).toContain("Migration plan");
    expect(report.markdown).toContain("Safeguards");
    expect(report.summary.relationships).toBe(1);
  });
});
