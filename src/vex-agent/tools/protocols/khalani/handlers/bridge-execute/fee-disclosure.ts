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
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  type BridgeFeeDisclosure,
  type BridgeFeeSplit,
} from "@tools/bridge-fee/index.js";
import type { KhalaniPlanNativeValue } from "@tools/khalani/deposit-native-value.js";
import type { BridgeChainFamily } from "@vex-agent/db/repos/agent-activity.js";
import {
  estimateUsd,
  humanizeAmount,
  resolveKhalaniTokenInfo,
  type KhalaniTokenInfo,
} from "../bridge-usd.js";

export interface KhalaniFeeDisclosureInput {
  readonly fromToken: string;
  readonly toToken: string;
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromFamily: BridgeChainFamily;
  readonly feeSplit: BridgeFeeSplit;
  readonly chargeFee: boolean;
  readonly feeSkipReason: string | null;
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
    resolveKhalaniTokenInfo(fromToken, input.fromChainId),
    resolveKhalaniTokenInfo(toToken, input.toChainId),
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
