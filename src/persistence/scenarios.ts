/**
 * Scenario persistence next to the OpenAPI document.
 *
 * Saved scenarios are user-authored project artifacts (regression flows), so
 * they live in `<spec dir>/.powerduck/scenarios/` and can be committed to the
 * repository. The MCP server is only allowed to write inside that directory.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ScenarioDefinition } from "@powerduck/openapi-cli";
import { FactError } from "../types.js";

const ENVELOPE_VERSION = 1;
const FILE_EXTENSION = ".json";

export interface SavedScenarioEnvelope {
  version: number;
  name: string;
  updatedAt: string;
  scenario: ScenarioDefinition;
}

export interface ScenarioSummary {
  name: string;
  fileName: string;
  stepCount: number;
  updatedAt: string;
}

export function scenariosDirectory(specPath: string): string {
  return path.join(path.dirname(specPath), ".powerduck", "scenarios");
}

/** Converts a scenario name to a safe file name; rejects path traversal. */
export function scenarioSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug || slug === "." || slug === ".." || slug.includes(path.sep)) {
    throw new FactError(
      "invalid_arguments",
      "Scenario name must contain letters or digits usable as a file name.",
    );
  }
  return slug;
}

function scenarioPath(specPath: string, name: string): string {
  return path.join(scenariosDirectory(specPath), `${scenarioSlug(name)}${FILE_EXTENSION}`);
}

/** Lists saved scenarios, newest first. Unreadable files are skipped. */
export function listScenarios(specPath: string): ScenarioSummary[] {
  const directory = scenariosDirectory(specPath);
  if (!existsSync(directory)) return [];
  const summaries: ScenarioSummary[] = [];
  for (const fileName of readdirSync(directory)) {
    if (!fileName.endsWith(FILE_EXTENSION)) continue;
    try {
      const envelope = JSON.parse(
        readFileSync(path.join(directory, fileName), "utf8"),
      ) as Partial<SavedScenarioEnvelope>;
      if (!envelope.scenario || !Array.isArray(envelope.scenario.steps)) continue;
      summaries.push({
        name: typeof envelope.name === "string" ? envelope.name : fileName,
        fileName,
        stepCount: envelope.scenario.steps.length,
        updatedAt: typeof envelope.updatedAt === "string" ? envelope.updatedAt : "",
      });
    } catch {
      // Ignore files that are not valid saved scenarios.
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getScenario(specPath: string, name: string): SavedScenarioEnvelope {
  const target = scenarioPath(specPath, name);
  if (!existsSync(target)) {
    throw new FactError("not_found", `No saved scenario named "${name}".`);
  }
  try {
    const envelope = JSON.parse(readFileSync(target, "utf8")) as SavedScenarioEnvelope;
    if (!envelope.scenario || !Array.isArray(envelope.scenario.steps)) {
      throw new Error("malformed envelope");
    }
    return envelope;
  } catch (error) {
    throw new FactError(
      "invalid_scenario",
      `Saved scenario "${name}" is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Atomically writes a validated scenario. Throws when the file already exists
 * unless overwrite is requested.
 */
export function saveScenario(
  specPath: string,
  scenario: ScenarioDefinition,
  options: { overwrite?: boolean } = {},
): SavedScenarioEnvelope {
  const target = scenarioPath(specPath, scenario.name);
  if (existsSync(target) && !options.overwrite) {
    throw new FactError(
      "already_exists",
      `Scenario "${scenario.name}" already exists. Set overwrite to replace it.`,
    );
  }
  const envelope: SavedScenarioEnvelope = {
    version: ENVELOPE_VERSION,
    name: scenario.name,
    updatedAt: new Date().toISOString(),
    scenario,
  };
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return envelope;
}

export function deleteScenario(specPath: string, name: string): boolean {
  const target = scenarioPath(specPath, name);
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}
