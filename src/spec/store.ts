/**
 * Loads an OpenAPI document from disk and keeps it fresh.
 *
 * A developer edits the spec while the coding agent is connected, so the
 * store re-reads the file whenever its mtime changes. Parsing and validation
 * are best effort: an in-progress document with validation issues must still
 * answer fact queries, and the validate_spec tool surfaces those problems.
 */

import fs from "node:fs";
import { load as parseYaml } from "js-yaml";
import {
  dereference,
  upgradeOasTo32,
  validate,
} from "@powerduck/openapi-parser";
import type { ValidationFact, ValidationIssue } from "../types.js";

export interface SpecSnapshot {
  /** Absolute source path. */
  path: string;
  /** Document normalized to 3.x when conversion is safe; otherwise as authored. */
  document: Record<string, any>;
  /** Document with internal $ref values inlined where possible. */
  dereferenced: Record<string, any>;
  /** Raw source text, served by the `source` resource. */
  sourceText: string;
  mediaType: "application/yaml" | "application/json";
  validation: ValidationFact;
  mtimeMs: number;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseContent(text: string, isYaml: boolean): unknown {
  if (isYaml) return parseYaml(text);
  return JSON.parse(text);
}

function normalizeIssue(value: unknown): ValidationIssue | null {
  if (typeof value === "string" && value.trim()) {
    return { message: value, severity: "error" };
  }
  if (isObject(value) && typeof value.message === "string") {
    const severity =
      value.severity === "warning" || value.severity === "info"
        ? value.severity
        : "error";
    const path = Array.isArray(value.path)
      ? value.path.join("/")
      : typeof value.path === "string"
        ? value.path
        : undefined;
    return path
      ? { message: value.message, severity, path }
      : { message: value.message, severity };
  }
  return null;
}

async function runValidation(doc: unknown): Promise<ValidationFact> {
  try {
    const result = await validate(doc as never);
    const issues: ValidationIssue[] = [];
    for (const raw of result.errors ?? []) {
      const issue = normalizeIssue(raw);
      if (issue) issues.push(issue);
    }
    return {
      valid: Boolean(result.valid),
      ...(typeof result.version === "string"
        ? { openapiVersion: result.version }
        : {}),
      issues,
    };
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ],
    };
  }
}

async function tryDereference(
  doc: Record<string, any>,
): Promise<Record<string, any>> {
  try {
    const result = await dereference(doc as never);
    if (!result.errors?.length && isObject(result.schema)) {
      return result.schema;
    }
    return doc;
  } catch {
    // Keep serving facts from the raw document; unresolved refs are handled
    // per query by the local pointer resolver.
    return doc;
  }
}

export class SpecStore {
  private cache: { mtimeMs: number; snapshot: SpecSnapshot } | null = null;

  constructor(public readonly specPath: string) {}

  /** Read and normalize the document, reusing the cache while mtime is stable. */
  async load(force = false): Promise<SpecSnapshot> {
    const stat = fs.statSync(this.specPath);
    if (!force && this.cache && this.cache.mtimeMs === stat.mtimeMs) {
      return this.cache.snapshot;
    }

    const sourceText = fs.readFileSync(this.specPath, "utf8");
    const isYaml = /\.ya?ml$/i.test(this.specPath);
    const parsed = parseContent(sourceText, isYaml);
    if (!isObject(parsed)) {
      throw new Error("The OpenAPI document must be a JSON or YAML object.");
    }

    let document = parsed;
    const version = typeof parsed.openapi === "string" ? parsed.openapi : "";
    if (version && !/^3\./.test(version)) {
      // Best-effort upgrade for 2.0 / 3.0 / 3.1 inputs; failures fall back to
      // the original document so fact tools keep working.
      try {
        document = (await upgradeOasTo32(
          parsed as never,
        )) as unknown as Record<string, any>;
      } catch {
        document = parsed;
      }
    }

    const validation = await runValidation(document);
    const dereferenced = await tryDereference(document);

    const snapshot: SpecSnapshot = {
      path: this.specPath,
      document,
      dereferenced,
      sourceText,
      mediaType: isYaml ? "application/yaml" : "application/json",
      validation,
      mtimeMs: stat.mtimeMs,
    };
    this.cache = { mtimeMs: stat.mtimeMs, snapshot };
    return snapshot;
  }
}
