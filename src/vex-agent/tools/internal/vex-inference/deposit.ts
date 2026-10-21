/**
 * `VexInferenceDepositPrepare` / `VexInferenceDepositConfirm`: the agent's
 * two-call deposit into the user's Vex Inference balance, modelled on
 * `WalletSendPrepare` / `WalletSendConfirm`.
 *
 * WHAT THE MODEL MAY SUPPLY: the amount (in VEX, or in USD converted at the
 * backend rate) and, optionally, the source wallet, which must be the EVM
 * wallet selected for this session and allowed by the mission wallet policy
 * (`resolveSelectedAddress`, the same scope every signing tool uses). Nothing
 * else: a destination, token, chain or fee field is refused BY NAME
 * (`params.ts`). The host proves the wallet is in the inventory AND linked
 * to the signed-in account, and that the pinned deposit address equals the
 * backend's.
 *
 * AUTHORITY, IN THIS ORDER (the existing policy, unchanged, plus one rule):
 *
 * 1. an approved card (`context.approved`): the user approved THIS intent;
 * 2. a full-permission session: executes without a card, exactly as
 *    `WalletSendConfirm` does;
 * 3. otherwise the host checks for an ACTIVE auto top-up rule that covers
 *    the request (same source wallet, amount at most the rule's per-top-up
 *    amount, within its daily count and 30-day cap counted on durable state)
 *    and, only if one does, executes under that rule through the rule's own
 *    execution owner, so the caps are shared with the poller;
 * 4. otherwise `needs_user_approval`: `pendingApproval` raises the card.
 *    Never a silent skip.
 *
 * The model cannot create, broaden or reuse authority: there is no
 * parameter for it, a rule is created only by the user in the funding page,
 * and an intent is single use and bound to this session.
 */

import { randomUUID } from "node:crypto";
import { getAddress } from "viem";

