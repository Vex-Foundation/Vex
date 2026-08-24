/**
 * Contract-snapshot file IO and comparison for the tool-surface snapshot
 * harness (`../toolsnaps.test.ts`).
 *
 * Modeled on `github-mcp-server`'s `internal/toolsnaps/toolsnaps.go`, with one
 * deliberate divergence: GitHub compares with `jd.SET`, which makes array order
 * irrelevant. Vex does NOT copy that. Enum order and property order travel into
 * approval fingerprints (`engine/core/approval-runtime/tool-call-envelope.ts`),
 * so a reordered `enum` is a real contract change here. Object keys are sorted
 * on write purely so the on-disk bytes are stable; every array keeps its
 * authored order and is compared positionally.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/** JSON value shape the harness reads and writes. Snapshots contain no other types. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Recursively sort object keys; arrays are returned with their order intact.
 * Applied on write only, so the diff a reviewer reads is a semantic diff rather
 * than a key-order diff.
 */
export function sortObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== "object") return value;

  const source = value as { readonly [key: string]: JsonValue };
  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortObjectKeys(source[key] as JsonValue);
  }
  return sorted;
}

/** Canonical on-disk form: key-sorted, two-space indented, newline-terminated. */
export function serializeSnapshot(value: JsonValue): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

export function writeSnapshot(path: string, value: JsonValue): void {
  mkdirSync(dirnameOf(path), { recursive: true });
  writeFileSync(path, serializeSnapshot(value), "utf8");
}

/** Parsed snapshot, or `undefined` when the file does not exist. Any other IO error propagates. */
export function readSnapshot(path: string): JsonValue | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return JSON.parse(raw) as JsonValue;
}

/**
 * Positional deep comparison. Returns the differing paths, most useful first,
 * or an empty array when the two values are identical.
 */
export function diffJson(expected: JsonValue, actual: JsonValue, path = "$"): string[] {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [`${path}: type changed (${describe(expected)} -> ${describe(actual)})`];
    }
    const lines: string[] = [];
    if (expected.length !== actual.length) {
      lines.push(`${path}: array length ${expected.length} -> ${actual.length}`);
    }
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const left = i < expected.length ? (expected[i] as JsonValue) : undefined;
      const right = i < actual.length ? (actual[i] as JsonValue) : undefined;
      if (left === undefined) {
        lines.push(`${path}[${i}]: added ${render(right as JsonValue)}`);
      } else if (right === undefined) {
        lines.push(`${path}[${i}]: removed ${render(left)}`);
      } else {
        lines.push(...diffJson(left, right, `${path}[${i}]`));
      }
    }
    return lines;
  }

  if (isJsonRecord(expected) && isJsonRecord(actual)) {
    const lines: string[] = [];
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const left = expected[key];
      const right = actual[key];
      const child = `${path}.${key}`;
      if (left === undefined) {
        lines.push(`${child}: added ${render(right as JsonValue)}`);
      } else if (right === undefined) {
        lines.push(`${child}: removed ${render(left)}`);
      } else {
        lines.push(...diffJson(left, right, child));
      }
    }
    return lines;
  }

  if (isJsonRecord(expected) !== isJsonRecord(actual)) {
    return [`${path}: type changed (${describe(expected)} -> ${describe(actual)})`];
  }

  if (expected !== actual) {
    return [`${path}: ${render(expected)} -> ${render(actual)}`];
  }

  return [];
}

/** Narrow a JSON value to an object (not an array, not null). */
export function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Values are truncated for readability only in the DIFF TEXT; snapshots keep the full value. */
function render(value: JsonValue): string {
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}
