/**
 * RECONSTRUCTING A BRIDGE DEPOSIT'S EVIDENCE LONG AFTER THE HANDLER IS GONE.
 *
 * The crash window this exists for: the handler proves a deposit's amount from
 * the receipt it is already holding, but if the process dies (or the status
 * sweep wins the race) the row is confirmed with no amounts and nobody holds the
 * plan any more. The repair lane then has a receipt and nothing else - and a
 * receipt alone cannot say which `Transfer` was the deposit, because "who was
 * this token authorized to reach" lives in the plan, not in the logs.
 *
 * So the evidence is rebuilt from CHAIN and from Vex's OWN durable rows, never
 * from a quote and never from a provider echo:
 *
 *   1. the mined signed transaction, validated as untrusted JSON, gives the
 *      sender and the call target the deposit actually paid, and for a NATIVE
 *      deposit its `value` is the principal - believed only once the receipt
 *      says the call succeeded;
 *   2. the same execution's earlier allowance rows - Vex's own record that IT
 *      signed those approvals - give the token-bound spenders, each re-read from
 *      its own mined `approve` transaction and replayed in `event_index` order;
 *   3. anything that cannot be re-proven declines by name.
 *
 * The rule that judges the receipt afterwards is the SAME one the handler uses
 * (`bridge-deposit-evidence.ts`). This module resolves inputs; it does not own a
 * second copy of what a log means.
 */

