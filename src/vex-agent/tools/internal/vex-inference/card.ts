/**
 * THE VEX INFERENCE DEPOSIT CARD: the tool names of the prepare and confirm
 * pair and the exact lines a human approves, rendered from the host's intent
 * and nothing else (no model argument reaches a line). Pure: the follow-up
 * validator (`registry/prepared-action-follow-ups.ts`), the prepare handler
 * and the approval binding (`./approval-binding.ts`) all render from here, so
 * the three cannot drift apart.
 */

import type { ApprovalPreviewScalar } from "../../types.js";
import type { AgentDepositIntentView } from "./host.js";

export const VEX_INFERENCE_DEPOSIT_PREPARE_TOOL = "VexInferenceDepositPrepare" as const;
export const VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL = "VexInferenceDepositConfirm" as const;


/** The exact keys the approval card carries, in display order. The follow-up validator requires exactly these. */
export const VEX_INFERENCE_DEPOSIT_CARD_KEYS = [
  "summary",
  "realFunds",
  "intentId",
  "chain",
  "chainId",
  "token",
  "tokenAddress",
  "tokenDecimals",
  "amountVex",
  "amountWei",
  "amountUsdEstimate",
  "requested",
  "from",
  "depositAddress",
  "minimumVex",
  "minimumUsd",
  "maxNetworkFeeEth",
  "maxNetworkFeeWei",
  "gasLimit",
  "maxFeePerGasWei",
  "maxPriorityFeePerGasWei",
  "irreversible",
  "expiresAt",
] as const;

export type DepositCardArgs = Record<(typeof VEX_INFERENCE_DEPOSIT_CARD_KEYS)[number], ApprovalPreviewScalar>;

/** Exact decimal ETH from wei (18 decimals, trailing zeros removed). */
function formatEthExact(wei: string): string {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** The card a human approves: every money line, rendered from the host's intent and nothing else. */
export function depositCardArgs(intent: AgentDepositIntentView): DepositCardArgs {
  const usd = intent.amount.usdEstimate === null ? "Not available" : `$${intent.amount.usdEstimate}`;
  const requested = intent.requested.unit === "VEX"
    ? `${intent.requested.value} VEX`
    : `$${intent.requested.value}, converted to VEX at the Vex Inference rate and rounded up to whole wei`;
  return {
    summary: `Deposit ${intent.amount.vex} VEX (${usd}) from ${intent.from} into your Vex Inference balance on Robinhood Chain.`,
    realFunds: "REAL FUNDS: this signs and broadcasts an on-chain VEX transfer from your wallet.",
    intentId: intent.intentId,
    chain: "Robinhood Chain (4663)",
    chainId: intent.chainId,
    token: intent.token.symbol,
    tokenAddress: intent.token.address,
    tokenDecimals: intent.token.decimals,
    amountVex: intent.amount.vex,
    amountWei: intent.amount.wei,
    amountUsdEstimate: usd,
    requested,
    from: intent.from,
    depositAddress: intent.depositAddress,
    minimumVex: intent.minimum.vex,
    minimumUsd: intent.minimum.usdEstimate === null ? "Not available" : `$${intent.minimum.usdEstimate}`,
    maxNetworkFeeEth: `${formatEthExact(intent.networkFee.maxNetworkFeeWei)} ETH at most`,
    maxNetworkFeeWei: intent.networkFee.maxNetworkFeeWei,
    gasLimit: intent.networkFee.gasLimit,
    maxFeePerGasWei: intent.networkFee.maxFeePerGasWei,
    maxPriorityFeePerGasWei: intent.networkFee.maxPriorityFeePerGasWei,
    irreversible:
      "A sent transfer cannot be recalled. It credits your Vex Inference balance; unused VEX can be withdrawn later only to a linked wallet.",
    expiresAt: intent.expiresAt,
  };
}
