/**
 * Token validators for `/api/tokens`, `/api/token`, `/api/search`.
 *
 * The graduated block is modelled as all-or-nothing: a `preprocess` step lifts
 * the five top-level wire fields (`launched`/`pair`/`currency0`/`currency1`/
 * `poolId`) into a nested `graduation` object and stamps a `graduated`
 * discriminant, so a partially-present block cannot type-check. `launched` is a
 * ms TIMESTAMP here — never the request's boolean. Financial fields
 * (`token`/`price`/`supply`/`time`, graduated block) are strict; everything else
 * is display-tolerant.
 */

import { z } from "zod";
import { isRecord } from "../../../utils/validation-helpers.js";
import type { TrenchToken } from "../types.js";
import {
  address,
  displayBoolean,
  displayNumber,
  displayString,
  financialNumber,
  parseOrThrow,
  poolId,
} from "./_shared.js";

const stats24hSchema = z
  .object({
    volume: displayNumber,
    txns: displayNumber,
    priceChangePct: displayNumber,
  })
  .nullish()
  .transform((v) => v ?? null);

/** 0-4 social links; missing/null → `[]`. Non-string entries reject (untrusted text stays typed). */
const linksSchema = z
  .array(z.string())
  .max(4, { error: "expected at most 4 links" })
  .nullish()
  .transform((v) => v ?? []);

/** Fields common to every token row. Unknown wire keys are stripped by Zod. */
const baseTokenShape = {
  token: address,
  price: financialNumber,
  supply: financialNumber,
  time: financialNumber,
  creator: displayString,
  name: displayString,
  symbol: displayString,
  description: displayString,
  imageCid: displayString,
  links: linksSchema,
  holders: displayNumber,
  stats24h: stats24hSchema,
  ruggedFlagged: displayBoolean,
  _id: displayString,
} as const;

const graduationSchema = z.object({
  launched: financialNumber,
  pair: address,
  currency0: address,
  currency1: address,
  poolId,
});

const bondingSchema = z.object({ ...baseTokenShape, graduated: z.literal(false) });
const graduatedSchema = z.object({
  ...baseTokenShape,
  graduated: z.literal(true),
  graduation: graduationSchema,
});

/**
 * One token row. `preprocess` groups the graduated block before the discriminated
 * union runs, so "some graduated fields but not all" fails validation rather than
 * silently producing a half-graduated token.
 */
export const trenchTokenSchema: z.ZodType<TrenchToken> = z.preprocess((raw) => {
  if (!isRecord(raw)) return raw;
  const graduated = raw.poolId !== undefined && raw.poolId !== null;
  if (!graduated) {
    return { ...raw, graduated: false };
  }
  return {
    ...raw,
    graduated: true,
    graduation: {
      launched: raw.launched,
      pair: raw.pair,
      currency0: raw.currency0,
      currency1: raw.currency1,
      poolId: raw.poolId,
    },
  };
}, z.discriminatedUnion("graduated", [bondingSchema, graduatedSchema]));

const tokenListSchema = z.array(trenchTokenSchema);

/** Validate a `/api/tokens` or `/api/search` array response. */
export function validateTokenList(raw: unknown): TrenchToken[] {
  return parseOrThrow(tokenListSchema, raw);
}

/** Validate a single `/api/token` object response. */
export function validateToken(raw: unknown): TrenchToken {
  return parseOrThrow(trenchTokenSchema, raw);
}
