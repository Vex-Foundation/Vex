/**
 * The Vex platform fee on the GENERIC EVM signing lane - the pure half.
 *
 * ## What is charged, and on what
 *
 * 25 bps of the transaction's OWN native value (`payload.valueWei`), taken as a
 * SEPARATE native transfer to the Vex treasury that runs only AFTER the user's
 * transaction has confirmed on-chain. This is the same mechanism, and the same
 * ordering guarantee, that every other Vex venue on
 * `@tools/vex-fee/native-leg/` uses: an action that does not happen is never
 * charged, and a fee that fails leaves the action untouched.
 *
 * CONSEQUENCE, stated rather than discovered: the base is native value, so an
 * ERC-20 transfer or an `approve` through this lane (`valueWei` of 0) pays NO
 * fee at all. Only native-value-bearing transactions pay one.
 *
 * SOLANA CHARGES NOTHING, and that gap is deliberate. No Solana fee-leg runtime
 * exists on this lane, and appending an instruction to a canonical message that
 * has already been approved is forbidden by construction - the bytes the user
 * read are the bytes that get signed. Migration 088 binds `tx_vex_fee` to
 * `chain_family = 'eip155'` so the gap is enforced by the database rather than
 * by this comment.
 *
 * ## DERIVED, NEVER STORED
 *
 * Everything here is a pure function of fields the proposal digest ALREADY
 * binds - the payload's `valueWei` and the approved `feeBounds` - plus the
 * build constants below. There is no fee column on the intent: the canonical
 * preview renders the fee lines from this function, digest v3 covers that
 * preview, and confirm recomputes both. A fee that drifted between prepare and
 * confirm is therefore a digest mismatch or a whole-card mismatch, not a
 * silently different number.
 *
 * NOTHING HERE IS MODEL INPUT. The rate, the receiver and the gas ceiling are
 * product-owner constants; no tool on this lane exposes a fee-shaped parameter,
 * and `fee-params-never-from-model.test.ts` fails the build if one appears.
 */

