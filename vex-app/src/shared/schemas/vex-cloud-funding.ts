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

/**
 * The backend's withdrawal states (plan 4.3). `cancelled` is final: the user
 * cancelled it during the cooling period and the VEX went back to the
 * balance. A `debited` withdrawal whose `releaseAt` is still ahead is COOLING
 * (the rolling safety delay before the backend signs it).
 */
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
  "cancelled",
] as const;
export const vexCloudWithdrawalStatusSchema = z.enum(VEX_CLOUD_WITHDRAWAL_STATUSES);
export type VexCloudWithdrawalStatus = z.infer<typeof vexCloudWithdrawalStatusSchema>;

/** The words the app shows (plan 15.2, plus the cooling period). */
export type VexCloudWithdrawalWord = "Cooling" | "Pending" | "Confirming" | "Completed" | "Returned" | "Cancelled";

/** The word a status reads as WITHOUT the clock: a cooling `debited` row reads Pending here; see {@link withdrawalWord}. */
export function withdrawalStatusWord(status: VexCloudWithdrawalStatus): Exclude<VexCloudWithdrawalWord, "Cooling"> {
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
    case "cancelled":
      return "Cancelled";
  }
}

/** Words after which a withdrawal never changes again. */
export function isFinalWithdrawalWord(word: VexCloudWithdrawalWord): boolean {
  return word === "Completed" || word === "Returned" || word === "Cancelled";
}

/**
 * COOLING: `debited` with a release time still ahead (the backend's own
 * definition). Whether it can be cancelled is the backend's separate
 * `cancellable`, never inferred from the clock.
 */
export function isWithdrawalCooling(
  withdrawal: { readonly status: VexCloudWithdrawalStatus; readonly releaseAt: string | null },
  nowMs: number,
): boolean {
  if (withdrawal.status !== "debited" || withdrawal.releaseAt === null) return false;
  const releaseMs = Date.parse(withdrawal.releaseAt);
  return Number.isFinite(releaseMs) && releaseMs > nowMs;
}

export function withdrawalWord(
  withdrawal: { readonly status: VexCloudWithdrawalStatus; readonly releaseAt: string | null },
  nowMs: number,
): VexCloudWithdrawalWord {
  return isWithdrawalCooling(withdrawal, nowMs) ? "Cooling" : withdrawalStatusWord(withdrawal.status);
}

/**
 * The longest cooling period Vex Inference can be configured with, in
 * seconds (7 days, the backend's own configuration bound). The effective
 * value is the backend's `limits.withdraw_cooling_seconds`; this app never
 * assumes one.
 */
export const VEX_CLOUD_WITHDRAW_COOLING_MAX_SECONDS = 604_800;

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
    /** When the cooling period ends; `null` when the backend reports none (a withdrawal from before cooling). */
    releaseAt: isoTimestampSchema.nullable(),
    /** The backend says a cancel can still stop it. Absent from the backend reads `false`. */
    cancellable: z.boolean(),
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
    /**
     * The cooling period the backend reported when this was prepared, in
     * seconds; `null` when the backend did not report one (an older
     * deployment). The card states no number then. After the submit the
     * backend's `releaseAt` is the truth.
     */
    coolingSeconds: z.number().int().nonnegative().max(VEX_CLOUD_WITHDRAW_COOLING_MAX_SECONDS).nullable(),
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

/**
 * What a submit (or its "Check status" replay) learned.
 *
 * `accepted`: Vex Cloud answered with the withdrawal. `unknown`: the request
 * was SENT and the answer did not prove a refusal (a body this build cannot
 * read, a timeout or network error after the send, a 5xx): the withdrawal
 * may exist. Main keeps the proposal and its idempotency key, and submitting
 * the same proposal again replays the SAME key, which can only return the
 * existing withdrawal. `not_created`: only from a replay, when Vex Cloud
 * looked the key up, found no withdrawal for it and then refused
 * (`replayVerdict` in `main/vex-cloud/funding/backend-call.ts`): the request
 * is resolved and nothing was created; `detail` is the refusal's sentence. A
 * definitive refusal of a FIRST send is an error result, never this.
 */
export const vexCloudSubmitWithdrawalResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), withdrawal: vexCloudWithdrawalSchema }).strict(),
  z
    .object({
      outcome: z.literal("not_created"),
      proposalId: proposalIdSchema,
      detail: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unknown"),
      proposalId: proposalIdSchema,
      amountWei: rawIntegerSchema,
      destination: evmAddressSchema,
    })
    .strict(),
]);
export type VexCloudSubmitWithdrawalResult = z.infer<typeof vexCloudSubmitWithdrawalResultSchema>;

export const vexCloudWithdrawalStatusInputSchema = z
  .object({ withdrawalId: vexCloudWithdrawalIdSchema })
  .strict();
