import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpecStore } from "../src/spec/store.js";
import { executeDevTool } from "../src/mcp/tools.js";
import { FactError } from "../src/types.js";
import {
  deleteScenario,
  getScenario,
  listScenarios,
  saveScenario,
  scenariosDirectory,
  scenarioSlug,
} from "../src/persistence/scenarios.js";
import { startFakeBackend } from "./helpers/fakeBackend.js";
import type { ScenarioDefinition } from "@powerduck/openapi-cli";
import { MockManager } from "../src/mock/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workdir = mkdtempSync(path.join(tmpdir(), "devmcp-persist-"));
const specPath = path.join(workdir, "petstore.yaml");
const store = new SpecStore(specPath);

const happyPath: ScenarioDefinition = {
  name: "List pets",
  steps: [{ ref: "GET /pets" }],
};

beforeAll(() => {
  copyFileSync(path.join(here, "fixtures", "petstore.yaml"), specPath);
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("scenario store", () => {
  it("slugifies names and rejects traversal", () => {
    expect(scenarioSlug("Happy Flow #2!")).toBe("happy-flow-2");
    expect(() => scenarioSlug("///")).toThrow(FactError);
  });

  it("saves, lists, reads, overwrites, and deletes", () => {
    const saved = saveScenario(specPath, happyPath);
    expect(saved.version).toBe(1);
    expect(existsSync(path.join(scenariosDirectory(specPath), "list-pets.json"))).toBe(true);

    expect(() => saveScenario(specPath, happyPath)).toThrow(FactError);
    saveScenario(specPath, happyPath, { overwrite: true });

    const rows = listScenarios(specPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("List pets");
    expect(rows[0]?.stepCount).toBe(1);

    expect(getScenario(specPath, "list-pets").scenario.steps).toHaveLength(1);
    expect(deleteScenario(specPath, "list-pets")).toBe(true);
    expect(listScenarios(specPath)).toHaveLength(0);
    expect(deleteScenario(specPath, "list-pets")).toBe(false);
  });
});

describe("scenario persistence tools", () => {
  const manager = new MockManager();
  let backend: Awaited<ReturnType<typeof startFakeBackend>>;

  beforeAll(async () => {
    backend = await startFakeBackend();
  });

  afterAll(async () => {
    await manager.stopAll();
    await backend.close();
    rmSync(path.join(workdir, ".powerduck"), { recursive: true, force: true });
  });

  it("rejects invalid scenarios on save", async () => {
    await expect(
      executeDevTool(
        "save_scenario",
        { scenario: { name: "broken", steps: [{ ref: "GET /missing" }] } },
        store,
        {},
        manager,
      ),
    ).rejects.toThrow(FactError);
  });

  it("saves, validates by name, runs by name, and deletes through tools", async () => {
    const saved = (await executeDevTool(
      "save_scenario",
      { scenario: happyPath },
      store,
      {},
      manager,
    )) as { name: string };
    expect(saved.name).toBe("List pets");

    const listed = (await executeDevTool(
      "list_scenarios",
      {},
      store,
      {},
      manager,
    )) as { scenarios: Array<{ name: string }> };
    expect(listed.scenarios.some((item) => item.name === "List pets")).toBe(true);

    const validation = (await executeDevTool(
      "validate_scenario",
      { scenarioName: "List pets" },
      store,
      {},
      manager,
    )) as { valid: boolean; count: number };
    expect(validation.valid).toBe(true);
    expect(validation.count).toBe(1);

    const report = (await executeDevTool(
      "run_scenario",
      { scenarioName: "List pets", baseUrl: backend.url },
      store,
      {},
      manager,
    )) as { success?: boolean; status?: string };
    expect(report.status === "passed" || report.success === true).toBe(true);

    const removed = (await executeDevTool(
      "delete_scenario",
      { name: "List pets" },
      store,
      {},
      manager,
    )) as { deleted: boolean };
    expect(removed.deleted).toBe(true);
  });
});
