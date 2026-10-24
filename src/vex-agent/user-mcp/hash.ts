/**
 * The hash a pinned input schema is stored under: sha256 over the schema as
 * JSON with every object's keys sorted, so a server that only reorders keys
 * does not look changed.
 */

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function schemaHash(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}
