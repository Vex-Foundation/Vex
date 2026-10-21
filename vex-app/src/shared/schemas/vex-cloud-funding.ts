/**
 * `vex:vexCloud:*` funding (phase 2, plan section 15): deposit, withdraw,
 * cashback and history.
 *
 * THE FORM IS THE APPROVAL, and these shapes are what keeps it honest. A
 * prepare call returns a PROPOSAL minted in main: every field the user
 * consents to (actor, chain, token, exact amount, source, destination, the
 * fee bound, the expiry) with an opaque id. A submit names that id AND
 * echoes the figures the user saw; main refuses by name when anything
 * differs, so between the card on screen and the signature there is no field
 * the renderer can change.
 *
 * NO DESTINATION FIELD THE RENDERER CAN WRITE FREELY. A deposit's
 * destination is the address pinned in the build (main resolves it, the
 * proposal carries it back for display). A withdrawal's destination is
 * chosen from the account's linked wallets that are also in this app's
 * inventory; main re-checks that membership on prepare and again on submit.
 *
 * MONEY TRAVELS WHOLE: raw integers in wei (VEX and ETH, 18 decimals) or in
 * micro-USD, beside their unit. The one text amount (`amountText`) is what
 * the user typed, kept as text until main parses it at this boundary.
 */

import { z } from "zod";
import { VEX_CLOUD_CHAIN_ID, VEX_DECIMALS, VEX_SYMBOL } from "../vex-cloud-money.js";
import { evmAddressSchema } from "./wallets.js";

const isoTimestampSchema = z.string().datetime({ offset: true });
/** Raw integer amount: digits only, no sign, point or exponent. */
const rawIntegerSchema = z.string().regex(/^[0-9]{1,78}$/, "must be a raw non-negative integer");
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
/** A main-minted proposal handle. Opaque: it carries no information about the proposal. */
const proposalIdSchema = z.string().uuid();
/** What the user typed, as text. Parsed in main, never through a float. */
const amountTextSchema = z.string().min(1).max(64);
/** The backend's opaque page cursor, round-tripped unparsed. */
const cursorSchema = z.string().min(1).max(512);
/** A backend status or reason token. */
const tokenWordSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const VEX_CLOUD_PAGE_MAX = 100;
export const VEX_CLOUD_PAGE_DEFAULT = 25;

const pageInputSchema = z
  .object({
    /** `null` for the first page, else the `nextCursor` of the previous one. */
    cursor: cursorSchema.nullable(),
    limit: z.number().int().min(1).max(VEX_CLOUD_PAGE_MAX).optional(),
  })
  .strict();
export type VexCloudPageInput = z.infer<typeof pageInputSchema>;

// ── depositWallets ───────────────────────────────────────────────────────

export const vexCloudDepositWalletsInputSchema = z.object({}).strict();

export const vexCloudDepositWalletSchema = z
  .object({
    address: evmAddressSchema,
    label: z.string().min(1).max(120),
    /** On-chain VEX balance in wei at `readAt`, or `null` when the read failed ("Not available"). */
    vexWei: rawIntegerSchema.nullable(),
  })
  .strict();
export type VexCloudDepositWallet = z.infer<typeof vexCloudDepositWalletSchema>;