import type { Address } from "viem";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import type { StagedFeeBounds } from "@tools/evm-chains/staged-broadcast.js";
import {
  buildNativeFeeDisclosure,
  buildNativeFeeSkippedDisclosure,
  type NativeFeeDisclosure,
} from "@tools/vex-fee/native-leg/index.js";
import { splitAmountForFeeBps } from "@tools/vex-fee/bps-split.js";
import { VEX_TREASURY_EVM } from "../../../../../lib/vex-treasury.js";
import type {
  WalletTransactionFeeBounds,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import {
  planNativeFeeLeg,
  type ActivityWritingFeeVenue,
  type NativeFeeLegPlan,
} from "../../../protocols/shared/native-fee-leg/plan.js";

// ── The product-owner constants ───────────────────────────────────────

/**
 * Whole basis points. 25 = 0.25%, the same rate every other Vex venue charges,
 * so a user does not pay a different percentage for reaching the same chain
 * through a different tool.
 */
export const WALLET_TX_FEE_BPS = 25;

/** The treasury the fee transfer targets. The shared Vex EVM treasury, never a per-lane address. */
export const WALLET_TX_FEE_RECEIVER_EVM: Address = VEX_TREASURY_EVM;

/**
 * Intrinsic gas of the fee transfer: an empty-calldata native value transfer,
 * which is 21000 by the EVM's own rule and cannot be less.
 */
export const VEX_FEE_TRANSFER_ESTIMATED_GAS = 21_000n;

/**
 * The gas limit the fee transfer is actually SIGNED with, and therefore the
 * ceiling that has to be approved for it.
 *
 * DERIVED THROUGH THE PRODUCTION HELPER, never a duplicated literal. The staged
 * primitive applies `gasLimitWithHeadroom` to its own fresh estimate and only
 * THEN checks the result against the approved bounds
 * (`staged-broadcast.ts#runStagedBroadcast`), so a ceiling set at the 21000
 * intrinsic floor would refuse every single fee transfer. The approved cap must
 * be the SIGNED limit. Pinning it to the helper means a change to the headroom
 * policy moves this ceiling with it instead of silently invalidating it.
 */
export const VEX_FEE_TRANSFER_GAS_LIMIT = gasLimitWithHeadroom(VEX_FEE_TRANSFER_ESTIMATED_GAS);

/** The `agent_activity.event_role` the fee leg is recorded under (migration 088). */
export const WALLET_TX_FEE_ACTIVITY_EVENT_ROLE = "tx_vex_fee" as const;

/** The one charge basis this lane has. Named, because the disclosure states it. */
export type WalletTxVexFeeBasis = "tx_native_value";

/** The native sentinel every Vex fee row uses as its token identity. */
const NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000" as Address;

const ORDERING_NOTE =
  `Vex charges ${WALLET_TX_FEE_BPS} bps (0.25%) of the native value this transaction sends, as a `
  + "SEPARATE transfer to the Vex treasury that runs AFTER this transaction confirms. It is IN "
  + "ADDITION to the value this transaction sends and to its own network fee, and it pays its own "
  + "network fee on top. A transaction that does not happen is never charged, and a fee transfer "
  + "that fails leaves this transaction completely unaffected.";

const SKIPPED_NOTE =
  `No Vex fee was taken on this transaction: ${WALLET_TX_FEE_BPS} bps of the native value it sends `
  + "comes to nothing worth collecting at this size, so no fee transfer is made at all.";

/**
 * Unreachable on this lane, and stated rather than omitted because the venue
 * shape requires it: the base here is `payload.valueWei`, a digest-bound field
 * that is always known exactly. There is no decode that could fail to prove it.
 */
const UNPROVEN_BASE_NOTE =
  "No Vex fee was taken on this transaction: the native value it sends could not be established, "
  + "and Vex does not charge a percentage of an amount it cannot prove. The transaction itself is "
  + "unaffected.";

/** What this lane needs to know about the chain to name the native asset honestly. */
export interface WalletTxVexFeeChainFacts {
  /** The chain slug stamped on the fee row - the intent's own `chainAlias`. */
  readonly chainSlug: string;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;
}

/**
 * The venue descriptor, built PER CHAIN because the native asset differs.
 *
 * Only the chain facts vary. The rate, the receiver and the role are the
 * constants above, so no caller can supply a different one.
 */
export function walletTxFeeVenue(
  facts: WalletTxVexFeeChainFacts,
): ActivityWritingFeeVenue<WalletTxVexFeeBasis> {
  return {
    bps: WALLET_TX_FEE_BPS,
    receiver: WALLET_TX_FEE_RECEIVER_EVM,
    activityEventRole: WALLET_TX_FEE_ACTIVITY_EVENT_ROLE,
    // The same `agent_activity.protocol` the parent transaction row carries: a
    // generic signed transaction belongs to no venue.
    protocol: "wallet",
    chainSlug: facts.chainSlug,
    nativeLabel: facts.nativeSymbol,
    nativeDecimals: facts.nativeDecimals,
    logPrefix: "wallet.transaction.fee",
    displayName: "Vex",
    amountLabel: "Transaction native value",
    basisText: { tx_native_value: "the native value this transaction sends" },
    notes: { ordering: ORDERING_NOTE, skipped: SKIPPED_NOTE, unprovenBase: UNPROVEN_BASE_NOTE },
  };
}

// ── The quote (D9) ────────────────────────────────────────────────────

/**
 * Why no fee was taken. A CLOSED set, and each member is a different fact:
 *
 *   `no_native_value`             the transaction sends none, so there is no base;
 *   `floors_to_zero`              25 bps of the base truncates to 0 smallest units;
 *   `at_or_below_collection_cost` the fee exists but does not exceed the most
 *                                 its own collection transfer could cost the
 *                                 user. The name states the INCLUSIVE equality:
 *                                 an exactly-equal fee is skipped.
 */
export type WalletTxVexFeeSkipReason =
  | "no_native_value"
  | "floors_to_zero"
  | "at_or_below_collection_cost";

interface WalletTxVexFeeQuoteFacts {
  /** The base the rate was applied to, in wei. The transaction's own native value. */
  readonly baseWei: bigint;
  /** The CANDIDATE fee: `floor(baseWei * 25 / 10000)`. Zero on the first two skip reasons. */
  readonly feeWei: bigint;
  /**
   * The most the collection transfer itself could cost at the APPROVED per-gas
   * cap: `VEX_FEE_TRANSFER_GAS_LIMIT * cap`. Both the threshold comparator and
   * the approval card's own line read this one number.
   */
  readonly maxNetworkFeeWei: bigint;
}

export type WalletTxVexFeeQuote =
  | (WalletTxVexFeeQuoteFacts & { readonly charged: true })
  | (WalletTxVexFeeQuoteFacts & { readonly charged: false; readonly reason: WalletTxVexFeeSkipReason });

/**
 * The per-gas cap the user approved, or `null` when this row does not carry EVM
 * fee bounds at all.
 *
 * `null` is an INCOHERENT ROW, not a market condition: prepare on this lane
 * always writes EVM bounds for an EVM proposal, and confirm refuses a mismatched
 * pair BY NAME before it reaches anything here. Nothing about a fee can be
 * stated for such a row, so nothing is.
 */
export function approvedPerGasCapWei(bounds: WalletTransactionFeeBounds): bigint | null {
  if (bounds.mode === "eip1559") return BigInt(bounds.maxFeePerGasWei);
  if (bounds.mode === "legacy") return BigInt(bounds.gasPriceWei);
  return null;
}

/**
 * THE fee decision, from digest-bound fields alone.
 *
 * ## The economic threshold, and why it exists here and nowhere else
 *
 * The fee is charged only when it EXCEEDS the most its own collection could
 * cost the user (owner decision 2026-08-25). Vex's other separate-leg venues
 * charge any positive fee, and that is right for them: their action sizes are
 * meaningful by construction. This lane's are arbitrary - it signs whatever a
 * user or an agent hands it - so without a floor a 300-wei fee would trigger a
 * transfer whose own network fee costs the user far more than the fee itself.
 * The reference wallets avoid the problem by never having it: MetaMask and
 * Rabby both EMBED their fee in the same transaction, where dust costs nothing
 * extra, and neither charges anything at all on generic signing.
 *
 * The comparator uses the SIGNED gas cap, not the intrinsic floor, for the same
 * reason `VEX_FEE_TRANSFER_GAS_LIMIT` is the approved ceiling.
 *
 * Every input is bound by the digest, so prepare and confirm agree by
 * determinism rather than by re-reading anything.
 */
export function quoteWalletTxVexFee(valueWei: bigint, perGasCapWei: bigint): WalletTxVexFeeQuote {
  const maxNetworkFeeWei = VEX_FEE_TRANSFER_GAS_LIMIT * perGasCapWei;

  // Guarded BEFORE the split, which refuses a non-positive base by name: no
  // native value is an ordinary proposal shape here, not a programming error.
  if (valueWei <= 0n) {
    return { baseWei: valueWei, feeWei: 0n, maxNetworkFeeWei, charged: false, reason: "no_native_value" };
  }

  const split = splitAmountForFeeBps(valueWei, {
    bps: WALLET_TX_FEE_BPS,
    amountLabel: "Transaction native value",
  });
  const feeWei = split.feeRaw;
  if (feeWei <= 0n) {
    return { baseWei: valueWei, feeWei, maxNetworkFeeWei, charged: false, reason: "floors_to_zero" };
  }
  if (feeWei <= maxNetworkFeeWei) {
    return {
      baseWei: valueWei,
      feeWei,
      maxNetworkFeeWei,
      charged: false,
      reason: "at_or_below_collection_cost",
    };
  }
  return { baseWei: valueWei, feeWei, maxNetworkFeeWei, charged: true };
}

/** The approved caps for the FEE LEG, in the vocabulary the signing primitive enforces (D8). */
export function walletTxVexFeeStagedBounds(
  bounds: WalletTransactionFeeBounds,
): StagedFeeBounds | null {
  if (bounds.mode === "eip1559") {
    return {
      mode: "eip1559",
      // The fee leg's OWN gas ceiling. The action's `gasLimit` is the action's;
      // a native transfer must not be signed under it.
      gasLimit: VEX_FEE_TRANSFER_GAS_LIMIT,
      // The per-gas caps ARE the action's, because they are what the user
      // authorized paying per unit of gas on this chain, right now.
      maxFeePerGasWei: BigInt(bounds.maxFeePerGasWei),
      maxPriorityFeePerGasWei: BigInt(bounds.maxPriorityFeePerGasWei),
    };
  }
  if (bounds.mode === "legacy") {
    return {
      mode: "legacy",
      gasLimit: VEX_FEE_TRANSFER_GAS_LIMIT,
      gasPriceWei: BigInt(bounds.gasPriceWei),
    };
  }
  return null;
}

/** The agent-facing disclosure for a quote, charged or skipped. */
export function walletTxVexFeeDisclosure(
  venue: ActivityWritingFeeVenue<WalletTxVexFeeBasis>,
  quote: WalletTxVexFeeQuote,
): NativeFeeDisclosure<WalletTxVexFeeBasis> {
  if (quote.charged) {
    // The SHARED builder through this lane's venue, so the disclosure cannot
    // drift from every other venue's shape. `netApplies` is false: the fee is
    // its own later transaction and does not reduce what this one sends, so
    // there is no net principal to state. No USD estimate - this lane prices
    // nothing and does not guess.
    return buildNativeFeeDisclosure(venue, {
      basis: "tx_native_value",
      baseWei: quote.baseWei,
      feeWei: quote.feeWei,
      netApplies: false,
    });
  }
  return buildNativeFeeSkippedDisclosure(venue, {
    basis: "tx_native_value",
    baseWei: quote.baseWei,
    reason: walletTxVexFeeSkipSentence(quote),
  });
}

/**
 * The plain-language reason a fee was skipped - the SAME sentence on the
 * approval card and in the tool result, because they describe one decision.
 *
 * The at-or-below arm names BOTH figures. "Below its own collection cost" with
 * no numbers is an assertion a reader cannot check; the two amounts are what
 * make it a statement of fact.
 */
export function walletTxVexFeeSkipSentence(
  quote: Extract<WalletTxVexFeeQuote, { charged: false }>,
): string {
  switch (quote.reason) {
    case "no_native_value":
      return "this transaction sends no native value, so there is nothing to charge 25 bps of";
    case "floors_to_zero":
      return `25 bps of the ${quote.baseWei.toString()} wei this transaction sends floors to zero`;
    case "at_or_below_collection_cost":
      return `the 25 bps fee of ${quote.feeWei.toString()} wei is at or below the `
        + `${quote.maxNetworkFeeWei.toString()} wei its own collection transfer could cost at the `
        + "approved gas price, so Vex takes nothing";
  }
}

// ── The frozen plan (D3) ──────────────────────────────────────────────

/**
 * The fee, planned ONCE, as one object.
 *
 * WHY IT IS FROZEN. The charged arm's `event` is created inside the T2 claim
 * transaction and the same object's `leg` and `bounds` are what get signed after
 * the action confirms. If collection re-planned at signing time it would be a
 * SECOND computation of the same money, and the row that was recorded and the
 * transfer that was signed could disagree with nobody noticing. So there is one
 * plan, and the collection path performs no planning step at all.
 */
export type WalletTransactionVexFeePlan =
  | {
      readonly charged: true;
      readonly quote: Extract<WalletTxVexFeeQuote, { charged: true }>;
      readonly venue: ActivityWritingFeeVenue<WalletTxVexFeeBasis>;
      readonly leg: NativeFeeLegPlan<WalletTxVexFeeBasis>;
      readonly bounds: StagedFeeBounds;
      readonly disclosure: NativeFeeDisclosure<WalletTxVexFeeBasis>;
    }
  | {
      readonly charged: false;
      readonly quote: Extract<WalletTxVexFeeQuote, { charged: false }>;
      readonly venue: ActivityWritingFeeVenue<WalletTxVexFeeBasis>;
      readonly disclosure: NativeFeeDisclosure<WalletTxVexFeeBasis>;
    };

/** The charged arm, named so an execution input can require it. */
export type ChargedWalletTransactionVexFeePlan = Extract<
  WalletTransactionVexFeePlan,
  { charged: true }
>;

/**
 * Plan the fee for a durable EVM intent. PURE: it reads the row and the chain
 * facts and computes; it writes nothing and signs nothing.
 *
 * `null` means this row cannot carry a fee at all - it is not an EVM proposal,
 * or it carries fee bounds an EVM proposal cannot have. Both are shapes confirm
 * refuses BY NAME before signing, so there is nothing to state about a fee.
 */
export function prepareWalletTransactionVexFeePlan(
  intent: WalletTransactionIntent,
  facts: WalletTxVexFeeChainFacts,
): WalletTransactionVexFeePlan | null {
  if (intent.payload.family !== "eip155") return null;
  const perGasCapWei = approvedPerGasCapWei(intent.feeBounds);
  const bounds = walletTxVexFeeStagedBounds(intent.feeBounds);
  if (perGasCapWei === null || bounds === null) return null;

  const venue = walletTxFeeVenue(facts);
  const quote = quoteWalletTxVexFee(BigInt(intent.payload.evm.valueWei), perGasCapWei);
  if (!quote.charged) {
    return { charged: false, quote, venue, disclosure: walletTxVexFeeDisclosure(venue, quote) };
  }

  const leg = planNativeFeeLeg(venue, {
    basis: "tx_native_value",
    baseWei: quote.baseWei,
    // The fee does not reduce what this transaction sends: it is its own later
    // transaction, so `netWei` describes nothing here.
    netApplies: false,
    parentKind: "transaction",
    chainId: intent.chainId ?? 0,
    nativeAddress: NATIVE_SENTINEL,
    walletAddress: intent.walletAddress as Address,
    sessionId: intent.sessionId,
    // No USD estimate. This lane prices nothing and does not guess.
  });
  if (leg === null) {
    // Unreachable: `quote.charged` proves the same split produced a positive
    // fee, and `planNativeFeeLeg` returns null only when it floors to zero.
    // Stated as a typed skip rather than asserted away.
    const floored: Extract<WalletTxVexFeeQuote, { charged: false }> = {
      baseWei: quote.baseWei,
      feeWei: 0n,
      maxNetworkFeeWei: quote.maxNetworkFeeWei,
      charged: false,
      reason: "floors_to_zero",
    };
    return {
      charged: false,
      quote: floored,
      venue,
      disclosure: walletTxVexFeeDisclosure(venue, floored),
    };
  }

  return {
    charged: true,
    quote,
    venue,
    leg,
    bounds,
    disclosure: walletTxVexFeeDisclosure(venue, quote),
  };
}
