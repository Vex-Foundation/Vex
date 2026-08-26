/**
 * Scope and window params for the site screening family: WHICH pairs the
 * provider considers, and over WHAT window it measures them.
 *
 * Every list param is `type: "string"` with `acceptsStringArray: true`, because
 * `ProtocolParamDef` has no array member; that pair compiles to an `anyOf` of
 * string and string array, so both spellings are accepted.
 *
 * The two traps in this block are documented in the params themselves rather
 * than in a comment, because the agent reads the param and never reads this
 * file: `excludeDexIds` REPLACES a hidden provider default and can make a
 * result set larger, and `window` both selects the ranked metric and excludes
 * pairs that were inactive in it.
 */

import type { ProtocolParamDef } from "../../../types.js";
import {
  SCREEN_CHAIN_VOCABULARY_CLAUSE,
  STRING_OR_ARRAY_CLAUSE,
} from "./clauses.js";

/** The four windows the provider measures, in its own order. */
export const SCREEN_WINDOW_VALUES = ["m5", "h1", "h6", "h24"] as const;

export const SCREEN_SCOPE_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "chainIds",
    type: "string",
    acceptsStringArray: true,
    description:
      "DexScreener chain slugs to screen, for example solana, base, ethereum, bsc. Omit to screen "
      + `every indexed chain at once. ${STRING_OR_ARRAY_CLAUSE} ${SCREEN_CHAIN_VOCABULARY_CLAUSE}`,
  },
  {
    key: "dexIds",
    type: "string",
    acceptsStringArray: true,
    description:
      "DEX identifiers to keep, for example raydium, uniswap, pumpswap. Multiple values are ORed: "
      + "a pair on any listed dex is kept. The accepted set is open and per-chain, so read it from "
      + `dexscreener__chains_list rather than guessing. ${STRING_OR_ARRAY_CLAUSE}`,
  },
  {
    key: "excludeDexIds",
    type: "string",
    acceptsStringArray: true,
    description:
      "DEX identifiers to drop. DANGEROUS BY CONSTRUCTION: the provider applies a hidden default "
      + "that already excludes bonding-curve venues, and sending this key AT ALL replaces that "
      + "default, so excluding one dex can make the result set BIGGER. Measured on solana: 53,094 "
      + "rows normally, 84,058 when only PumpSwap was excluded. Use includeLaunchpadPairs for the "
      + `common case; exclusionDefaultReplaced reports whenever this happened. ${STRING_OR_ARRAY_CLAUSE}`,
  },
  {
    key: "labels",
    type: "string",
    acceptsStringArray: true,
    description:
      "Pool label values to keep, for example v2, v3, v4, CLMM, DLMM, CPMM. Matching is "
      + `case-insensitive on the provider. ${STRING_OR_ARRAY_CLAUSE}`,
  },
  {
    key: "metaIds",
    type: "string",
    acceptsStringArray: true,
    description:
      "Narrative IDs to keep, taken from dexscreener__narratives_list. Send the ID and not the "
      + "human-readable name: the provider accepts a name, matches nothing, and answers with zero "
      + "rows, which reads as an empty market rather than as a wrong value. "
      + STRING_OR_ARRAY_CLAUSE,
  },
  {
    key: "launchpadIds",
    type: "string",
    acceptsStringArray: true,
    description:
      "Launchpad identifiers to keep, for example pumpfun, launchlab, meteoradbc, bags, "
      + "fourmeme. MEASURED: the provider attaches a launchpad id to a pair only AFTER it "
      + "graduates, so this filter matches graduated pairs and nothing else. While a curve is "
      + "still running the launchpad is the pair's DEX, so use dexIds with the same value there "
      + "(dexIds: pumpfun). On dexscreener__launchpad_pairs_list, pairing this with "
      + "stage: \"bonding\" is refused by name rather than answered with an empty board: it "
      + "returned 0 rows of a 0-row population while dexIds returned 53,478. "
      + "KNOWN DEPTH GAP: no tool on this surface enumerates the launchpad vocabulary - "
      + "dexscreener__chains_list carries dex ids only - so the five spellings above are the "
      + "list, measured live, and an id outside them is not refused by name the way an "
      + "unknown chain slug is. It returns an empty board instead, so check your spelling "
      + "against those five before reading a zero as an absence of launches. "
      + STRING_OR_ARRAY_CLAUSE,
  },
  {
    key: "baseTokenSuffixes",
    type: "string",
    acceptsStringArray: true,
    description:
      "Base-token mint-address suffixes to keep, the vanity-suffix convention some launchpads "
      + "use. Measured on solana: pump matched 20,852 pairs and bonk matched 1,595. "
      + STRING_OR_ARRAY_CLAUSE,
  },
  {
    key: "includeLaunchpadPairs",
    type: "boolean",
    description:
      "Lift the provider's hidden exclusion of bonding-curve pairs, the safe alternative to "
      + "excludeDexIds. Defaults to false. Measured on solana: 53,094 rows becomes 102,676. Named "
      + "for the effect rather than the mechanism, because the mechanism is an empty exclusion "
      + "list.",
  },
];

export const SCREEN_WINDOW_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "window",
    type: "string",
    enum: SCREEN_WINDOW_VALUES,
    description:
      "The stats window the ranking measures over: m5, h1, h6 or h24. Defaults to h24. It has a "
      + "DUAL role and both halves matter: it selects which window's volume, transactions, buys, "
      + "sells and price change are ranked and reported, AND it excludes pairs that had no "
      + "activity in that window. Use includeInactive to keep the ranking and drop the gate.",
  },
  {
    key: "includeInactive",
    type: "boolean",
    description:
      "Keep pairs that had no activity inside the selected window. Defaults to false. Measured on "
      + "solana at m5: 2,513 rows becomes 53,088, so this widens the set enormously on short "
      + "windows and barely at all on h24.",
  },
  {
    key: "thresholdWindow",
    type: "string",
    enum: SCREEN_WINDOW_VALUES,
    description:
      "Which window the volume, transaction, buy, sell and price-change thresholds measure over: "
      + "m5, h1, h6 or h24. Defaults to whatever window is set. Separating the two is how the "
      + "site's own boards work, ranking by 5-minute price change while requiring 24-hour "
      + "transaction and liquidity floors.",
  },
];
