/**
 * Shaping params for the site screening family: how many rows, from where in
 * the ranking, and which field groups.
 *
 * These are the only three params that do NOT change which pairs the provider
 * considers. They change what comes back, which is why their descriptions state
 * ceilings and costs rather than measured populations: the agent's decision
 * here is a context-budget decision, and it can only make it if the cost is
 * named before the call rather than discovered after it.
 */

import type { ProtocolParamDef } from "../../../types.js";
import {
  SCREEN_FIELD_GROUPS,
  SCREEN_HEAVIEST_FIELD_GROUPS,
} from "@tools/dexscreener/screen-core/fields.js";

/** The row window this family accepts. The provider serves 100 rows per page. */
export const SCREEN_LIMIT_MIN = 1;
export const SCREEN_LIMIT_MAX = 100;
export const SCREEN_LIMIT_DEFAULT = 20;

export const SCREEN_SHAPING_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "limit",
    type: "number",
    description:
      `How many rows to return, from ${SCREEN_LIMIT_MIN} to ${SCREEN_LIMIT_MAX}. Defaults to `
      + `${SCREEN_LIMIT_DEFAULT}. ${SCREEN_LIMIT_MAX} is the provider's own page size, so asking `
      + "for more than that is refused rather than silently served short; use offset to walk "
      + "further into the ranking.",
  },
  {
    key: "offset",
    type: "number",
    description:
      "How many ranked rows to skip before returning any, 0 or more. Defaults to 0. Mapped onto "
      + "the provider's 100-row pages for you, and offset paging was measured reaching page 525 of "
      + "525, so the ranking is walkable to its live end. The ranking is live, so rows can repeat "
      + "or be skipped between deep pages; hasMore and nextOffset carry the continuation.",
  },
  {
    key: "fields",
    type: "string",
    description:
      "Comma-separated row field GROUPS to return, not individual field names. Supported groups: "
      + `${SCREEN_FIELD_GROUPS.join(", ")}. Defaults to core, which carries the chain, dex, pair address, base-token address and symbols, the `
      + "selected window's price, volume, liquidity, market cap, age, counts and every derived "
      + `ratio. The two heaviest are ${SCREEN_HEAVIEST_FIELD_GROUPS[0]} (unbounded issuer-authored `
      + `prose and links) and ${SCREEN_HEAVIEST_FIELD_GROUPS[1]} (four times the per-row metric `
      + "payload). The `identity` group is NOT part of core and is what adds ammId, quoteTokenAddress, both tokens' decimals, priceNative and pairCreatedAtMs - the fields that let you tell a real pool from a mispriced one, so ask for it when the dollar columns are what you are judging. An unknown group name is refused with the full list rather than ignored.",
  },
];
