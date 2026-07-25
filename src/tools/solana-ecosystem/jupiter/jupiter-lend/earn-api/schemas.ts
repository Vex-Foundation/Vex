/**
 * Zod response schemas for the Jupiter Lend Earn REST API
 * (/lend/v1/earn/{tokens,positions,earnings,deposit,withdraw,mint,redeem,
 * *-instructions}).
 *
 * codex-002: these gate the SHAPE of earn responses at the HTTP boundary
 * before the values feed transaction signing. The high-risk POST endpoints
 * return either a base64 transaction blob (`service.ts` signs
 * `raw.transaction` via `signAndSendVersionedTx`, which base64-decodes it) or
 * a set of Solana instructions that get assembled and signed locally — those
 * financial fields are validated FIRMLY (base64 blob, base58 programId/account
 * pubkeys, base64 instruction `data`). Read-only display endpoints (tokens,
 * positions, earnings) are validated permissively.
 *
 * Every object `.passthrough()`es unknown keys: the Jupiter Lend service
 * forwards the raw upstream response downstream (`raw` on every result), so the
 * upstream API can add fields without breaking us.
 *
 * Zod gates shape only; it cannot prove a transaction is economically safe.
 * Downstream deserialize/sign checks remain the source of truth for that.
 *
 * The schemas are intentionally NOT the type source of truth — the wire
 * interfaces in `types.ts` remain canonical, and each client function's
 * declared return type makes `tsc` verify the inferred schema output is
 * assignable to that interface.
 *
 * NOTE on error paths: unlike the swaps `/order` endpoint, the earn service
 * has NO 200-level "falsey transaction + errorCode" domain-error mapping —
 * `service.ts:59` signs `raw.transaction` directly and neither the service nor
 * the consumer (`vex-agent .../handlers/lend.ts`) maps an empty/errored body to
 * a domain error. The tx blob is therefore required to be base64 with no
 * permissive escape; a malformed/empty body correctly surfaces as
 * HTTP_RESPONSE_INVALID instead of being passed to the signer.
 */

import { z } from "zod";
import {
  base64String,
  solanaInstructionWireSchema,
} from "../../../shared/schemas.js";
import type {
  JupiterLendEarnEarningsResponse,
  JupiterLendEarnInstructionResponse,
  JupiterLendEarnPositionsResponse,
  JupiterLendEarnTokensResponse,
  JupiterLendEarnTransactionResponse,
} from "./types.js";

/** Either a string or a number — upstream is inconsistent on some scalars. */
const stringOrNumber = z.union([z.string(), z.number()]);

/**
 * `JupiterLendEarnAssetInfo` — read-only display, permissive.
 *
 * LIVE-GATE FIX 1 (2026-07-24): confirmed live against `GET /earn/tokens`
 * that the provider renamed this whole sub-object to camelCase
 * (`chainId`/`logoUrl`/`coingeckoId`) — NOT a type change on the snake_case
 * fields as first suspected; the old keys are simply absent now. All three
 * are display-only (never read by any handler/projector — grep-confirmed),
 * so per the tolerant-reader doctrine they become optional rather than
 * chasing the rename; `.passthrough()` already carries the new camelCase
 * keys through untyped for any future consumer.
 */
const earnAssetInfoSchema = z
  .object({
    address: z.string(),
    chain_id: stringOrNumber.optional(),
    name: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    logo_url: z.string().optional(),
    price: stringOrNumber,
    coingecko_id: z.string().optional(),
  })
  .passthrough();

/** `JupiterLendLiquiditySupplyData` — read-only display, permissive. */
const liquiditySupplyDataSchema = z
  .object({
    modeWithInterest: z.boolean(),
    supply: z.string(),
    withdrawalLimit: z.string(),
    lastUpdateTimestamp: z.string(),
    expandPercent: z.string(),
    expandDuration: z.string(),
    baseWithdrawalLimit: z.string(),
    withdrawableUntilLimit: z.string(),
    withdrawable: z.string(),
  })
  .passthrough();

