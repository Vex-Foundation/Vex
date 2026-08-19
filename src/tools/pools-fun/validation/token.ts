/**
 * `/discover` row + page validators.
 *
 * Strict: `tokenAddress`, `poolId`, `platform`, `pairedAsset`, `deployedAt`.
 * Those five are the answer to "which token, in which pool, from which
 * launcher, paired against what, launched when" - every one of them is either
 * an identity the agent must not confuse or the input to a filter, and a wrong
 * value there is worse than a failed read.
 *
 * Everything else is display-tolerant. `decimals` and `totalSupply` are typed
 * and parsed but never projected: pools.fun rows send them as null and sushi
 * rows send real values, and the difference is not something a tool output
 * should teach an agent to reason about when the on-chain read is one call away.
 */

import { z } from "zod";
import type { PoolsDiscoverPage, PoolsToken } from "../types.js";
import { POOLS_CHAIN_SLUG, POOLS_ROW_PLATFORMS } from "../constants.js";
import {
  address,
  displayNumber,
  displayRawString,
  displayString,
  isoTimestamp,
  parseOrThrow,
} from "./_shared.js";

/**
 * The launcher that produced the row. STRICT, and the reason this whole module
 * exists: the same endpoint serves three launchpads, and mistaking one for
 * another puts the agent on a token whose pool, fee model and locker are all
 * different.
 */
const platform = z.enum(POOLS_ROW_PLATFORMS);

/**
 * The chain a row claims to be on, pinned to a LITERAL.
 *
 * The client always sends `chain=robinhood`, but "we asked for X" is not
 * evidence that the answer is X: omitting the parameter makes this provider
 * answer for Base, so a Base-shaped row is a response this API demonstrably
 * produces. Accepting any string here meant such a row would validate, and the
 * handler would then stamp `chain: "robinhood"` on the envelope above it - Vex
 * relabelling another chain's token as Robinhood, which is a wrong ANSWER
 * rather than a failed read. The literal makes that impossible: a row from
 * anywhere else is refused with the field named.
 */
const chain = z.literal(POOLS_CHAIN_SLUG, {
  error: `expected a ${POOLS_CHAIN_SLUG} row - pools.fun tools are pinned to Robinhood Chain`,
});

/**
 * `pairedAsset` is strict but NOT an enum: `weth`/`usdg`/`stock` are the three
 * values measured, and a fourth would be a new curve the owner registered, not
 * a malformed row. Rejecting an unknown one would take down the whole page over
 * a token we merely have nothing to say about.
 */
const pairedAsset = z.string().min(1, { error: "expected a paired-asset name" });

/** Present only on `pairedAsset: "stock"` rows (measured live on AAPL Cat). */
const pairedStock = z
  .object({ address, symbol: z.string() })
  .nullish()
  .transform((v) => v ?? null);

const poolsTokenSchema: z.ZodType<PoolsToken> = z.object({
  tokenAddress: address,
  // The Sushi V3 pool address. Verified against `PartyLocker.getPoolInfo` on
  // pools.fun rows - the key is named "id" but the value is an address.
  poolId: address,
  chain,
  platform,
  pairedAsset,
  pairedStock,
  name: displayString,
  symbol: displayString,
  decimals: displayNumber,
  totalSupply: displayRawString,
  imageUri: displayString,
  deployerAddress: displayString,
  deployerXUsername: displayString,
  feeRecipientAddress: displayString,
  feeRecipientXUsername: displayString,
  tweetUrl: displayString,
  websiteUrl: displayString,
  deployedAt: isoTimestamp,
  lastTradeAt: displayString,
  lastPriceEth: displayNumber,
  lastPriceUsd: displayNumber,
  marketCapUsd: displayNumber,
  vol1m: displayNumber,
  vol5m: displayNumber,
  vol1h: displayNumber,
  vol6h: displayNumber,
  vol24h: displayNumber,
  txCount24h: displayNumber,
  priceChange1m: displayNumber,
  priceChange5m: displayNumber,
  priceChange1h: displayNumber,
  priceChange6h: displayNumber,
  priceChange24h: displayNumber,
});

/**
 * A page. `nextCursor` is optional/nullable because the provider sends `null`
 * both on the last page and on an empty result - and an empty result is a legit
 * market state, never an error.
 */
const discoverPageSchema: z.ZodType<PoolsDiscoverPage> = z.object({
  results: z.array(poolsTokenSchema),
  nextCursor: z.string().nullish().transform((v) => v ?? null),
});

/** Validate a `/discover` response. */
export function validateDiscoverPage(raw: unknown): PoolsDiscoverPage {
  return parseOrThrow(discoverPageSchema, raw);
}
