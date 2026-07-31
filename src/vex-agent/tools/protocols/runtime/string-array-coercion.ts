/**
 * The JSON-array-in-a-string spelling of an `acceptsStringArray` param.
 *
 * WHY THIS EXISTS. `acceptsStringArray` compiles to `string | string[]` and the
 * manifest text promises the two spellings are equivalent. A live session
 * (2026-07-30) produced a third one: `chainIds: "[\"robinhood\"]"` — the array,
 * JSON-encoded into the string branch. That value is a valid string, so the
 * type gate passes it, and the comma-splitting reader downstream then treats
 * the literal `["robinhood"]` as a chain slug. The result is an empty answer
 * with no error: the silent wrong answer this param family exists to prevent.
 *
 * SCOPE, deliberately narrow. Only a param the manifest DECLARED
 * `acceptsStringArray` is considered, and only a string that parses to a JSON
 * array whose members are ALL strings is rewritten — into exactly the array the
 * model meant. Anything else (a bare word, a comma list, malformed JSON, a JSON
 * object, an array with a non-string member) is returned untouched so the
 * existing validation messages, not this module, decide its fate. Money and
 * amount params are never `acceptsStringArray`, so no numeric contract is in
 * reach of this normalization.
 *
 * This runs BEFORE `validateProtocolParams`, which stays a pure gate: the
 * transform is here, in one named place, and it is logged.
 */

import type { ProtocolToolManifest } from "../types.js";

export interface CoercedParams {
  /** A NEW object when something was coerced; the input reference otherwise. */
  readonly params: Record<string, unknown>;
  readonly coercedKeys: readonly string[];
}

/** `["a","b"]` → `["a","b"]`; anything else → `null` (leave the value alone). */
function parseJsonStringArray(value: string): readonly string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.every((member) => typeof member === "string") ? (parsed as string[]) : null;
}

export function coerceStringArrayParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): CoercedParams {
  const coercedKeys: string[] = [];
  const coerced: Record<string, unknown> = {};

  for (const param of manifest.params) {
    if (param.acceptsStringArray !== true) continue;
    const value = params[param.key];
    if (typeof value !== "string") continue;
    const members = parseJsonStringArray(value);
    if (members === null) continue;
    coerced[param.key] = members;
    coercedKeys.push(param.key);
  }

  if (coercedKeys.length === 0) return { params, coercedKeys: [] };
  return { params: { ...params, ...coerced }, coercedKeys };
}
