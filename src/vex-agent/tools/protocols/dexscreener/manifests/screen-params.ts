/**
 * The shared param vocabulary for the SITE screening family.
 *
 * Declared once and spread into every manifest, so `minVolumeUsd` cannot mean
 * one thing on the gainers board and another on the launchpad board, and so the
 * honest sentence each param must carry is written in exactly one place. This
 * is the same discipline `./pair-list-params.ts` applies to the public-API
 * family; the two vocabularies are separate because the two CHANNELS are
 * separate, and mixing them would advertise server-side screening on a surface
 * that has none.
 *
 * This file is the public entry point and owns the per-TOOL compositions. The
 * vocabulary itself lives in `./screen-params/`: `clauses.ts` (the inherited
 * sentences), `scope.ts` (which pairs and which window), `thresholds.ts` (the
 * numeric filters and quality flags), `shaping.ts` (limit, offset, fields).
 *
 * ORDER IS DELIBERATE. Scope, then window, then thresholds, then quality, then
 * shaping: an agent reading the schema top to bottom meets the question "which
 * pairs" before the question "how many rows".
 */

import type { ProtocolParamDef } from "../../types.js";
import { SCREEN_SCOPE_PARAMS, SCREEN_WINDOW_PARAMS } from "./screen-params/scope.js";
import {
  SCREEN_DISABLE_QUALITY_FLOOR,
  SCREEN_QUALITY_PARAMS,
  SCREEN_THRESHOLD_PARAMS,
} from "./screen-params/thresholds.js";
import { SCREEN_SHAPING_PARAMS } from "./screen-params/shaping.js";

export {
  SCREEN_LIMIT_DEFAULT,
  SCREEN_LIMIT_MAX,
  SCREEN_LIMIT_MIN,
} from "./screen-params/shaping.js";
export { SCREEN_WINDOW_VALUES } from "./screen-params/scope.js";

/**
 * The full vocabulary, in schema order.
 *
 * Every screening tool takes all of it. The tools differ in the sort key they
 * PIN and the default floors they apply, not in what the agent may ask for:
 * a filter that works on the trending board works identically on the losers
 * board, because it is the same provider channel underneath.
 */
export const SCREEN_PARAMS: readonly ProtocolParamDef[] = [
  ...SCREEN_SCOPE_PARAMS,
  ...SCREEN_WINDOW_PARAMS,
  ...SCREEN_THRESHOLD_PARAMS,
  ...SCREEN_QUALITY_PARAMS,
  ...SCREEN_SHAPING_PARAMS,
];

/**
 * Add a tool-specific sentence to one param without re-authoring it.
 *
 * Used where a tool's default floor makes a shared param mean something more
 * specific than it does elsewhere: the gainers board's `minLiquidityUsd`
 * carries a default the trending board does not, and the agent must be able to
 * read that off the param it is about to set. The base sentence still has one
 * owner; only the addition is local.
 */
export function withParamNote(
  params: readonly ProtocolParamDef[],
  key: string,
  note: string
): readonly ProtocolParamDef[] {
  let matched = false;
  const out = params.map((param) => {
    if (param.key !== key) return param;
    matched = true;
    return { ...param, description: `${param.description} ${note}` };
  });
  if (!matched) {
    throw new Error(
      `withParamNote: no screening param named "${key}"; the note would have been dropped silently`
    );
  }
  return out;
}

/**
 * Remove a shared param from ONE tool, for a filter the tool's channel ignores.
 *
 * The screening vocabulary is shared because the channel underneath is shared,
 * and that stops being true where two channels differ. `filters[
 * enhancedTokenInfo]` is an exact partition on the v7 pairs channel (30,847
 * true and 33,554 false of 64,401) and a measured NO-OP on the v2 tokens
 * channel, where baseline, `=true` and `=false` returned byte-identical
 * 91,955-byte frames. Keeping the param there let it be echoed in
 * `filtersApplied` as though it had selected something.
 *
 * Throws when the key is not present, so a rename cannot turn this into a
 * silent no-op that quietly restores the dead param.
 */
export function withoutParam(
  params: readonly ProtocolParamDef[],
  key: string
): readonly ProtocolParamDef[] {
  const out = params.filter((param) => param.key !== key);
  if (out.length === params.length) {
    throw new Error(
      `withoutParam: no screening param named "${key}"; the removal would have been a silent no-op`
    );
  }
  return out;
}

/** Apply several notes at once, left to right. */
export function withParamNotes(
  params: readonly ProtocolParamDef[],
  notes: ReadonlyArray<readonly [string, string]>
): readonly ProtocolParamDef[] {
  return notes.reduce(
    (current, [key, note]) => withParamNote(current, key, note),
    params
  );
}

/**
 * The screening vocabulary plus the floor switch, for the tools that declare
 * default floors.
 *
 * Placed with the other quality params, immediately before the shaping block,
 * so the schema still reads scope, window, filters, quality, then shaping.
 */
export function withDisableQualityFloor(
  params: readonly ProtocolParamDef[]
): readonly ProtocolParamDef[] {
  const shapingKeys = new Set(SCREEN_SHAPING_PARAMS.map((param) => param.key));
  const before = params.filter((param) => !shapingKeys.has(param.key));
  const after = params.filter((param) => shapingKeys.has(param.key));
  return [...before, SCREEN_DISABLE_QUALITY_FLOOR, ...after];
}

/**
 * The screening vocabulary plus a pinned sort, for the one tool that ranks by
 * a metric the agent chooses.
 */
export function withSortBy(
  params: readonly ProtocolParamDef[],
  sortBy: ProtocolParamDef
): readonly ProtocolParamDef[] {
  // Placed immediately before the shaping block, so the schema still reads
  // scope, window, filters, then "how do you want it ordered and how much".
  const shapingKeys = new Set(SCREEN_SHAPING_PARAMS.map((param) => param.key));
  const before = params.filter((param) => !shapingKeys.has(param.key));
  const after = params.filter((param) => shapingKeys.has(param.key));
  return [...before, sortBy, ...after];
}
