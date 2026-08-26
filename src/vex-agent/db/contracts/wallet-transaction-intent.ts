/**
 * The DURABLE vocabulary of `wallet_transaction_intents` (migration 087).
 *
 * One owner for the four JSONB columns that cross the process/persistence
 * boundary, so the repo, the prepare handlers, the confirm handlers and the
 * approval-binding rebuild all read the SAME shapes through the SAME strict
 * parsers instead of each casting a `Record<string, unknown>` its own way.
 *
 * Everything numeric that touches money is a DECIMAL STRING of an integer in
 * base units (wei, lamports, micro-lamports, gas units). Rule 90: no floating
 * point anywhere near an amount, and a raw amount travels with the unit named
 * in its key.
 *
 * These schemas are the boundary in the rule-04 sense: a row read back from
 * PostgreSQL is external input. `parseDurableIntentRow` in the repo is the ONE
 * place that turns bytes into these types; nothing downstream re-validates and
 * nothing downstream casts.
 */

import { z } from "zod";

// ── Primitives ────────────────────────────────────────────────────────

/** A non-negative integer in base units, as a decimal string. Never a number. */
const BaseUnitAmount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "must be a non-negative decimal integer string");

const HexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex");
const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte 0x address");
const Base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 public key");
const Base64Bytes = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64");

export const WALLET_TRANSACTION_FAMILIES = ["eip155", "solana"] as const;
export type WalletTransactionFamily = (typeof WALLET_TRANSACTION_FAMILIES)[number];

export const WALLET_TRANSACTION_INTENT_STATUSES = [
  "pending",
  "consuming",
  "executed",
  "failed",
  "broadcast_unconfirmed",
  "superseded_unproven",
  "audit_failed",
  "cancelled",
  "expired",
] as const;
export type WalletTransactionIntentStatus =
  (typeof WALLET_TRANSACTION_INTENT_STATUSES)[number];

/**
 * Why a `failed` row is failed. It exists so the evidence CHECK in migration
 * 087 can be a RULE rather than "tx_hash MAY be set": a chain revert must carry
 * the hash, a pre-broadcast failure and a crash before broadcast must not.
 */
export const WALLET_TRANSACTION_FAILURE_STAGES = [
  "pre_broadcast",
  "chain_reverted",
  "crashed_before_broadcast",
] as const;
export type WalletTransactionFailureStage =
  (typeof WALLET_TRANSACTION_FAILURE_STAGES)[number];

// ── payload_json ──────────────────────────────────────────────────────

export const EvmTransactionPayloadSchema = z
  .object({
    to: EvmAddress,
    /** `0x` means a plain native transfer, and ONLY when `eth_getCode(to)` is `0x`. */
    data: HexData,
    /** RAW wei. Never a human decimal, never a number. */
    valueWei: BaseUnitAmount,
  })
  .strict();
export type EvmTransactionPayload = z.infer<typeof EvmTransactionPayloadSchema>;

export const SolanaTransactionPayloadSchema = z
  .object({
    /**
     * The CANONICAL unsigned message bytes produced by the prepare-time
     * canonicalization seam: fee payer verified, fresh blockhash already
     * installed. Confirm asserts these bytes are unchanged before signing.
     */
    messageBase64: Base64Bytes,
    feePayer: Base58Key,
  })
  .strict();
export type SolanaTransactionPayload = z.infer<typeof SolanaTransactionPayloadSchema>;

// ── fee_bounds_json ───────────────────────────────────────────────────

/**
 * MANDATORY effective bounds. Every cap is a REQUIRED CALLER INPUT: no
 * derivation invents money policy, so there is no "unbounded" variant to model
 * and confirm always has something concrete to refuse against.
 */
export const Eip1559FeeBoundsSchema = z
  .object({
    mode: z.literal("eip1559"),
    /** Gas UNITS. */
    gasLimit: BaseUnitAmount,
    maxFeePerGasWei: BaseUnitAmount,
    maxPriorityFeePerGasWei: BaseUnitAmount,
    /** gasLimit * maxFeePerGas, in RAW wei. The number the user authorizes. */
    maxTotalFeeWei: BaseUnitAmount,
  })
  .strict();

export const LegacyEvmFeeBoundsSchema = z
  .object({
    mode: z.literal("legacy"),
    gasLimit: BaseUnitAmount,
    gasPriceWei: BaseUnitAmount,
    maxTotalFeeWei: BaseUnitAmount,
  })
  .strict();

export const SolanaFeeBoundsSchema = z
  .object({
    mode: z.literal("solana"),
    /** Requested COMPUTE UNIT limit. Priority cost is charged on the REQUESTED limit, not on usage. */
    computeUnitLimit: BaseUnitAmount,
    computeUnitPriceMicroLamports: BaseUnitAmount,
    /** 5000 lamports per signature at the time of prepare, echoed rather than assumed downstream. */
    baseFeeLamports: BaseUnitAmount,
    /** ceil(computeUnitLimit * computeUnitPriceMicroLamports / 1_000_000). */
    maxPriorityFeeLamports: BaseUnitAmount,
    maxTotalFeeLamports: BaseUnitAmount,
  })
  .strict();

