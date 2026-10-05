/**
 * Scenario validation and execution.
 *
 * Validation resolves every step reference up front and never touches the
 * network, so an agent can confirm a plan before running it. Execution reuses
 * openapi-cli's ordered, stateful engine with live progress and cancellation.
 */

import {
  resolveSteps,
  runScenario,
  type ScenarioDefinition,
  type ScenarioReport,
} from "@powerduck/openapi-cli";
import type { SpecSnapshot } from "../spec/store.js";
import { FactError } from "../types.js";
import { buildRunnerConfig, type ProgressSink, type RunOverrides } from "./config.js";
import { allOperations } from "./operations.js";

export interface ScenarioValidation {
  valid: boolean;
  errors?: string[];
  steps?: Array<{ index: number; ref: string; name?: string }>;
  count?: number;
}

function asScenario(value: unknown): ScenarioDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FactError(
      "invalid_scenario",
      "scenario must be an object with name and steps.",
    );
  }
  const candidate = value as Partial<ScenarioDefinition>;
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    throw new FactError("invalid_scenario", "scenario.name is required.");
  }
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    throw new FactError("invalid_scenario", "scenario.steps must be a non-empty array.");
  }
  return candidate as ScenarioDefinition;
}

export function validateScenario(
  snapshot: SpecSnapshot,
  rawScenario: unknown,
): ScenarioValidation {
  let definition: ScenarioDefinition;
  try {
    definition = asScenario(rawScenario);
  } catch (error) {
    if (error instanceof FactError) return { valid: false, errors: [error.message] };
    throw error;
  }
  try {
    const resolved = resolveSteps(definition, allOperations(snapshot));
    return {
      valid: true,
      count: resolved.length,
      steps: resolved.map((item, index) => ({
        index,
        ref: item.ref,
        ...(item.step.name ? { name: item.step.name } : {}),
      })),
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** Strips the verbose runner config from a scenario report before transport. */
function compactReport(report: ScenarioReport) {
  const { config: _config, ...rest } = report;
  void _config;
  return rest;
}

export async function runScenarioTool(
  snapshot: SpecSnapshot,
  rawScenario: unknown,
  overrides: RunOverrides,
  sink: ProgressSink = {},
): Promise<Omit<ScenarioReport, "config">> {
  const definition = asScenario(rawScenario);
  const validation = validateScenario(snapshot, definition);
  if (!validation.valid) {
    throw new FactError("invalid_scenario", "Scenario failed validation.", validation.errors);
  }
  const config = buildRunnerConfig(snapshot, overrides);
  const options: Parameters<typeof runScenario>[1] = {
    config,
    spec: snapshot.dereferenced,
    onEvent: (event) => {
      if (event.type === "step:start" && typeof event.stepIndex === "number") {
        sink.report?.(event.stepIndex + 1, definition.steps.length, event.type);
      } else if (event.type === "scenario:finish") {
        sink.report?.(definition.steps.length, definition.steps.length, event.type);
      }
    },
  };
  if (sink.signal) options.signal = sink.signal;
  const report = await runScenario(definition, options);
  return compactReport(report);
}
