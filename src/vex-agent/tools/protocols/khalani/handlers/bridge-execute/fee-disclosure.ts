/**
 * `khalani.bridge` USD/token facts and Vex-fee disclosure (step 7 of the
 * staged-execute contract, split out in 0R.4, refactor-only). Khalani serves
 * no USD, so these are resolved here - BEFORE the dryRun branch - which is
 * what makes the preview disclose the SAME fee the execute charges, and the
 * dryRun preview of the native-cost breakdown.
 */

import {
  BRIDGE_FEE_RECEIVER_EVM,
  BRIDGE_FEE_RECEIVER_SOLANA,
  bridgeFeeStatementChangedMessage,
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  checkBridgeFeeStatementUnchanged,
  missingBridgeFeeStatementMessage,
  unauthorizedBridgeQuoteMessage,
  VEX_FEE_STATEMENT_CHANGED_REASON,
  VEX_FEE_STATEMENT_MISSING_REASON,
  type BridgeFeeDisclosure,
  type BridgeFeeSplit,
} from "@tools/bridge-fee/index.js";
import { findFreshMatchedPrequote } from "@vex-agent/tools/protocols/prequote/gate.js";
import logger from "@utils/logger.js";
import type { KhalaniPlanNativeValue } from "@tools/khalani/deposit-native-value.js";
import type { BridgeChainFamily } from "@vex-agent/db/repos/agent-activity.js";
import {
  estimateUsd,
  humanizeAmount,
  resolveKhalaniBridgeTokenInfo,
  type KhalaniTokenInfo,
} from "../bridge-usd.js";
import type { BridgeTokenIdentityPreview } from "@vex-agent/tools/protocols/bridge-token-identity.js";
import type { ProtocolExecutionContext } from "../../../types.js";

export interface KhalaniFeeDisclosureInput {
  readonly fromToken: string;
  readonly toToken: string;
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromFamily: BridgeChainFamily;
  readonly toFamily: BridgeChainFamily;
  readonly feeSplit: BridgeFeeSplit;
  readonly chargeFee: boolean;
  readonly feeSkipReason: string | null;
  readonly signal?: AbortSignal;
  readonly tokenIdentity: BridgeTokenIdentityPreview;
}

export interface KhalaniFeeDisclosure {
  readonly fromInfo: KhalaniTokenInfo | null;
  readonly toInfo: KhalaniTokenInfo | null;
  readonly feeAmountHuman: string | undefined;
  /**
   * ONE derivation, used by BOTH the agent-facing disclosure and the
   * `bridge_fee` row's `usd_vex_fee_est` (migration 050), so the number Vex
   * discloses and the number Vex records can never drift apart. `undefined`
   * (never 0) when the source token has no price.
   */
  readonly usdVexFee: string | undefined;
  readonly vexFee: BridgeFeeDisclosure;
}

export async function resolveKhalaniFeeDisclosure(
  input: KhalaniFeeDisclosureInput,
): Promise<KhalaniFeeDisclosure> {
  const { fromToken, toToken, feeSplit, chargeFee } = input;
  const [fromInfo, toInfo]: [KhalaniTokenInfo | null, KhalaniTokenInfo | null] = await Promise.all([
    resolveKhalaniBridgeTokenInfo(fromToken, input.fromChainId, input.tokenIdentity.source),
    resolveKhalaniBridgeTokenInfo(toToken, input.toChainId, input.tokenIdentity.destination),
  ]);
  const feeAmountHuman = humanizeAmount(feeSplit.feeRaw.toString(), fromInfo?.decimals);
  const usdVexFee = chargeFee ? estimateUsd(feeAmountHuman, fromInfo?.priceUsd) : undefined;
  const vexFee: BridgeFeeDisclosure = chargeFee
    ? buildBridgeFeeDisclosure({
        tokenAddress: fromToken,
        tokenSymbol: fromInfo?.symbol,
        tokenDecimals: fromInfo?.decimals,
        feeRaw: feeSplit.feeRaw,
        bridgedRaw: feeSplit.bridgedRaw,
        totalRaw: feeSplit.totalRaw,
        receiver: input.fromFamily === "solana" ? BRIDGE_FEE_RECEIVER_SOLANA : BRIDGE_FEE_RECEIVER_EVM,
        feeUsdEstimate: usdVexFee,
      })
    : buildBridgeFeeSkippedDisclosure({
        reason: input.feeSkipReason ?? "no fee applies to this bridge",
        totalRaw: feeSplit.totalRaw,
      });
  return { fromInfo, toInfo, feeAmountHuman, usdVexFee, vexFee };
}

