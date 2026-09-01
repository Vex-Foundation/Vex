/**
 * An EMPTY array on an OPTIONAL list param means the param is absent.
 *
 * WHY THIS EXISTS. Measured production loop, 2026-08-27: glm-5.3 called
 * `dexscreener__pairs_new_list` seven times in a row and was refused seven
 * byte-identical times. The tool declares zero required params, so the compiled
 * provider schema carries `additionalProperties: false` with no `required`
 * list; the model's own reasoning in the transcript reports the schema as
 * demanding every key ("the schema tool needs to have all keys listed", "the
 * generated call filled them all"). It therefore sent `[]` on every list filter
 * it did not want, and the runtime refused the empty array while telling it to
 * do the one thing its schema appeared to forbid: omit the parameter.
 *
 * THE RULE. For a param the manifest declared OPTIONAL and
 * `acceptsStringArray`, the value `[]` is dropped before anything reads it: the
 * validator, the handler, the capture row, and the cross-param group gates all
 * see a call that simply did not carry the key. That is exactly how
 * github-mcp-server's `OptionalStringArrayParam` treats missing, nil and empty
 * (pkg/github/params.go), and it removes the contradiction without widening the
 * boundary anywhere else.
 *
 * WHAT IS NOT TOUCHED, deliberately:
 * - a REQUIRED list param keeps refusing `[]` (github-mcp's `RequiredParam`
 *   rejects zero values too): "give me a list" and "give me nothing" are not
 *   the same request, and a required param has no absent-state to fall back to;
 * - a non-empty array, an array with a non-string member, and every non-array
 *   value are returned untouched for the existing validation to decide;
 * - a param that never declared `acceptsStringArray` is untouched: an array
 *   there is still the wrong type and is still refused by name.
 *
 * ORDERING. This runs AFTER `coerceStringArrayParams`, which turns the
 * JSON-encoded `"[]"` spelling into a real empty array, so both spellings of
 * "no filter" reach the same outcome.
 */

import type { ProtocolToolManifest } from "../types.js";

export interface NormalizedEmptyArrayParams {
  /** A NEW object when something was dropped; the input reference otherwise. */
  readonly params: Record<string, unknown>;
  /** Keys removed because they carried an empty array on an optional list param. */
  readonly droppedKeys: readonly string[];
}

export function normalizeOptionalEmptyArrayParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): NormalizedEmptyArrayParams {
  const droppedKeys: string[] = [];

  for (const param of manifest.params) {
    if (param.required === true) continue;
    if (param.acceptsStringArray !== true) continue;
    const value = params[param.key];
    if (!Array.isArray(value) || value.length !== 0) continue;
    droppedKeys.push(param.key);
  }

  if (droppedKeys.length === 0) return { params, droppedKeys: [] };

  const normalized: Record<string, unknown> = { ...params };
  for (const key of droppedKeys) delete normalized[key];
  return { params: normalized, droppedKeys };
}
