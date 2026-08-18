/**
 * The provenance envelope every DexScreener list output carries.
 *
 * Four facts an agent cannot get any other way:
 *
 * 1. **`asOfMs`** — our clock at response time. Without it no age is computable
 *    at all, and every response is edge-cached for ~30 s so the data is already
 *    stale by an unknown amount.
 * 2. **`providerWindow`** — the ≤30-row cap is a provider window, not a result
 *    set. Measured: USDC's own `token-pairs` list holds 30 rows with a maximum
 *    liquidity of $3.77 M while the deepest USDC-quoted pool in existence holds
 *    $26.1 M and is absent from the list. "The deepest pool we returned" is a
 *    true statement; "the deepest pool" is not.
 * 3. **`droppedByFilter`** — see `./row-window.ts`. This is what makes an empty
 *    result self-diagnosing instead of reading as "does not exist".
 * 4. **`externalContentWarning` + `externalContentFields`** — see
 *    `./external-text.ts`. Provenance labelling for issuer-authored text, which
 *    is delivered in full and never truncated.
 *
 * ONE ENVELOPE SERVES THE PAIR, FEED AND NARRATIVE FAMILIES. `endpoint`,
 * `providerCap`, `providerOrder` and `note` are inputs rather than constants
 * because the three families genuinely differ on all four, and asserting a cap we
 * never observed would be the same class of error as asserting a ranking we
 * cannot explain.
 */

import { EXTERNAL_CONTENT_WARNING } from "./external-text.js";
import type { DroppedRowRecord } from "./row-window.js";

/**
 * DexScreener's hard per-call row cap on the pair and promotional-feed
 * endpoints. Measured on every one of them, no exceptions.
 *
 * NOT asserted for `/metas/trending/v1`: 19 rows is the most that endpoint has
 * ever been observed to return, which is a floor on its cap and not the cap. That
 * family passes `providerCap: null`.
 */
export const PROVIDER_PAIR_CAP = 30;

export const PROVIDER_WINDOW_NOTE =
  "DexScreener returns at most 30 rows per call and offers no pagination. This is a provider "
  + "window, not the full set of pools. It applies no server-side filter, sort or limit — every "
  + "filter, sort and window in filtersApplied was applied by Vex to the rows below.";

/**
 * The same honesty for a feed, where the rows are tokens rather than pools.
 *
 * Kept separate from {@link PROVIDER_WINDOW_NOTE} because "not the full set of
 * pools" is the wrong sentence on a promotional feed: the risk there is an agent
 * reading a 30-row boost window as "these are the only boosted tokens", and the
 * second risk is reading a feed row as tradeable when it carries no market data
 * at all.
 */
export const PROVIDER_FEED_WINDOW_NOTE =
  "DexScreener returns at most 30 rows per feed call and offers no pagination and no server-side "
  + "filter. This is the window it chose, not the full set of tokens carrying this signal — every "
  + "filter, sort and window in filtersApplied was applied by Vex to the rows below. These rows "
  + "carry NO price, liquidity, volume or pool address: resolve MANY rows in one call with "
  + "dexscreener.tokens (chain + comma-separated addresses, up to 60), or one token's full pool "
  + "list with dexscreener.tokenPairs.";

/**
 * Narrative-level honesty. §4.4: nine candidate sorts were ruled out against the
 * live feed, so the order is undisclosed and must never be called a ranking.
 */
export const PROVIDER_NARRATIVE_WINDOW_NOTE =
  "DexScreener returns these narratives in an order it does not disclose — nine candidate sorts "
  + "(market cap, liquidity, volume, token count and each market-cap change window) were tested "
  + "against the live feed and none reproduces it, so this is NOT a ranking and position carries "
  + "no meaning. It offers no server-side filter, sort, limit or pagination: every filter, sort "
  + "and window in filtersApplied was applied by Vex to the rows below.";

/**
 * Named for the agent, because DexScreener publishes no token decimals at all and
 * `rules/90-vex-project.md` requires a raw amount to travel with the decimals
 * needed to read it. Emitted only when the `decimalsAvailable` field is projected.
 */
export const TOKEN_DECIMALS_RESOLVER_NOTE =
  "DexScreener returns no token decimals, so no raw on-chain amount here can be converted. "
  + "Resolve decimals with khalani.tokens.search (EVM) or solana.tokens.search (Solana) before "
  + "using any raw amount.";

/**
 * What `providerOrder: "relevance"` actually means, for the one tool that has it.
 *
 * Proven three ways on the live API: `search?q=PEPE`, the same query with
 * `chainId`+`limit`+`sort`+`order`+`page`+`minLiquidity` appended, and the same
 * query with `chain=ethereum` all returned the IDENTICAL 30-pair set. The query
 * string is the only input DexScreener reads.
 */
