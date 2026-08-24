/**
 * The `fields` vocabulary for every DexScreener feed tool — one list, six tools.
 *
 * WHY THIS IS A BYTE BUDGET AND NOT A STYLE CHOICE
 *
 * Measured on live windows (2026-07-27), the payloads these six tools emitted
 * before this card: `profiles.recent` 40,089 B · `communityTakeovers` 23,122 B ·
 * `boosts.top` 21,612 B · `profiles` 21,205 B · `boosts` 20,493 B - and NONE of
 * the six had a single parameter, so the agent could not shrink any of them.
 *
 * Dropping `icon` and `header` from the default row is what fixes that. They are
 * `cdn.dexscreener.com/cms/images/<opaque-id>?width=…` URLs: the model cannot see
 * an image, and the ids are not derivable from anything else on the row, so they
 * survive as opt-ins rather than being deleted. Making `dexScreenerUrl` and
 * `links` opt-in too brings five of the six comfortably under the cap.
 *
 * `description` is the ONE unbounded issuer-authored field left in the default
 * row, and it stays there on purpose: it is the entire content of a profile feed,
 * and the owner rule permits projection but forbids truncation. It is what leaves
 * `profiles.recent` over the cap on a no-params call (measured 25,868 B — the
 * feed's 30 descriptions are 18,473 characters), which is why `limit` and
 * `updatedWithinSeconds` exist. Both are agent-set and disclosed; neither is a
 * hidden default.
 */

/**
 * Emitted unless the caller projects them away. `chainId` and `tokenAddress` are
 * NOT in this list because they are never optional: they are the identity the
 * agent carries into `dexscreener.tokenPairs`, and a row without them is unusable.
 */
export const LEAN_FEED_FIELDS = ["description"] as const;

/**
 * Opt-in. The same four names on every feed tool, so an agent that learns them on
 * `boosts` can use them on `ads` without re-reading anything.
 *
 * Typed as `readonly string[]` rather than a literal tuple, matching
 * `../pair-list/agent-pair-fields.ts`: these are vocabulary LISTS that get
 * compared against each other and against user input, and a tuple type makes
 * `RICH_FEED_FIELDS.includes(leanField)` a compile error instead of the `false` a
 * disjointness check needs.
 */
export const RICH_FEED_FIELDS: readonly string[] = [
  "dexScreenerUrl",
  "iconUrl",
  "headerUrl",
  "links",
];

export const ALL_FEED_FIELDS: readonly string[] = [...LEAN_FEED_FIELDS, ...RICH_FEED_FIELDS];

/**
 * What `omitFields` may remove here — the one mandatory issuer-authored field.
 *
 * `description` is the dominant byte cost of every feed payload (30 descriptions
 * measured at 18,473 characters on `profiles.recent`) AND the entire hostile
 * surface of a feed row. It is also the only field a caller can lose without
 * losing the row's meaning: `chainId` + `tokenAddress` are the identity carried
 * into `dexscreener.tokenPairs`, and each feed's signal fields are why it was
 * called at all.
 */
export const OMITTABLE_FEED_FIELDS: readonly string[] = ["description"];

export const OMIT_FEED_FIELDS_NOTE =
  "chainId and tokenAddress are the identity you carry into dexscreener__token_pairs_list, and each "
  + "feed's signal fields (boost counts, updatedAt, claimedAt, ad placement) are why the feed was "
  + "called — neither can be omitted. Everything else is already opt-in via \"fields\".";

/** `fields: "full"` — every field. Same sentinel as the pair family. */
export const ALL_FIELDS_SENTINEL = "full";

export type FeedFieldSelection = ReadonlySet<string>;

export type FeedFieldResolution =
  | { readonly ok: true; readonly fields: FeedFieldSelection }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve requested field names against the vocabulary.
 *
 * ADDITIVE, never subtractive: the lean set is always emitted, so a caller cannot
 * project away the one field that makes a feed row worth reading. Unknown names
 * are REJECTED BY NAME — a caller who asks for `icon` and silently receives a row
 * without it cannot tell a misspelling from an absent value.
 */
export function resolveFeedFields(
  requested: readonly string[] | null,
  omitted: readonly string[] | null = null,
): FeedFieldResolution {
  // Subtraction runs LAST, over whatever the additive pass selected, so
  // `fields: "full"` + `omitFields: "description"` means "everything but the
  // prose" rather than depending on which param was read first.
  const withoutOmitted = (fields: Set<string>): FeedFieldSelection => {
    for (const name of omitted ?? []) fields.delete(name);
    return fields;
  };

  const selected = new Set<string>(LEAN_FEED_FIELDS);
  if (requested === null) return { ok: true, fields: withoutOmitted(selected) };

  if (requested.includes(ALL_FIELDS_SENTINEL)) {
    return { ok: true, fields: withoutOmitted(new Set(ALL_FEED_FIELDS)) };
  }
  const known = new Set(ALL_FEED_FIELDS);
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason:
        `Unknown "fields" value(s): ${unknown.join(", ")}. `
        + `Use "${ALL_FIELDS_SENTINEL}" for every field, or pick from: ${ALL_FEED_FIELDS.join(", ")}. `
        + "The signal fields of each feed (boost counts, updatedAt, claimedAt, ad placement) are "
        + "always emitted and are not selected here.",
    };
  }
  for (const name of requested) selected.add(name);
  return { ok: true, fields: withoutOmitted(selected) };
}