import {
  listActivityLegsByExecutionId,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { decodeErc20Approve } from "@tools/evm-chains/erc20-approval.js";
import {
  authorizedDepositRecipients,
  proveErc20DepositAmount,
  type DepositApprovalGrant,
  type DepositTransferLog,
} from "@vex-agent/tools/protocols/bridge-deposit-evidence.js";

/**
 * The four fields of a mined transaction this resolver reads. Every one is
 * validated from untrusted JSON-RPC before it can reach a money decision.
 */
export interface MinedTransaction {
  readonly from: string;
  /** `null` for a contract creation, which no deposit or approval ever is. */
  readonly to: string | null;
  readonly input: string;
  /** The signed `value`, in wei, as a decimal string. */
  readonly valueRaw: string;
}

/** The four states raw JSON-RPC can leave a receipt's status in. */
export type ReceiptStatus = "success" | "reverted" | "unreadable" | "absent";

export interface DepositEvidenceDeps {
  /**
   * The mined receipt's STATUS. `null` when the receipt could not be read at
   * all, which is a deferral and never a revert.
   */
  readonly fetchReceiptStatus: (input: {
    chainId: number;
    txHash: string;
  }) => Promise<ReceiptStatus | null>;
  /**
   * The mined signed transaction, by hash. `null` when it cannot be read right
   * now - a transport failure, never a decline.
   */
  readonly fetchTransaction: (input: {
    chainId: number;
    txHash: string;
  }) => Promise<MinedTransaction | null>;
}

export type ResolvedDepositEvidence =
  | { readonly kind: "decoded"; readonly executedAmountInRaw: string }
  | { readonly kind: "declined"; readonly detail: string }
  /** Nothing was learned: a read failed, so the row keeps its eligibility. */
  | { readonly kind: "deferred"; readonly detail: string };

/**
 * Establish a confirmed bridge deposit's executed input amount from its receipt,
 * or say by name why it cannot be established.
 */
export async function resolveBridgeDepositAmount(input: {
  readonly row: AgentActivityEvent;
  readonly logs: readonly DepositTransferLog[];
  readonly deps: DepositEvidenceDeps;
}): Promise<ResolvedDepositEvidence> {
  const { row, deps } = input;
  const txHash = row.txHash;
  const tokenInAddress = row.tokenInAddress;
  const amountInRaw = row.amountInRaw;
  if (txHash === null || tokenInAddress === null || amountInRaw === null) {
    return { kind: "declined", detail: "the row lacks the hash, input token or quoted amount the proof requires" };
  }
  if (isNativeAddress(tokenInAddress)) {
    return resolveNativeDepositAmount({ row, txHash, amountInRaw, deps });
  }

  const transaction = await deps.fetchTransaction({ chainId: row.chainId, txHash });
  if (transaction === null) {
    return { kind: "deferred", detail: "the signed transaction could not be read this pass" };
  }
  if (!sameAddress(transaction.from, row.walletAddress)) {
    return { kind: "declined", detail: "the mined transaction was not sent by this row's wallet" };
  }
  if (transaction.to === null) {
    return { kind: "declined", detail: "the mined transaction has no call target" };
  }

  const approvals = await resolveExecutionApprovals(row, deps);
  if (approvals.kind === "deferred") return approvals;

  const outcome = proveErc20DepositAmount({
    logs: input.logs,
    chainId: row.chainId,
    tokenAddress: tokenInAddress,
    senderAddress: row.walletAddress,
    recipients: authorizedDepositRecipients({
      inputToken: tokenInAddress,
      callTarget: transaction.to,
      approvals: approvals.grants,
    }),
    quotedAmountInRaw: amountInRaw,
  });

  if (outcome.kind === "proven") {
    return { kind: "decoded", executedAmountInRaw: outcome.amountRaw };
  }
  // A SHORTFALL is not an amount this lane may write. The receipt proved a
  // transfer BELOW the principal the row was quoted for, which the venue
  // records for review at return time; back-filling it here would silently turn
  // a disputed deposit into a settled one.
  if (outcome.kind === "short") {
    return {
      kind: "declined",
      detail: `the receipt proved ${outcome.provenAmountRaw} against a quoted ${outcome.quotedAmountRaw}, which is below the deposit floor`,
    };
  }
  return {
    kind: "declined",
    detail: `the receipt did not prove the deposit transfer (${outcome.reason}, candidates=${outcome.candidateCount})`,
  };
}

/**
 * A NATIVE bridge deposit: the value the transaction Vex signed IS the
 * principal, because a plain native transfer emits no log to read.
 *
 * The receipt STATUS is checked before that value is believed, and it is the
 * whole reason this arm cannot be a two-line branch: a payable call that
 * REVERTED still carries its non-zero `value` in the transaction, so a proof
 * built from `value` alone would stamp an amount for a deposit that moved
 * nothing and refunded the sender. Success is required; a revert declines; a
 * status neither literal defers, because an unreadable receipt is not evidence
 * of anything and must not burn the row's eligibility.
 *
 * The sender must be this row's own wallet. The recipient is deliberately NOT
 * compared: the only recipient available here is the mined transaction's own
 * `to`, and comparing a value to itself proves nothing. It becomes a real check
 * the moment an independently persisted verified recipient exists.
 */
async function resolveNativeDepositAmount(args: {
  readonly row: AgentActivityEvent;
  readonly txHash: string;
  readonly amountInRaw: string;
  readonly deps: DepositEvidenceDeps;
}): Promise<ResolvedDepositEvidence> {
  const { row, txHash, deps } = args;
  const bound = parseRawAmount(args.amountInRaw);
  if (bound === null || bound <= 0n) {
    return { kind: "declined", detail: "the row carries no quoted input amount to bound the deposit with" };
  }

  const status = await deps.fetchReceiptStatus({ chainId: row.chainId, txHash });
  if (status === null || status === "absent" || status === "unreadable") {
    return { kind: "deferred", detail: "the receipt status could not be read this pass" };
  }
  if (status === "reverted") {
    return { kind: "declined", detail: "the mined transaction reverted, so its value moved nothing" };
  }

  const transaction = await deps.fetchTransaction({ chainId: row.chainId, txHash });
  if (transaction === null) {
    return { kind: "deferred", detail: "the signed transaction could not be read this pass" };
  }
  if (!sameAddress(transaction.from, row.walletAddress)) {
    return { kind: "declined", detail: "the mined transaction was not sent by this row's wallet" };
  }
  const signedValue = parseRawAmount(transaction.valueRaw);
  if (signedValue === null || signedValue <= 0n) {
    return { kind: "declined", detail: "the mined transaction carries no native value to attribute" };
  }
  if (signedValue > bound) {
    return { kind: "declined", detail: "the mined transaction's value exceeds the quoted input amount" };
  }
  return { kind: "decoded", executedAmountInRaw: signedValue.toString() };
}

type ResolvedApprovals =
  | { readonly kind: "grants"; readonly grants: readonly DepositApprovalGrant[] }
  | { readonly kind: "deferred"; readonly detail: string };

/**
 * The approvals THIS execution signed before the deposit, re-read from chain.
 *
 * Every condition is a separate reason to drop an approval, and dropping one can
 * only narrow what the deposit is allowed to have paid:
 *
 *   - the row must be an allowance leg of the SAME execution, wallet and chain,
 *     with a LOWER `event_index` than the deposit (approvals after it authorize
 *     nothing about it);
 *   - the row must be `confirmed` - Vex's own record that the approval succeeded;
 *   - the mined transaction must have been sent by the same wallet and must
 *     decode as `approve(spender, amount)`, whose target IS the token approved.
 *
 * An unreadable approval transaction DEFERS the whole row instead of narrowing
 * it: proceeding would silently drop a real grant and turn a provable deposit
 * into a permanent decline stamped with the decoder version.
 */
async function resolveExecutionApprovals(
  row: AgentActivityEvent,
  deps: DepositEvidenceDeps,
): Promise<ResolvedApprovals> {
  const legs = await listActivityLegsByExecutionId(row.protocolExecutionId);
  const grants: DepositApprovalGrant[] = [];
  for (const leg of legs) {
    if (leg.eventIndex >= row.eventIndex) continue;
    if (leg.eventRole !== "allowance" && leg.eventRole !== "allowance_reset") continue;
    if (leg.status !== "confirmed") continue;
    if (leg.chainId !== row.chainId) continue;
    if (!sameAddress(leg.walletAddress, row.walletAddress)) continue;
    if (leg.txHash === null) continue;

    const approvalTx = await deps.fetchTransaction({ chainId: leg.chainId, txHash: leg.txHash });
    if (approvalTx === null) {
      return { kind: "deferred", detail: "an approval transaction of this execution could not be read this pass" };
    }
    if (!sameAddress(approvalTx.from, row.walletAddress) || approvalTx.to === null) continue;
    const approval = decodeErc20Approve(approvalTx.input);
    if (approval === null) continue;
    grants.push({ token: approvalTx.to, spender: approval.spender, amountRaw: approval.amount });
  }
  return { kind: "grants", grants };
}

const NATIVE_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

function isNativeAddress(address: string): boolean {
  return NATIVE_SENTINELS.has(address.trim().toLowerCase());
}

/** Atomic units, decimal digits only. Anything else is not an amount. */
function parseRawAmount(value: string): bigint | null {
  return /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