export const SEARCH_PROVIDER_RELEVANCE_NOTE =
  "DexScreener chose these rows by its own undisclosed relevance across all chains at once, and "
  + "ignores every other query parameter. The order is not a ranking and is not stable. An empty "
  + "chain-filtered result does NOT mean the token has no pool on that chain — check "
  + "droppedByFilter, then call dexscreener.tokenPairs with the token address on that chain.";

export type ProviderOrder = "relevance" | "unspecified";

export interface ProviderWindow {
  endpoint: string;
  providerReturned: number;
  /** `null` = we have never observed this endpoint's cap. */
  providerCap: number | null;
  /** `null` for the same reason — an unknown cap cannot be reported as not hit. */
  providerCapped: boolean | null;
  providerOrder: ProviderOrder;
  note: string;
}

export interface ListEnvelope {
  asOfMs: number;
  providerWindow: ProviderWindow;
  /** Rows that survived every filter — BEFORE `offset`/`limit`. */
  totalMatched: number;
  /** Rows actually in the payload's row array. */
  returned: number;
  offset: number;
  hasMore: boolean;
  filtersApplied: Record<string, string | number | boolean | readonly string[]>;
  droppedByFilter: Record<string, number>;
  /**
   * A capped SAMPLE of dropped rows with the value each one lost by — present
   * only when `explainDrops` was requested, so the default payload is unchanged.
   * `droppedByFilter` above stays the full census either way.
   */
  droppedRows?: DroppedRowRecord[];
  droppedRowsTruncated?: boolean;
  /** Echo of `omitFields`. Present only when the caller supplied it. */
  fieldsOmitted?: string[];
  externalContentWarning: string;
  externalContentFields: string[];
  tokenDecimalsNote?: string;
}

/**
 * The name `../pair-list/` exports. Identical shape — one envelope, three
 * families — kept as an alias so the pair family's public surface is unchanged.
 */
export type PairListEnvelope = ListEnvelope;

export interface BuildEnvelopeInput {
  readonly endpoint: string;
  readonly providerOrder: ProviderOrder;
  readonly providerReturned: number;
  /** Omit for the measured 30-row cap; pass `null` where no cap was observed. */
  readonly providerCap?: number | null;
  /** Omit for {@link PROVIDER_WINDOW_NOTE}. */
  readonly note?: string;
  readonly asOfMs: number;
  readonly totalMatched: number;
  readonly returned: number;
  readonly offset: number;
  readonly filtersApplied: Record<string, string | number | boolean | readonly string[]>;
  readonly droppedByFilter: Record<string, number>;
  /** Omit unless `explainDrops` was requested — the default payload must not change. */
  readonly droppedRows?: DroppedRowRecord[];
  readonly droppedRowsTruncated?: boolean;
  /** Omit unless `omitFields` was supplied. */
  readonly fieldsOmitted?: readonly string[];
  readonly externalContentFields: string[];
  readonly includeDecimalsNote: boolean;
}

export function buildPairListEnvelope(input: BuildEnvelopeInput): ListEnvelope {
  const providerCap = input.providerCap === undefined ? PROVIDER_PAIR_CAP : input.providerCap;
  const envelope: ListEnvelope = {
    asOfMs: input.asOfMs,
    providerWindow: {
      endpoint: input.endpoint,
      providerReturned: input.providerReturned,
      providerCap,
      providerCapped: providerCap === null ? null : input.providerReturned >= providerCap,
      providerOrder: input.providerOrder,
      note: input.note ?? PROVIDER_WINDOW_NOTE,
    },
    totalMatched: input.totalMatched,
    returned: input.returned,
    offset: input.offset,
    hasMore: input.offset + input.returned < input.totalMatched,
    filtersApplied: input.filtersApplied,
    droppedByFilter: input.droppedByFilter,
    externalContentWarning: EXTERNAL_CONTENT_WARNING,
    externalContentFields: input.externalContentFields,
  };
  // Every optional key below is assigned ONLY when the caller asked for the
  // feature. A payload that carries `droppedRows: []` or `fieldsOmitted: []` on
  // a default call has changed the default call, which is the one thing the
  // byte budget cannot absorb.
  if (input.droppedRows !== undefined) {
    envelope.droppedRows = input.droppedRows;
    envelope.droppedRowsTruncated = input.droppedRowsTruncated ?? false;
  }
  if (input.fieldsOmitted !== undefined) envelope.fieldsOmitted = [...input.fieldsOmitted];
  if (input.includeDecimalsNote) envelope.tokenDecimalsNote = TOKEN_DECIMALS_RESOLVER_NOTE;
  return envelope;
}