/** `JupiterLendEarnTokenInfo` — read-only display, permissive. */
const earnTokenInfoSchema = z
  .object({
    id: stringOrNumber,
    address: z.string(),
    name: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    assetAddress: z.string(),
    asset: earnAssetInfoSchema,
    totalAssets: z.string(),
    totalSupply: z.string(),
    convertToShares: z.string(),
    convertToAssets: z.string(),
    rewardsRate: stringOrNumber,
    supplyRate: stringOrNumber,
    totalRate: stringOrNumber,
    rebalanceDifference: z.string(),
    liquiditySupplyData: liquiditySupplyDataSchema,
  })
  .passthrough();

/** `GET /tokens` — array of token info. Read-only display. */
export const jupiterLendEarnTokensResponseSchema: z.ZodType<JupiterLendEarnTokensResponse> =
  z.array(earnTokenInfoSchema);

/** `JupiterLendEarnUserPosition` — read-only display, permissive. */
const earnUserPositionSchema = z
  .object({
    token: earnTokenInfoSchema,
    ownerAddress: z.string(),
    shares: z.string(),
    underlyingAssets: z.string(),
    underlyingBalance: z.string(),
    allowance: z.string(),
  })
  .passthrough();

/** `GET /positions` — array of positions. Read-only display. */
export const jupiterLendEarnPositionsResponseSchema: z.ZodType<JupiterLendEarnPositionsResponse> =
  z.array(earnUserPositionSchema);

/**
 * `JupiterLendEarnEarningsItem` — read-only display, permissive.
 *
 * LIVE-GATE FIX 2 (2026-07-24): confirmed live against `GET /earn/earnings`
 * that `earnings` is now a numeric STRING (e.g. `"0"`), not a JSON number —
 * this is the actual root cause behind the `solana.lend.positions` schema
 * failure (that handler always calls `/earnings` as a sub-step once any
 * position row exists), not a shape drift on `/earn/positions` itself, which
 * still parses cleanly. Display-only (never read by any handler/projector —
 * grep-confirmed, `handlers/lend.ts` passes the array straight through), so
 * per the tolerant-reader doctrine it becomes `stringOrNumber` rather than
 * a strict `z.number()`.
 */
const earnEarningsItemSchema = z
  .object({
    address: z.string(),
    ownerAddress: z.string(),
    earnings: stringOrNumber,
    slot: z.number(),
  })
  .passthrough();

/**
 * `GET /earnings` — upstream docs are inconsistent (single object vs array), so
 * the wire type is a union and the schema mirrors both. Read-only display.
 */
export const jupiterLendEarnEarningsResponseSchema: z.ZodType<JupiterLendEarnEarningsResponse> =
  z.union([earnEarningsItemSchema, z.array(earnEarningsItemSchema)]);

/**
 * Transaction-returning POST endpoints (/deposit, /withdraw, /mint, /redeem).
 * FINANCIAL: `transaction` is base64-decoded and signed (`service.ts:59`), so
 * it must be a non-empty standard-base64 blob. There is no 200-level error
 * escape on this endpoint (see file header), so we firm it with no nullable /
 * empty allowance.
 */
export const jupiterLendEarnTransactionResponseSchema: z.ZodType<JupiterLendEarnTransactionResponse> =
  z
    .object({
      transaction: base64String,
    })
    .passthrough();

/**
 * Envelope shape of the instruction response: `{ instructions: [...] }`.
 * FINANCIAL: each instruction's programId/account pubkeys and base64 `data`
 * are firmed via `solanaInstructionWireSchema`.
 */
const instructionEnvelopeSchema = z
  .object({
    instructions: z.array(solanaInstructionWireSchema),
  })
  .passthrough();

/**
 * Instruction-returning POST endpoints (/deposit-instructions, etc.).
 * Upstream docs are inconsistent: a single instruction object OR an
 * `{ instructions: [...] }` envelope. The service normalizes both, and both
 * branches feed local assembly + signing, so both are firmed. Envelope is
 * tried first; a bare instruction lacks `instructions` and an envelope lacks
 * `programId`, so the branches are mutually exclusive.
 */
export const jupiterLendEarnInstructionResponseSchema: z.ZodType<JupiterLendEarnInstructionResponse> =
  z.union([instructionEnvelopeSchema, solanaInstructionWireSchema]);
