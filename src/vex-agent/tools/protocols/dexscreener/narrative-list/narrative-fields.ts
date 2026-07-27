/**
 * The `fields` vocabulary for `dexscreener.trending`.
 *
 * The narrative feed is small — 19 rows measured live, 4,644 B lean and 10,235 B
 * with every field — so this is a clarity budget more than a byte budget: eight
 * per-window numbers on every row bury the five that answer "what is rotating".
 *
 * `name` and `iconEmoji` ARE lean despite being display text: a slug alone
 * (`knockoff-legends`) is not always readable, and the emoji is one to four bytes.
 * `description` is opt-in because it is DexScreener editorial prose of unbounded
 * length that no decision reads.
 */

import { PAIR_WINDOWS } from "../pair-list/index.js";

export const LEAN_NARRATIVE_FIELDS = ["name", "iconEmoji"] as const;

/** `m5` → `M5`, `h24` → `H24`. */
function windowSuffix(window: string): string {
  return window.charAt(0).toUpperCase() + window.slice(1).toUpperCase();
}

/**
 * The per-window opt-ins, expanded over the same four windows the pair family
 * uses so the two never drift apart.
 */
const WINDOWED_NARRATIVE_FIELDS: readonly string[] = ["marketCapChangePct", "marketCapDeltaUsd"]
  .flatMap((stem) => PAIR_WINDOWS.map((window) => `${stem}${windowSuffix(window)}`));

export const RICH_NARRATIVE_FIELDS: readonly string[] = [
  "description",
  ...WINDOWED_NARRATIVE_FIELDS,
];

export const ALL_NARRATIVE_FIELDS: readonly string[] = [
  ...LEAN_NARRATIVE_FIELDS,
  ...RICH_NARRATIVE_FIELDS,
];

export const ALL_FIELDS_SENTINEL = "full";

export type NarrativeFieldSelection = ReadonlySet<string>;

export type NarrativeFieldResolution =
  | { readonly ok: true; readonly fields: NarrativeFieldSelection }
  | { readonly ok: false; readonly reason: string };

/** Additive, never subtractive. Unknown names are rejected BY NAME. */
export function resolveNarrativeFields(
  requested: readonly string[] | null,
): NarrativeFieldResolution {
  const selected = new Set<string>(LEAN_NARRATIVE_FIELDS);
  if (requested === null) return { ok: true, fields: selected };

  if (requested.includes(ALL_FIELDS_SENTINEL)) {
    return { ok: true, fields: new Set(ALL_NARRATIVE_FIELDS) };
  }
  const known = new Set(ALL_NARRATIVE_FIELDS);
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason:
        `Unknown "fields" value(s): ${unknown.join(", ")}. `
        + `Use "${ALL_FIELDS_SENTINEL}" for every field, or pick from: ${ALL_NARRATIVE_FIELDS.join(", ")}. `
        + "slug, narrativeTokenCount, marketCapUsd, liquidityUsd, volumeUsdH24 and "
        + "marketCapChangePctSelected are always emitted and are not selected here.",
    };
  }
  for (const name of requested) selected.add(name);
  return { ok: true, fields: selected };
}