/** The tool id the prequote channel gates, and the quote tool an agent recalls. */
const KHALANI_BRIDGE_TOOL_ID = "khalani.bridge";
const KHALANI_QUOTE_TOOL_NAME = "khalani__bridge_quote_get";

/**
 * Hold this bridge to the Vex fee statement its approval was granted on, in the
 * pre-sign window (rule 90).
 *
 * The disposition is decided at QUOTE time on this venue too (skipping the fee
 * changes the amount Khalani is quoted for, so it cannot be deferred), which is
 * exactly why it can move: the same params quoted twice can straddle a token
 * being flagged fee-on-transfer or a honeypot. The row states what a person
 * approved, this call states what would actually happen, and a disagreement
 * REFUSES rather than picking one.
 *
 * Returns the agent-facing refusal, or `null` when the call may proceed - which
 * is also the answer when the tool carries no prequote channel at all, since
 * there is then no approved statement in existence to contradict.
 *
 * Runs before the deposit plan is committed, before the in-flight guard, before
 * the intent and before the signing wallet is resolved, so a refusal signs
 * nothing, broadcasts nothing and reserves nothing.
 */
export async function khalaniVexFeeStatementRefusal(input: {
  readonly params: Record<string, unknown>;
  readonly context: ProtocolExecutionContext;
  readonly sessionId: string;
  /** The disposition this call would actually execute on, freshly derived. */
  readonly derivedNow: BridgeFeeDisclosure;
}): Promise<string | null> {
  const matched = await findFreshMatchedPrequote(
    KHALANI_BRIDGE_TOOL_ID,
    input.sessionId,
    input.params,
    input.context,
  );
  if (!matched.ok) {
    // Destructured so the literal narrows: `not_gated` is the one refusal that
    // is not a refusal at all, it says this tool carries no prequote channel.
    const { reason, eligibilityKind } = matched;
    if (reason === "not_gated") return null;
    return unauthorizedBridgeQuoteMessage({ reason, eligibilityKind }, KHALANI_QUOTE_TOOL_NAME);
  }
  if (matched.vexFee === undefined) {
    logger.warn("khalani.bridge.vex_fee_statement_missing", { reason: VEX_FEE_STATEMENT_MISSING_REASON });
    return missingBridgeFeeStatementMessage(KHALANI_QUOTE_TOOL_NAME);
  }
  const check = checkBridgeFeeStatementUnchanged({
    statedOnCard: matched.vexFee,
    derivedNow: input.derivedNow,
  });
  if (check.ok) return null;
  // The FIELD only: the two values carry a treasury address and the amounts the
  // card showed, and the agent receives those in the refusal itself.
  logger.warn("khalani.bridge.vex_fee_statement_changed", {
    reason: VEX_FEE_STATEMENT_CHANGED_REASON,
    field: check.field,
  });
  return bridgeFeeStatementChangedMessage(check, KHALANI_QUOTE_TOOL_NAME);
}

/**
 * The native-cost block the dryRun preview carries. A preview that cannot show
 * the breakdown says so and says why - silence would read as "no native charge",
 * which is exactly the misreading that let an undisclosed 1e15 wei through.
 */
export function nativeCostPreview(
  nativeCost: KhalaniPlanNativeValue | null,
  planUnavailable: boolean,
): Record<string, unknown> {
  if (nativeCost === null) {
    return {
      available: false,
      reason: planUnavailable
        ? "this deposit plan cannot be broadcast by Vex, so it has no signable legs to classify"
        : "the native-currency charges could not be verified on-chain this turn",
      note: "An execute would refuse rather than sign an unclassified native charge.",
    };
  }
  return {
    available: true,
    totalNativeOutflowWei: nativeCost.totalNativeOutflowWei,
    legs: nativeCost.disclosures,
    wouldRefuse: nativeCost.refusal !== null,
    refusal: nativeCost.refusal,
  };
}