export const WalletTransactionFeeBoundsSchema = z.discriminatedUnion("mode", [
  Eip1559FeeBoundsSchema,
  LegacyEvmFeeBoundsSchema,
  SolanaFeeBoundsSchema,
]);
export type WalletTransactionFeeBounds = z.infer<typeof WalletTransactionFeeBoundsSchema>;
export type Eip1559FeeBounds = z.infer<typeof Eip1559FeeBoundsSchema>;
export type LegacyEvmFeeBounds = z.infer<typeof LegacyEvmFeeBoundsSchema>;
export type SolanaFeeBounds = z.infer<typeof SolanaFeeBoundsSchema>;

// ── decoded_json ──────────────────────────────────────────────────────

/**
 * The activity ROLE the decoded effect implies (spec item 6). Stored at prepare
 * so the activity writer pass 2 adds does not re-derive it from the payload.
 */
export const WALLET_TRANSACTION_ROLES = [
  "approve",
  "contract_call",
  "native_transfer",
  "spl_instruction_set",
] as const;
export type WalletTransactionRole = (typeof WALLET_TRANSACTION_ROLES)[number];

/**
 * Allow-listed scalar args bound into the approval card. Strings only: an
 * amount that reached the card as a JSON number would already have lost
 * precision before anyone read it.
 */
const CriticalArgs = z.record(z.string(), z.string());

export const DecodedEvmCallSchema = z
  .object({
    family: z.literal("eip155"),
    role: z.enum(WALLET_TRANSACTION_ROLES),
    /** `native`, `erc20` or `permit2`: the CLOSED v1 decode set. */
    standard: z.enum(["native", "erc20", "permit2"]),
    /** ABI function name, or `nativeTransfer` for the `data = 0x` path. */
    functionName: z.string().min(1),
    /** The contract being called, or null for a plain native transfer. */
    contract: EvmAddress.nullable(),
    criticalArgs: CriticalArgs,
    /** An approval of max uint256. Displayed as a warning, never silently allowed through. */
    unlimitedApproval: z.boolean(),
    warnings: z.array(z.string()).readonly(),
  })
  .strict();
export type DecodedEvmCall = z.infer<typeof DecodedEvmCallSchema>;

export const DecodedSolanaInstructionSchema = z
  .object({
    program: z.enum(["system", "spl_token", "compute_budget", "memo"]),
    /** The exact allowed VARIANT, e.g. `transferChecked`. Program identity alone is never enough. */
    variant: z.string().min(1),
    programId: Base58Key,
    criticalArgs: CriticalArgs,
  })
  .strict();

export const DecodedSolanaTransactionSchema = z
  .object({
    family: z.literal("solana"),
    role: z.enum(WALLET_TRANSACTION_ROLES),
    instructions: z.array(DecodedSolanaInstructionSchema).min(1).readonly(),
    /** Every static key plus every key resolved from an address lookup table. */
    accountKeys: z.array(Base58Key).readonly(),
    /** True when the message carried ALTs and every one of them resolved. */
    addressTableLookupsResolved: z.boolean(),
    warnings: z.array(z.string()).readonly(),
  })
  .strict();
export type DecodedSolanaTransaction = z.infer<typeof DecodedSolanaTransactionSchema>;

export const DecodedWalletTransactionSchema = z.discriminatedUnion("family", [
  DecodedEvmCallSchema,
  DecodedSolanaTransactionSchema,
]);
export type DecodedWalletTransaction = z.infer<typeof DecodedWalletTransactionSchema>;

// ── preview_json ──────────────────────────────────────────────────────

/**
 * Deliberately the SAME shape as `WalletIntentPreview`: the approval card
 * renderer is one owner, and a second preview vocabulary would mean a second
 * renderer branch on the money path.
 */
export const WalletTransactionPreviewSchema = z
  .object({
    label: z.string().min(1),
    criticalArgs: CriticalArgs,
  })
  .strict();
export type WalletTransactionPreview = z.infer<typeof WalletTransactionPreviewSchema>;

// ── proposal digest version ───────────────────────────────────────────

/**
 * The ONE digest scheme this build writes and accepts. Confirm refuses an
 * unknown version by name rather than comparing a `v1` digest against a `v2`
 * serialization and calling the mismatch a drift.
 *
 * v2 folded the CANONICAL PREVIEW - the sentence and argument panel the human
 * reads - into the preimage, so a hand-edited `preview_json` no longer passes
 * every digest check untouched.
 *
 * v3 (2026-08-25) added the VEX FEE LINES to that canonical preview: the 25 bps
 * platform fee an EVM proposal's own native value attracts, or the explicit
 * reason none is taken. The fee is DERIVED from fields v2 already bound, so v3
 * binds no new input - what changed is the sentence the human authorizes, which
 * is exactly what the preview is in the preimage for.
 *
 * A v1 or v2 digest was taken over a serialization that produces a different
 * preview and therefore cannot be re-verified here; both are refused BY NAME,
 * with no migration, because an in-flight intent expires in minutes and
 * preparing again is the honest and cheap answer.
 */
export const PROPOSAL_DIGEST_VERSION = "v3" as const;
export type ProposalDigestVersion = typeof PROPOSAL_DIGEST_VERSION;
