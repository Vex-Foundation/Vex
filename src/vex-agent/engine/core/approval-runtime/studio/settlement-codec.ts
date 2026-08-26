/**
 * The ONE owner of "a `ToolResult` as durable JSON" for Vex Studio settlements.
 *
 * ## The whole result, never a cut
 *
 * A Studio settlement stores the COMPLETE result of the dispatched call,
 * `output` included, with no size ceiling. That is the forbidden-truncation
 * rule applied to the one place it bites hardest: the external agent's only
 * copy of what Vex did is this row, and a silently shortened `output` would be
 * a lie about a money-path action. `settlement_bytes` records how large the
 * stored body is, so a reader can budget without the writer deciding for it.
 *
 * ## Every field survives, including ones this file has never heard of
 *
 * The projection walks the result's own keys rather than naming them. A field
 * added to `ToolResult` next month is therefore stored, not dropped, and no
 * second field list can drift away from the type. What the codec does add is a
 * VERSION TAG, so a reader always knows which projection produced a row.
 *
 * ## A non-JSON value is TAGGED, never dropped
 *
 * `data` is `Record<string, unknown>` and a handler may legitimately put a
 * `BigInt`, a `Map`, a `Date` or a circular reference in it. `JSON.stringify`
 * would throw on the first, silently rewrite the second and third, and throw on
 * the fourth. Any value that cannot round-trip is therefore replaced by an
 * explicit wrapper naming what it was and carrying its `String()` form, so the
 * row says "this field existed and here is what it looked like" instead of
 * pretending it never existed.
 */

import type { ToolResult } from "@vex-agent/tools/types.js";

/** Current projection version. Bump only for a shape change readers must see. */
export const STUDIO_SETTLEMENT_CODEC_VERSION = 1;

/** The marker key that says "this value is not JSON, here is its evidence". */
export const NON_JSON_TAG = "$vexNonJson" as const;

export interface StudioSettlementBody {
  readonly v: number;
  readonly result: Record<string, unknown>;
}

export interface EncodedStudioSettlement {
  /** The value stored in `approval_intents.settlement`. */
  readonly body: StudioSettlementBody;
  /** Exactly the string written to the column. */
  readonly json: string;
  /** UTF-8 byte length of `json`. Equal to what the column holds, by test. */
  readonly bytes: number;
}

/**
 * Project a `ToolResult` into its durable JSON form.
 *
 * Never throws. A value the projection cannot represent becomes a tagged
 * wrapper, and the wrapper itself is always representable, so serialization of
 * the projected body cannot fail for a reason the caller has to handle. The
 * caller still treats a write failure as `indeterminate`, because the write is
 * the part that can fail.
 */
export function encodeStudioSettlement(
  result: ToolResult,
): EncodedStudioSettlement {
  const projected = projectValue(result, new WeakSet<object>());
  const body: StudioSettlementBody = {
    v: STUDIO_SETTLEMENT_CODEC_VERSION,
    result: isPlainRecord(projected) ? projected : { [NON_JSON_TAG]: projected },
  };
  const json = JSON.stringify(body);
  return { body, json, bytes: Buffer.byteLength(json, "utf8") };
}

/**
 * The textual `output` alone, for the one path that cannot store the whole
 * body: a settlement write that failed after the dispatch already ran. The
 * intent becomes `indeterminate` and this is what is preserved of it.
 */
export function extractSettlementOutput(result: ToolResult): string {
  return typeof result.output === "string" ? result.output : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursive JSON projection with cycle detection.
 *
 * `seen` carries the objects on the CURRENT path; a repeat is a cycle and is
 * tagged rather than followed. Note that this deliberately tags a genuine cycle
 * only: a value referenced twice in sibling positions is projected twice, which
 * is what JSON does anyway.
 */
function projectValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    return Number.isFinite(value as number)
      ? value
      : tag("non_finite_number", type, value);
  }
  if (type === "bigint" || type === "function" || type === "symbol"
      || type === "undefined") {
    return tag(`unsupported_${type}`, type, value);
  }
  const asObject = value as object;
  if (seen.has(asObject)) return tag("circular_reference", "object", "[circular]");
  seen.add(asObject);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => projectValue(entry, seen));
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? tag("invalid_date", "Date", value)
        : value.toISOString();
    }
    if (value instanceof Map || value instanceof Set) {
      return tag(
        value instanceof Map ? "map" : "set",
        asObject.constructor.name,
        value,
      );
    }
    if (!isPlainRecord(value)) {
      return tag("non_plain_object", asObject.constructor?.name ?? "object", value);
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const projected = projectValue(record[key], seen);
      // `undefined` never reaches here: an undefined property is tagged above,
      // so a declared-but-empty optional field stays visible in the row.
      out[key] = projected;
    }
    return out;
  } finally {
    seen.delete(asObject);
  }
}

/**
 * The tagged wrapper. `text` is a best-effort `String()`; a value whose own
 * `toString` throws still produces a wrapper rather than losing the field.
 */
function tag(reason: string, typeName: string, value: unknown): Record<string, unknown> {
  let text: string;
  try {
    text = String(value);
  } catch {
    text = "[unprintable]";
  }
  return { [NON_JSON_TAG]: { reason, typeName, text } };
}
