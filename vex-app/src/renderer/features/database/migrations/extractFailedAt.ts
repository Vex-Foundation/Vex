/**
 * Pure type-guard for the `failedAt` field on `data.migration_failed`
 * error details. The IPC `VexError.details` field is `unknown` -
 * narrow it here before consuming, no `as` assertions in hot paths
 * (codex plan v2 SHOULD-FIX #5).
 */

import type { FailedAt } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractFailedAt(details: unknown): FailedAt | null {
  if (!isRecord(details)) return null;
  const inner = details["failedAt"];
  if (!isRecord(inner)) return null;
  const version = inner["version"];
  const file = inner["file"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return null;
  }
  if (typeof file !== "string" || file.length === 0) return null;
  return { version, file };
}
