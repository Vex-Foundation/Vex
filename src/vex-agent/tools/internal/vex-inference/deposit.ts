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
 * CONFIRM OWNS ITS APPROVAL (`approvalOwner: "handler"` on its ToolDef): the
 * dispatcher's generic restricted gate does not run for it, because that gate
 * would raise a card showing only the `intentId` and would also stop a
 * rule-covered follow-up from ever reaching the rule. Instead, in this order:
 *
 * | Context | Result |
 * |---|---|
 * | approved resume (`context.approved`) | executes ONLY if {@link verifyDepositApproval} proves the approval is of THIS intent's complete card; otherwise refused by name, nothing signed |
 * | full-permission session | executes without a card, exactly as `WalletSendConfirm` does |
 * | restricted, called by the MODEL directly | refused by name before the host: the card can only come from the engine's own dispatch after a prepare |
 * | restricted, engine follow-up, an ACTIVE auto top-up rule covers it | executes under the rule (same wallet, amount, caps, network-fee ceiling), caps shared with the poller |
 * | restricted, engine follow-up, no rule covers it | `pendingApproval` WITH the complete card binding ({@link depositApprovalBinding}); never a thin card |
 *
 * A rejected or expired card retires its intent
 * (`approval-binding.ts` `retireDepositIntentOfRejectedApproval`).
 *
 * The model cannot create, broaden or reuse authority: there is no
 * parameter for it, a rule is created only by the user in the funding page,
 * and an intent is single use and bound to this session.
 */

import { getAddress } from "viem";

import { resolveSelectedAddress, walletScopeErrorToResult } from "../wallet/resolve.js";
import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import {
  getVexInferenceHost,
  vexInferenceToolAvailability,
  vexInferenceUnavailableSentence,
  type AgentDepositRuntimeAuthority,
} from "./host.js";
import { depositApprovalBinding, verifyDepositApproval } from "./approval-binding.js";
import { depositCardArgs, VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL, VEX_INFERENCE_DEPOSIT_PREPARE_TOOL } from "./card.js";
import { checkDepositConfirmParams, checkDepositPrepareParams } from "./params.js";

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

  let authority: AgentDepositRuntimeAuthority;
  if (context.approved) {
    const verdict = await verifyDepositApproval(context.approvalId, context.sessionId, peeked.value);
    if (!verdict.ok) return fail(`Deposit not sent (approval_not_bound): ${verdict.reason}`);
    authority = { kind: "approved_card", approvalId: context.approvalId ?? null };
  } else if (context.sessionPermission === "full") {
    authority = { kind: "full_permission" };
  } else if (context.modelOriginated === true) {
    // A confirm the MODEL called directly carries no trusted card: only the
    // engine's own dispatch after a prepare holds the complete preview the
    // user must read. Refused before the host, so it can neither raise a thin
    // card nor spend under a rule the user did not see engaged.
    return fail(
      "needs_user_approval: in this session a Vex Inference deposit is confirmed only by Vex itself, right after "
      + `${VEX_INFERENCE_DEPOSIT_PREPARE_TOOL}, which raises the complete card or applies the user's auto top-up rule. `
      + `Nothing was signed and no funds moved. Call ${VEX_INFERENCE_DEPOSIT_PREPARE_TOOL} again; do not call ${VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL} yourself.`,
    );
  } else {
    authority = { kind: "none" };
  }

  const sourceWalletStillAllowed = (address: string): string | null => {
    const again = scopedWallet(context);
    if (!again.ok) return again.result.output;
    return again.address.toLowerCase() === address.toLowerCase()
      ? null
      : "The wallet selected for this session changed before signing. Nothing was signed.";
  };

  const outcome = await host.confirmAgentDeposit(
    { sessionId: context.sessionId, intentId, authority, sourceWalletStillAllowed },
    new AbortController().signal,
  );
  if (!outcome.ok) return fail(`Deposit not sent (${outcome.refusal.kind}): ${outcome.refusal.detail}`);
  const value = outcome.value;
  if (value.kind === "needs_user_approval") {
    return {
      success: false,
      output:
        `needs_user_approval: this deposit needs the user's approval before it can be signed (${value.reason}). `
        + `Nothing was signed and no funds moved: intent ${intentId} stays pending until ${value.intent.expiresAt} `
        + "and is consumed only after the user approves the exact deposit shown on the card.",
      pendingApproval: true,
      // Stamped here, not by the dispatcher fallback: the handler knows the risk class.
      actionKind: "user_wallet_broadcast",
      // THE COMPLETE CARD, bound into the approval digest. Every enqueue path
      // renders this binding instead of an argument-derived preview.
      preparedApprovalBinding: depositApprovalBinding(value.intent),
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
