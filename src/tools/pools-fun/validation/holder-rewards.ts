/**
 * `GET /pools-fun/launch-assets` and `GET /pools-fun/holder-rewards` validators.
 *
 * Both endpoints are undocumented; the only description of them that exists is
 * the bytes under `src/__tests__/pools-fun/fixtures/live-captures/`, which is
 * why every field below is grounded in a capture rather than in a shape someone
 * expected.
 *
 * The tolerant-reader split of `_shared.ts` applies unchanged, with one addition
 * this file needs and the others did not: `rawAmount`. Holder-reward figures are
 * uint256 base units - `earned`, `eligibleSupply`, `rewardRate` - and every one
 * of them stays a STRING. Passing a `21411342948320499326971591` through
 * `Number` is the precision loss rule 90 exists to prevent, and these amounts
 * are shown to a human beside a wallet balance.
 */

import { z } from "zod";
import type {
  PoolsHolderRewards,
  PoolsLaunchAssets,
} from "../types.js";
import { address, displayNumber, displayRawString, displayString, parseOrThrow } from "./_shared.js";

/**
 * A raw base-unit amount. String or number on the wire (only strings measured),
 * always a string afterwards, `null` when absent.
 */
const rawAmount = displayRawString;

/**
 * One launchable stock. STRICT on `address` and `symbol`: the address is what a
 * launch would be paired against and the symbol is how a human picks it, so a
 * malformed row is a row that must not be offered rather than one to display
 * tolerantly. `name` is display copy.
 */
const launchAssetSchema = z.object({
  symbol: z.string().min(1, { error: "expected a stock symbol" }),
  name: z.string(),
  address,
});

const launchAssetsSchema: z.ZodType<PoolsLaunchAssets> = z.object({
  chain: z.string(),
  stocks: z.array(launchAssetSchema),
});

/** Validate a `/pools-fun/launch-assets` response. */
export function validateLaunchAssets(raw: unknown): PoolsLaunchAssets {
  return parseOrThrow(launchAssetsSchema, raw);
}

/**
 * The holder-rewards read.
 *
 * `token` and `distributor` are STRICT because the distributor address is the
 * anchor every on-chain cross-check hangs off: it is compared against the
 * address the suite's deployer actually emitted, and a malformed one would make
 * that comparison meaningless rather than failing it. Everything else is
 * display-tolerant - the whole body is the provider's echo of contract state.
 */
const holderRewardsSchema: z.ZodType<PoolsHolderRewards> = z.object({
  token: address,
  distributor: address,
  pairedAsset: displayString,
  pairedSymbol: displayString,
  pairedDecimals: displayNumber,
  wallet: displayString,
  rewardMode: displayString,
  paysCallerBounty: z.boolean().nullish().transform((v) => (typeof v === "boolean" ? v : null)),
  conversion: displayString,
  earned: rawAmount,
  earnedPaired: rawAmount,
  walletExcluded: z.boolean().nullish().transform((v) => (typeof v === "boolean" ? v : null)),
  eligibleSupply: rawAmount,
  rewardRate: rawAmount,
  rewardRatePaired: rawAmount,
  periodFinish: displayNumber,
  periodFinishPaired: displayNumber,
  remainingStream: rawAmount,
  remainingStreamPaired: rawAmount,
  surplus: rawAmount,
  surplusPaired: rawAmount,
  buybackBacklog: rawAmount,
  lastBuybackAt: displayNumber,
  pendingFees: z
    .object({ token: rawAmount, paired: rawAmount })
    .nullish()
    .transform((v) => v ?? null),
  hasWorkToDistribute: z.boolean().nullish().transform((v) => (typeof v === "boolean" ? v : null)),
});

/** Validate a `/pools-fun/holder-rewards` response. */
export function validateHolderRewards(raw: unknown): PoolsHolderRewards {
  return parseOrThrow(holderRewardsSchema, raw);
}