import { resolveSelectedAddress, walletScopeErrorToResult } from "../wallet/resolve.js";
import type { ApprovalPreviewScalar, ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import {
  getVexInferenceHost,
  vexInferenceToolAvailability,
  vexInferenceUnavailableSentence,
  type AgentDepositIntentView,
  type AgentDepositRuntimeAuthority,
} from "./host.js";
import { checkDepositConfirmParams, checkDepositPrepareParams } from "./params.js";

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

/** Exact decimal ETH from wei (18 decimals, trailing zeros removed). */
function formatEthExact(wei: string): string {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** The card a human approves: every money line, rendered from the host's intent and nothing else. */
export function depositCardArgs(intent: AgentDepositIntentView): Record<(typeof VEX_INFERENCE_DEPOSIT_CARD_KEYS)[number], ApprovalPreviewScalar> {
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

function unavailable(): ToolResult | null {
  const availability = vexInferenceToolAvailability();
  if (!availability.available) return fail(vexInferenceUnavailableSentence(availability.reason));
  return null;
}

/** The session's selected EVM wallet under the mission wallet policy, or the scope refusal. */
function scopedWallet(context: InternalToolContext): { readonly ok: true; readonly address: string } | { readonly ok: false; readonly result: ToolResult } {
  try {
    return { ok: true, address: getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155")) };
  } catch (err) {
    return { ok: false, result: walletScopeErrorToResult(err) };
  }
}

// ── prepare ──────────────────────────────────────────────────────────────

export async function handleVexInferenceDepositPrepare(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const blocked = unavailable();
  if (blocked !== null) return blocked;
  const host = getVexInferenceHost();
  if (host === null) return fail(vexInferenceUnavailableSentence("host_not_mounted"));
  const checked = checkDepositPrepareParams(params);
  if (!checked.ok) return fail(checked.message);

  const scoped = scopedWallet(context);
  if (!scoped.ok) return scoped.result;
  if (checked.value.walletAddress !== null && checked.value.walletAddress.toLowerCase() !== scoped.address.toLowerCase()) {
    return fail(
      `Refused: \`walletAddress\` ${checked.value.walletAddress} is not the EVM wallet selected for this session (${scoped.address}). `
      + "A deposit can only come from the selected wallet. Omit `walletAddress` or pass that one. Nothing was prepared.",
    );
  }

  const prepared = await host.prepareAgentDeposit(
    { sessionId: context.sessionId, walletAddress: scoped.address, amount: checked.value.amount },
    new AbortController().signal,
  );
  if (!prepared.ok) {
    return fail(`Deposit not prepared (${prepared.refusal.kind}): ${prepared.refusal.detail}`);
  }
  const intent = prepared.value;
  const overMcp = context.toolLane === "mcp";
  const result = ok({
    summary:
      `Prepared a deposit of ${intent.amount.vex} VEX from ${intent.from} to the Vex Inference deposit address. Nothing was signed. `
      + (overMcp
        ? `Call ${VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL} with intentId ${intent.intentId} before ${intent.expiresAt}.`
        : "Vex will confirm it automatically; a card is raised when the user must approve."),
    status: "prepared",
    ...intent,
  });
  if (overMcp) return result;
  return {
    ...result,
    preparedActionFollowUp: {
      toolName: VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL,
      args: { intentId: intent.intentId },
      expiresAt: intent.expiresAt,
      approvalPreview: { toolName: VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL, criticalArgs: depositCardArgs(intent) },
    },
  };
}

// ── confirm ──────────────────────────────────────────────────────────────

function runtimeAuthority(context: InternalToolContext): AgentDepositRuntimeAuthority {
  if (context.approved) return { kind: "approved_card", approvalId: context.approvalId ?? null };
  if (context.sessionPermission === "full") return { kind: "full_permission" };
  return { kind: "none" };
}

export async function handleVexInferenceDepositConfirm(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const blocked = unavailable();
  if (blocked !== null) return blocked;
  const host = getVexInferenceHost();
  if (host === null) return fail(vexInferenceUnavailableSentence("host_not_mounted"));
  const checked = checkDepositConfirmParams(params);
  if (!checked.ok) return fail(checked.message);
  const { intentId } = checked.value;

  // The intent, for THIS session, before anything else: a cross-session id is "not found".
  const peeked = host.peekAgentDeposit(context.sessionId, intentId);
  if (!peeked.ok) return fail(`Deposit not sent (${peeked.refusal.kind}): ${peeked.refusal.detail}`);
  const scoped = scopedWallet(context);
  if (!scoped.ok) return scoped.result;
  if (scoped.address.toLowerCase() !== peeked.value.from.toLowerCase()) {
    return fail(
      `Refused: this deposit was prepared from ${peeked.value.from}, and the wallet selected for this session is now ${scoped.address}. `
      + "Nothing was signed. Prepare the deposit again.",
    );
  }

  const sourceWalletStillAllowed = (address: string): string | null => {
    const again = scopedWallet(context);
    if (!again.ok) return again.result.output;
    return again.address.toLowerCase() === address.toLowerCase()
      ? null
      : "The wallet selected for this session changed before signing. Nothing was signed.";
  };

  const outcome = await host.confirmAgentDeposit(
    { sessionId: context.sessionId, intentId, authority: runtimeAuthority(context), sourceWalletStillAllowed },
    new AbortController().signal,
  );
  if (!outcome.ok) return fail(`Deposit not sent (${outcome.refusal.kind}): ${outcome.refusal.detail}`);
  const value = outcome.value;
  if (value.kind === "needs_user_approval") {
    if (context.modelOriginated === true) {
      // A confirm the MODEL called directly carries no trusted card: only the
      // engine's own dispatch after a prepare holds the full preview the user
      // must read. Refuse by name instead of raising a card without its lines.
      return fail(
        `needs_user_approval: this deposit needs the user's approval (${value.reason}), and a card can only be raised `
        + `from a fresh ${VEX_INFERENCE_DEPOSIT_PREPARE_TOOL} call, which Vex confirms itself. Nothing was signed and no funds moved. `
        + `Call ${VEX_INFERENCE_DEPOSIT_PREPARE_TOOL} again; do not call ${VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL} yourself.`,
      );
    }
    return {
      success: false,
      output:
        `needs_user_approval: this deposit needs the user's approval before it can be signed (${value.reason}). `
        + `Nothing was signed and no funds moved: intent ${intentId} stays pending until ${value.intent.expiresAt} `
        + "and is consumed only after the user approves the exact deposit shown on the card.",
      pendingApproval: true,
    };
  }
  const authorityLine = value.authority === "auto_top_up_rule"
    ? `under the user's auto top-up rule ${value.ruleId ?? ""}`.trim()
    : value.authority === "approved_card"
      ? "under the user's approval of the card"
      : "under the session's full permission";
  if (value.status === "pending") {
    return {
      success: false,
      output:
        `The deposit ${value.txHash} was broadcast ${authorityLine}, but its outcome is UNKNOWN and it is still pending: it may still settle on chain. `
        + "Do not retry and do not prepare another deposit for it: this attempt is recorded and counts against any auto top-up cap. "
        + `Check it yourself with ChainRead (action tx_receipt, chain=robinhood, txHash=${value.txHash}), or read VexInferenceStatus for the balance.`,
      data: { txHash: value.txHash, status: value.status, intentId },
    };
  }
  if (value.status === "reverted") {
    return {
      success: false,
      output:
        `The deposit ${value.txHash} was mined but REVERTED on chain ${authorityLine}: no VEX moved, and the network fee was paid. `
        + "It is recorded. Do not retry automatically; tell the user and let them decide.",
      data: { txHash: value.txHash, status: value.status, intentId },
    };
  }
  return ok({
    summary:
      `Deposited ${value.intent.amount.vex} VEX from ${value.intent.from} to Vex Inference ${authorityLine}. `
      + `Confirmed on Robinhood Chain in ${value.txHash}. The balance updates once Vex Inference sees the transfer.`,
    status: "confirmed",
    txHash: value.txHash,
    transferProven: value.transferProven,
    backendNotified: value.notified,
    authority: value.authority,
    ruleId: value.ruleId,
    executionId: value.executionId,
    amount: value.intent.amount,
    from: value.intent.from,
    depositAddress: value.intent.depositAddress,
    chainId: value.intent.chainId,
  });
}

/** A fresh intent id in the shape the confirm and the follow-up validator require. */
export function newAgentDepositIntentId(): string {
  return `vxdep-${randomUUID()}`;
}
