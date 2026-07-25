/**
 * Zod response schemas for the Jupiter Lend Borrow REST API
 * (/lend/v1/borrow/{vaults,positions,operate}).
 *
 * Rebuilt (Batch 5 card B3) from a live fixture recording — see
 * `../../../../../__tests__/solana/fixtures/lend-borrow/README.md`. Same
 * discipline as `../earn-api/schemas.ts` (codex-002): read-only display
 * endpoints (vaults, positions) are validated permissively; the `/operate`
 * response feeds transaction signing (`prepareVersionedTx` base64-decodes
 * `transaction`), so THAT field is firmed with no nullable/empty allowance —
 * no documented error/rejection response shape exists for `/operate`
 * (verified live: same "no error shape documented" gap `earn-api` already
 * flagged for deposit/withdraw), so a malformed/empty body correctly
 * surfaces as HTTP_RESPONSE_INVALID instead of reaching the signer.
 *
 * Every object `.passthrough()`es unknown keys — upstream can add fields
 * without breaking us; the wire interfaces in `types.ts` stay canonical.
 * Only fields this shelf actually reads are required here — the live
 * fixture's OWN example responses omit many liquidity/oracle/reward fields
 * from any single vault's shape variance across markets, so this schema
 * does not require anything beyond what `borrow-projector.ts`/
 * `borrow-risk-preview.ts`/`handlers/lend-borrow.ts` consume.
 *
 * Card B4 (Codex blocker): "permissive" only ever meant unknown-key
 * passthrough — every FIELD this shelf actually consumes financially now
 * gets real runtime validation, not just a `string`/`number` type badge:
 * `supplyToken`/`borrowToken.address` (feed `getJupiterPricesByMint`, ATA
 * derivation, and the WSOL pre-funding check) and `ownerAddress` (feeds a
 * wallet-identity match in `borrow-risk-preview.ts` — never trust an
 * unvalidated string there) are real base58 Solana addresses (32-byte
 * decode, reusing the repo's existing `validateSolanaAddress`, not merely a
 * regex); `collateralFactor`/`liquidationThreshold`/`borrowable`/
 * `withdrawable`/`minimumBorrowing`/`supply`/`borrow`/`dustBorrow` (all feed
 * `BigInt()` arithmetic or percent-string math downstream) are UNSIGNED
 * base-10 digit strings — a signed or decimal-point value would either throw
 * an uncaught `SyntaxError` out of `BigInt()` or silently misrepresent risk;
 * `id`/`vaultId`/`nftId` are non-negative integers (`nftId` becomes a
 * subsequent `positionId` agent param); `decimals` is bounded to the valid
 * SPL range (`u8`, realistically 0-12, never above 18).
 */

import { z } from "zod";
import { base64String } from "../../../shared/schemas.js";
import { validateSolanaAddress } from "../../../shared/solana-validation.js";
import type {
  JupiterLendBorrowOperateResponse,
  JupiterLendBorrowPositionsResponse,
  JupiterLendBorrowVaultsResponse,
} from "./types.js";

function isValidSolanaAddress(value: string): boolean {
  try {
    validateSolanaAddress(value);
    return true;
  } catch {
    return false;
  }
}

/** A real base58 Solana address (full 32-byte decode, not a charset/length regex) — see the module doc's Card B4 note. */
const solanaAddress = z.string().refine(isValidSolanaAddress, "expected a valid base58 Solana address");

/** An unsigned base-10 integer string — the wire convention for every liquidity/collateral/debt/threshold field on this shelf (never negative, never a decimal point). */
const unsignedDigitString = z.string().regex(/^\d+$/, "expected an unsigned base-10 integer string");

/** SPL token decimals: `u8` on-chain, but no real mint exceeds ~12 in practice — bounded here to the protocol-wide ceiling. */
const splDecimals = z.number().int().nonnegative().max(18);

/** `JupiterLendBorrowToken` (nested on `supplyToken`/`borrowToken`) — read-only display, permissive on unknown keys, strict on the fields this shelf consumes. */
const borrowTokenSchema = z
  .object({
    address: solanaAddress,
    chainId: z.string(),
    name: z.string(),
    symbol: z.string(),
    uiSymbol: z.string(),
    decimals: splDecimals,
    price: z.string(),
  })
  .passthrough();

/** `JupiterLendBorrowVault` — read-only display, permissive on unknown keys, strict on the fields this shelf consumes. */
const borrowVaultSchema = z
  .object({
    id: z.number().int().nonnegative(),
    address: z.string(),
    supplyToken: borrowTokenSchema,
    borrowToken: borrowTokenSchema,
    collateralFactor: unsignedDigitString,
    liquidationThreshold: unsignedDigitString,
    borrowable: unsignedDigitString,
    withdrawable: unsignedDigitString,
    minimumBorrowing: unsignedDigitString,
  })
  .passthrough();

/** `GET /borrow/vaults` — array of vault configs. Read-only display. */
export const jupiterLendBorrowVaultsResponseSchema: z.ZodType<JupiterLendBorrowVaultsResponse> =
  z.array(borrowVaultSchema);

/** `JupiterLendBorrowPosition` — read-only display, permissive on unknown keys, strict on the fields this shelf consumes. */
const borrowPositionSchema = z
  .object({
    id: z.number().int().nonnegative(),
    vaultId: z.number().int().nonnegative(),
    ownerAddress: solanaAddress,
    supply: unsignedDigitString,
    borrow: unsignedDigitString,
    dustBorrow: unsignedDigitString,
    // W4 — TOLERANT on presence, STRICT on type. The provider's liquidation
    // flag is a safety signal the projector reads, but the only recorded live
    // response for this endpoint is `[]`, so the field's presence on a real
    // row is documented, not proven: requiring it would fail an entire
    // positions read over a missing display field (`rules/90-vex-project.md`'s
    // tolerant-reader rule, written after three live outages of exactly that
    // shape). A non-boolean VALUE is still rejected — silently coercing
    // `"false"`/`0` into a liquidation verdict is the failure this guards.
    // Absent/null becomes the named `"unknown"` status, never `false`.
    isLiquidated: z.boolean().nullish(),
  })
  .passthrough();

/** `GET /borrow/positions` — array of positions. Read-only display. */
export const jupiterLendBorrowPositionsResponseSchema: z.ZodType<JupiterLendBorrowPositionsResponse> =
  z.array(borrowPositionSchema);

/**
 * `POST /borrow/operate` response. FINANCIAL: `transaction` is base64-decoded
 * and signed (`prepareVersionedTx`), so it must be a non-empty standard-base64
 * blob with no permissive escape. `nftId` is a non-negative JSON integer
 * (confirmed live) — it becomes a subsequent `positionId` agent param.
 */
export const jupiterLendBorrowOperateResponseSchema: z.ZodType<JupiterLendBorrowOperateResponse> =
  z
    .object({
      nftId: z.number().int().nonnegative(),
      transaction: base64String,
    })
    .passthrough();