export type VexCloudWithdrawalStatusInput = z.infer<typeof vexCloudWithdrawalStatusInputSchema>;

export const vexCloudWithdrawalStatusResultSchema = z
  .object({ withdrawal: vexCloudWithdrawalSchema })
  .strict();
export type VexCloudWithdrawalStatusResult = z.infer<typeof vexCloudWithdrawalStatusResultSchema>;

// ── cancelWithdrawal ─────────────────────────────────────────────────────

/** Cancel a cooling withdrawal. The id is the only field: main mints and keeps the idempotency key. */
export const vexCloudCancelWithdrawalInputSchema = z.object({ withdrawalId: vexCloudWithdrawalIdSchema }).strict();
export type VexCloudCancelWithdrawalInput = z.infer<typeof vexCloudCancelWithdrawalInputSchema>;

/**
 * What a cancel (or its "Check status" replay) learned about the withdrawal.
 *
 * `cancelled`: it is cancelled and the VEX is back in the balance.
 * `not_cancelled`: Vex Cloud answered about this withdrawal and it was NOT
 * cancelled: `in_flight` (already being sent), `final` (already finished),
 * `not_found` (no such withdrawal on this account). `unknown`: the cancel was
 * SENT and the answer proves neither; main keeps the cancel's idempotency key
 * and the next cancel of the same withdrawal replays it.
 */
export const vexCloudCancelWithdrawalResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cancelled"), withdrawal: vexCloudWithdrawalSchema }).strict(),
  z
    .object({
      outcome: z.literal("not_cancelled"),
      reason: z.enum(["in_flight", "final", "not_found"]),
      withdrawal: vexCloudWithdrawalSchema.nullable(),
      detail: z.string().min(1).max(1_000),
    })
    .strict(),
  z.object({ outcome: z.literal("unknown"), withdrawalId: vexCloudWithdrawalIdSchema }).strict(),
]);
export type VexCloudCancelWithdrawalResult = z.infer<typeof vexCloudCancelWithdrawalResultSchema>;

// ── withdrawals this app did not start ──────────────────────────────────

export const vexCloudWithdrawalNoticesInputSchema = z.object({}).strict();

/** A cooling withdrawal on the account whose id this app did not create, and the user has not dismissed. */
export const vexCloudWithdrawalNoticeSchema = z
  .object({
    withdrawalId: vexCloudWithdrawalIdSchema,
    amountWei: rawIntegerSchema,
    destination: evmAddressSchema,
    releaseAt: isoTimestampSchema,
    cancellable: z.boolean(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudWithdrawalNotice = z.infer<typeof vexCloudWithdrawalNoticeSchema>;

/**
 * `complete: false` when the scan stopped at its page bound with older
 * withdrawals left unread (they are older than any cooling period the
 * backend uses by default, but the reader is told it was not everything).
 */
export const vexCloudWithdrawalNoticesResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("signed_out") }).strict(),
  /** The vault is set up but locked: the session cannot be read, so nothing is claimed about withdrawals. Not an error. */
  z.object({ state: z.literal("locked") }).strict(),
  z
    .object({
      state: z.literal("signed_in"),
      notices: z.array(vexCloudWithdrawalNoticeSchema).max(500).readonly(),
      complete: z.boolean(),
      checkedAt: isoTimestampSchema,
    })
    .strict(),
]);
export type VexCloudWithdrawalNoticesResult = z.infer<typeof vexCloudWithdrawalNoticesResultSchema>;

/** "It was me": the user started it elsewhere. Recorded so the notice does not return for this id. */
export const vexCloudDismissWithdrawalNoticeInputSchema = z.object({ withdrawalId: vexCloudWithdrawalIdSchema }).strict();
export type VexCloudDismissWithdrawalNoticeInput = z.infer<typeof vexCloudDismissWithdrawalNoticeInputSchema>;
export const vexCloudDismissWithdrawalNoticeResultSchema = z.object({ dismissed: z.literal(true) }).strict();
export type VexCloudDismissWithdrawalNoticeResult = z.infer<typeof vexCloudDismissWithdrawalNoticeResultSchema>;

// ── claimCashback ────────────────────────────────────────────────────────

/** Phase 2 claims to the balance only; the wallet destination is phase 3 and has no field here. */
export const vexCloudClaimCashbackInputSchema = z.object({}).strict();

/**
 * `claimed`: what moved to the balance (`0` when nothing was claimable).
 * `unknown`: the claim was sent and the answer did not prove a refusal; main
 * keeps its key, and the next claim repeats it ("Check status").
 */
export const vexCloudClaimCashbackResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("claimed"), claimedWei: rawIntegerSchema }).strict(),
  z.object({ outcome: z.literal("unknown") }).strict(),
]);
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
