/**
 * Project-level developer configuration (powerduck.dev.json).
 *
 * This file is safe to commit: it points at the specification and the local
 * development server. Secrets must come from environment variables, never from
 * this file.
 */

import fs from "node:fs";
import path from "node:path";

export interface DevConfig {
  /** Path to the OpenAPI document, relative to the config file. */
  spec?: string;
  /** Default base URL of the local backend under development. */
  baseUrl?: string;
  /** Backend project root, used by future code-aware tools. */
  project?: string;
}

function readConfigFile(filePath: string): DevConfig {
  const text = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  const config: DevConfig = {};
  const record = parsed as Record<string, unknown>;
  if (typeof record.spec === "string") config.spec = record.spec;
  if (typeof record.baseUrl === "string") config.baseUrl = record.baseUrl;
  if (typeof record.project === "string") config.project = record.project;
  return config;
}

/**
 * Loads optional configuration. Explicit `--config` wins; otherwise a
 * powerduck.dev.json in the current working directory is used when present.
 */
export function loadDevConfig(configPath?: string): {
  config: DevConfig;
  configDir: string;
} {
  const resolved = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), "powerduck.dev.json");
  if (!fs.existsSync(resolved)) {
    return { config: {}, configDir: process.cwd() };
  }
  return { config: readConfigFile(resolved), configDir: path.dirname(resolved) };
}

/** Resolves a possibly config-relative path to an absolute one. */
export function resolveFrom(configDir: string, target?: string): string | undefined {
  return target ? path.resolve(configDir, target) : undefined;
}
