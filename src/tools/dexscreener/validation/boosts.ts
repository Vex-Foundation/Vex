/**
 * Boost validator — `/token-boosts/latest/v1` and `/token-boosts/top/v1`.
 *
 * IDENTITY STRICT, DISPLAY TOLERANT. `url` / `chainId` / `tokenAddress` are
 * required because without them the row cannot be acted on or merged (the
 * attention feed keys on `chainId:tokenAddress`); all three are live-present on
 * 30/30 rows of both endpoints. The amounts are display-only promotional
 * credits and are nullable — `top/v1` omits `amount` on every row, and
 * requiring it made `dexscreener.boosts.top` throw on 100% of calls.
 *
 * A malformed row is SKIPPED AND COUNTED instead of throwing the feed away, so
 * one bad element cannot blind the agent to the other 29. The count travels
 * with the data (`DexBoostFeed.skipped`) so a degraded feed cannot be mistaken
 * for a healthy one — element-skipping without a count is how a feed silently
 * empties.
 *
 * `parseBoost` (throwing, single-row) is retained for the WS handshake, which
 * validates one row at a time and has no feed to degrade.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import type { DexBoost, DexBoostFeed } from "../types.js";
import { asOptionalNumber, asOptionalString, asString, linksSchema, parseOrThrow } from "./_shared.js";

const boostObjectSchema: z.ZodType<DexBoost> = z
  .object({
    url: asString("boost.url"),
    chainId: asString("boost.chainId"),
    tokenAddress: asString("boost.tokenAddress"),
    // Display-only, and the two endpoints disagree about which is sent. See
    // the module docstring and `DexBoost` for why neither is required.
    amount: asOptionalNumber,
    totalAmount: asOptionalNumber,
    icon: asOptionalString,
    header: asOptionalString,
    description: asOptionalString,
    links: linksSchema,
  })
  .transform((b) => ({
    url: b.url,
    chainId: b.chainId,
    tokenAddress: b.tokenAddress,
    amount: b.amount,
    totalAmount: b.totalAmount,
    icon: b.icon,
    header: b.header,
    description: b.description,
    links: b.links,
  }));

export function parseBoost(raw: unknown): DexBoost {
  if (!isRecord(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: boost must be an object");
  }
  return parseOrThrow(boostObjectSchema, raw);
}

/**
 * Parse a boost feed element-wise. A non-array root is still fatal: that is a
 * whole-response shape error, not one bad row, and silently returning an empty
 * feed would hide it.
 */
export function validateBoostsResponse(raw: unknown): DexBoostFeed {
  if (!Array.isArray(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: expected boosts array");
  }
  const boosts: DexBoost[] = [];
  let skipped = 0;
  for (const row of raw) {
    try {
      boosts.push(parseBoost(row));
    } catch {
      skipped += 1;
    }
  }
  return { boosts, skipped };
}