export const vexCloudDepositWalletsResultSchema = z
  .object({
    chainId: z.literal(VEX_CLOUD_CHAIN_ID),
    wallets: z.array(vexCloudDepositWalletSchema).max(3).readonly(),
    readAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudDepositWalletsResult = z.infer<typeof vexCloudDepositWalletsResultSchema>;

// ── prepareDeposit / submitDeposit ───────────────────────────────────────

export const vexCloudPrepareDepositInputSchema = z
  .object({
    /** One of this app's in-app EVM wallets; main re-checks the inventory. */
    walletAddress: evmAddressSchema,
    amountText: amountTextSchema,
  })
  .strict();
export type VexCloudPrepareDepositInput = z.infer<typeof vexCloudPrepareDepositInputSchema>;

/** The approved ceiling on what the deposit transaction may cost in gas, in ETH wei. */
export const vexCloudFeeBoundSchema = z
  .object({
    gasLimit: rawIntegerSchema,
    maxFeePerGasWei: rawIntegerSchema,
    maxPriorityFeePerGasWei: rawIntegerSchema,
    /** gasLimit x maxFeePerGas: the most the network fee can be. */
    maxNetworkFeeWei: rawIntegerSchema,
    nativeSymbol: z.literal("ETH"),
    nativeDecimals: z.literal(18),
  })
  .strict();
export type VexCloudFeeBound = z.infer<typeof vexCloudFeeBoundSchema>;

export const vexCloudDepositProposalSchema = z
  .object({
    proposalId: proposalIdSchema,
    /** Who acts: always the user from this form; no agent path reaches it. */
    actor: z.literal("user"),
    chainId: z.literal(VEX_CLOUD_CHAIN_ID),
    token: z
      .object({
        address: evmAddressSchema,
        symbol: z.literal(VEX_SYMBOL),
        decimals: z.literal(VEX_DECIMALS),
      })
      .strict(),
    amountWei: rawIntegerSchema,
    /** The source wallet (an in-app EVM wallet). */
    from: evmAddressSchema,
    /** The deposit address pinned in this build, equal to the backend's at prepare. */
    to: evmAddressSchema,
    feeBound: vexCloudFeeBoundSchema,
    /** The amount at the backend's rate, rounded down. */
    usdMicroEstimate: rawIntegerSchema,
    /** The backend minimum ($5) in wei at the same rate, rounded up. */
    minimumWei: rawIntegerSchema,
    minimumMicroUsd: rawIntegerSchema,
    /** Deposits are spendable as soon as seen up to this much (D15); the rest at finality. */
    provisionalCapMicroUsd: rawIntegerSchema,
    /** The wallet's VEX and ETH at prepare. */
    walletVexWei: rawIntegerSchema,
    walletNativeWei: rawIntegerSchema,
    preparedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudDepositProposal = z.infer<typeof vexCloudDepositProposalSchema>;

export const vexCloudSubmitDepositInputSchema = z
  .object({
    proposalId: proposalIdSchema,
    /** Echo of the card the user approved; any difference is refused by name. */
    walletAddress: evmAddressSchema,
    amountWei: rawIntegerSchema,
  })
  .strict();
export type VexCloudSubmitDepositInput = z.infer<typeof vexCloudSubmitDepositInputSchema>;

export const vexCloudSubmitDepositResultSchema = z
  .object({
    /**
     * `confirmed`: included and successful. `reverted`: included and failed
     * (the VEX did not move; the network fee was spent). `pending`: sent, but
     * the outcome is not known yet; it is never re-sent, and Vex Cloud credits
     * it when its watcher sees the transfer.
     */
    status: z.enum(["confirmed", "reverted", "pending"]),
    txHash: txHashSchema,
    /** The receipt carried exactly this Transfer to the deposit address. */
    transferProven: z.boolean(),
    /** Vex Cloud was told to look at this hash now (a hint; its watcher verifies). */
    notified: z.boolean(),
  })
  .strict();
export type VexCloudSubmitDepositResult = z.infer<typeof vexCloudSubmitDepositResultSchema>;

// ── withdrawals ──────────────────────────────────────────────────────────

/** The backend's withdrawal states (plan 4.3). */
export const VEX_CLOUD_WITHDRAWAL_STATUSES = [
  "requested",
  "debited",
  "signed",
  "broadcast",
  "included_success",
  "included_reverted",
  "completed",
  "refunded",
  "failed",
  "unknown",
  "dropped",
] as const;
export const vexCloudWithdrawalStatusSchema = z.enum(VEX_CLOUD_WITHDRAWAL_STATUSES);
export type VexCloudWithdrawalStatus = z.infer<typeof vexCloudWithdrawalStatusSchema>;

/** The four words the app shows (plan 15.2). */
export type VexCloudWithdrawalWord = "Pending" | "Confirming" | "Completed" | "Returned";

export function withdrawalStatusWord(status: VexCloudWithdrawalStatus): VexCloudWithdrawalWord {
  switch (status) {
    case "requested":
    case "debited":
    case "signed":
    case "broadcast":
    case "unknown":
      return "Pending";
    case "included_success":
    case "included_reverted":
      return "Confirming";
    case "completed":
      return "Completed";
    case "refunded":
    case "failed":
    case "dropped":
      return "Returned";
  }
}

export const vexCloudWithdrawalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const vexCloudWithdrawalSchema = z
  .object({
    id: vexCloudWithdrawalIdSchema,
    status: vexCloudWithdrawalStatusSchema,
    amountWei: rawIntegerSchema,
    destination: evmAddressSchema,
    txHash: txHashSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudWithdrawal = z.infer<typeof vexCloudWithdrawalSchema>;

export const vexCloudPrepareWithdrawalInputSchema = z
  .object({
    /** A wallet that is linked to the account AND in this app's inventory. */
    destination: evmAddressSchema,
    amountText: amountTextSchema,
  })
  .strict();
export type VexCloudPrepareWithdrawalInput = z.infer<typeof vexCloudPrepareWithdrawalInputSchema>;

export const vexCloudWithdrawalProposalSchema = z
  .object({
    proposalId: proposalIdSchema,
    actor: z.literal("user"),
    chainId: z.literal(VEX_CLOUD_CHAIN_ID),
    amountWei: rawIntegerSchema,
    destination: evmAddressSchema,
    usdMicroEstimate: rawIntegerSchema,
    minimumWei: rawIntegerSchema,
    minimumMicroUsd: rawIntegerSchema,
    /** What may leave now, or `null` when the backend does not report it. */
    withdrawableWei: rawIntegerSchema.nullable(),
    /** The daily limit left, or `null` when the backend has no figure (rate unavailable). */
    dailyRemainingWei: rawIntegerSchema.nullable(),
    dailyLimitMicroUsd: rawIntegerSchema.nullable(),
    preparedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudWithdrawalProposal = z.infer<typeof vexCloudWithdrawalProposalSchema>;

export const vexCloudSubmitWithdrawalInputSchema = z
  .object({
    proposalId: proposalIdSchema,
    destination: evmAddressSchema,
    amountWei: rawIntegerSchema,
  })
  .strict();
export type VexCloudSubmitWithdrawalInput = z.infer<typeof vexCloudSubmitWithdrawalInputSchema>;

export const vexCloudSubmitWithdrawalResultSchema = z
  .object({ withdrawal: vexCloudWithdrawalSchema })
  .strict();
export type VexCloudSubmitWithdrawalResult = z.infer<typeof vexCloudSubmitWithdrawalResultSchema>;

export const vexCloudWithdrawalStatusInputSchema = z
  .object({ withdrawalId: vexCloudWithdrawalIdSchema })
  .strict();
export type VexCloudWithdrawalStatusInput = z.infer<typeof vexCloudWithdrawalStatusInputSchema>;

export const vexCloudWithdrawalStatusResultSchema = vexCloudSubmitWithdrawalResultSchema;
export type VexCloudWithdrawalStatusResult = VexCloudSubmitWithdrawalResult;

// ── claimCashback ────────────────────────────────────────────────────────

/** Phase 2 claims to the balance only; the wallet destination is phase 3 and has no field here. */
export const vexCloudClaimCashbackInputSchema = z.object({}).strict();

export const vexCloudClaimCashbackResultSchema = z
  .object({
    /** What moved to the balance; `0` when nothing was claimable. */
    claimedWei: rawIntegerSchema,
  })
  .strict();
export type VexCloudClaimCashbackResult = z.infer<typeof vexCloudClaimCashbackResultSchema>;

// ── history: activity, usage, deposits ───────────────────────────────────

export const vexCloudActivityInputSchema = pageInputSchema;
export const vexCloudUsageInputSchema = pageInputSchema;
export const vexCloudDepositsInputSchema = pageInputSchema;

export const vexCloudActivityItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(["deposit", "withdrawal", "cashback_claim", "admin_credit"]),
    amountWei: rawIntegerSchema,
    status: tokenWordSchema,
    txHash: txHashSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudActivityItem = z.infer<typeof vexCloudActivityItemSchema>;

export const vexCloudUsageItemSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    model: z.string().min(1).max(200),
    effort: z.string().max(32).nullable(),
    status: tokenWordSchema,
    upstreamCostMicroUsd: rawIntegerSchema.nullable(),
    chargedWei: rawIntegerSchema.nullable(),
    clampReason: tokenWordSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudUsageItem = z.infer<typeof vexCloudUsageItemSchema>;

export const vexCloudDepositItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    txHash: txHashSchema,
    logIndex: z.number().int().nonnegative(),
    from: evmAddressSchema,
    amountWei: rawIntegerSchema,
    status: z.enum(["pending", "provisional", "credited", "reverted"]),
    spendableNowWei: rawIntegerSchema,
    observedAt: isoTimestampSchema,
    finalizedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type VexCloudDepositItem = z.infer<typeof vexCloudDepositItemSchema>;

function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item).max(VEX_CLOUD_PAGE_MAX).readonly(),
      /** `null`: this is the last page. */
      nextCursor: cursorSchema.nullable(),
    })
    .strict();
}

export const vexCloudActivityResultSchema = pageOf(vexCloudActivityItemSchema);
export type VexCloudActivityResult = z.infer<typeof vexCloudActivityResultSchema>;
export const vexCloudUsageResultSchema = pageOf(vexCloudUsageItemSchema);
export type VexCloudUsageResult = z.infer<typeof vexCloudUsageResultSchema>;
export const vexCloudDepositsResultSchema = pageOf(vexCloudDepositItemSchema);
export type VexCloudDepositsResult = z.infer<typeof vexCloudDepositsResultSchema>;
