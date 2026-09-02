/**
 * The DURABLE vocabulary of `wallet_wrap_intents` (migration 096).
 *
 * Same boundary discipline as `./wallet-transaction-intent.ts`: a row read back
 * from PostgreSQL is external input, these schemas are the ONE place bytes
 * become types, and every amount is a decimal integer string in base units
 * because rule 90 keeps floating point away from money.
 *
 * The lifecycle vocabulary (statuses, failure stages) and the fee-bounds shape
 * are IMPORTED from the transaction contract rather than restated. Those are
 * genuinely shared vocabulary - the same nine states, the same gas caps - and a
 * second copy would be a second source of truth that drifts. What is NOT shared
 * is the intent SHAPE, which is why this file exists at all.
 *
 * There is no fee field here, and there is no place to add one without editing
 * this file, migration 096 and the 088 kind/role binding together. That is the
 * intended cost.
 */

import { z } from "zod";

import {
  WALLET_TRANSACTION_FAILURE_STAGES,
  WALLET_TRANSACTION_INTENT_STATUSES,
  WalletTransactionFeeBoundsSchema,
  type WalletTransactionFailureStage,
  type WalletTransactionFeeBounds,
  type WalletTransactionIntentStatus,
} from "./wallet-transaction-intent.js";

export { WALLET_TRANSACTION_FAILURE_STAGES as WALLET_WRAP_FAILURE_STAGES };

/**
 * The wrap table's OWN status vocabulary. It was an alias of the transaction
 * table's until the wrap lane needed a status that lane does not have, and the
 * alias was only ever true by coincidence: two tables, two CHECKs, two
 * vocabularies. Aliasing again would let this table's parser accept a status
 * migration 087's CHECK forbids, and vice versa.
 *
 * `review_required` is the addition, and it is not a new idea: migration 093
 * gave `wallet_intents` the same status with the same invariant (a real
 * transaction exists, so the hash is REQUIRED). It is the honest durable state
 * for a wrap whose transaction CONFIRMED but whose receipt proved a quantity
 * that CONTRADICTS the approved amount.
 *
 * That row must not be `executed`: `executed` asserts the operation happened as
 * approved, and the whole point of the anomaly is that it did not. It must not
 * be `failed` either - the transaction is on-chain and the funds moved. So it
 * is its own state, it carries the hash an operator reads the receipt from, and
 * it BLOCKS the compaction money-state gate until a human resolves it.
 */
export const WALLET_WRAP_INTENT_STATUSES = [
  ...WALLET_TRANSACTION_INTENT_STATUSES,
  "review_required",
] as const;
export type WalletWrapIntentStatus = (typeof WALLET_WRAP_INTENT_STATUSES)[number];
export type WalletWrapFailureStage = WalletTransactionFailureStage;
export type WalletWrapFeeBounds = WalletTransactionFeeBounds;
export { WalletTransactionFeeBoundsSchema as WalletWrapFeeBoundsSchema };

/**
 * The digest's resource table. It names the TABLE, so an approval bound to a
 * wrap proposal can never be replayed against a row in another one.
 */
export const WALLET_WRAP_INTENTS_RESOURCE = "wallet_wrap_intents" as const;

/**
 * Bumped whenever a sign-relevant field enters or leaves the preimage. Confirm
 * refuses an unknown version rather than comparing across schemes, so an
 * in-flight proposal from an older build expires cleanly instead of being
 * misread.
 */
export const WRAP_PROPOSAL_DIGEST_VERSION = "v1" as const;
export type WrapProposalDigestVersion = typeof WRAP_PROPOSAL_DIGEST_VERSION;

/** A POSITIVE integer in base units. A wrap of zero is not a transaction. */
const PositiveBaseUnitAmount = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/, "must be a positive decimal integer string");

const ZeroOrPositiveBaseUnitAmount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "must be a non-negative decimal integer string");

const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte 0x address");
const HexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex");

export const WRAP_DIRECTIONS = ["wrap", "unwrap"] as const;
export const WrapDirectionSchema = z.enum(WRAP_DIRECTIONS);

/**
 * The derived `{ to, data, valueWei }` triple, as stored. Confirm re-derives it
 * and compares all three fields; this column exists so a crash-recovery reader
 * can see what was proposed without re-running the deriver.
 */
export const WrapTransactionPayloadSchema = z
  .object({
    to: EvmAddress,
    data: HexData,
    valueWei: ZeroOrPositiveBaseUnitAmount,
  })
  .strict();
export type WrapTransactionPayload = z.infer<typeof WrapTransactionPayloadSchema>;

/**
 * The approval card, as rendered at prepare and re-rendered at confirm. Stored
 * so a hand-edited `preview_json` is detectable, never trusted as input to the
 * digest: the digest RENDERS the card itself from the bound fields.
 */
export const WrapPreviewSchema = z
  .object({
    label: z.string().min(1),
    // Strings only, matching the transaction lane: an amount that reached the
    // card as a JSON number would already have lost precision before anyone
    // read it.
    criticalArgs: z.record(z.string(), z.string()),
  })
  .strict();
export type WrapPreview = z.infer<typeof WrapPreviewSchema>;

/** The wrapped-native contract identity, frozen into the intent at prepare. */
export const WrapContractIdentitySchema = z
  .object({
    address: EvmAddress,
    symbol: z.string().min(1),
    decimals: z.number().int().min(0).max(36),
  })
  .strict();
export type WrapContractIdentity = z.infer<typeof WrapContractIdentitySchema>;

export const WrapAmountSchema = PositiveBaseUnitAmount;
