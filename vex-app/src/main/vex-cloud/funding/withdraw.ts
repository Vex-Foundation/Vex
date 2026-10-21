/**
 * The Vex Cloud WITHDRAWAL owner: ask Vex Cloud to send unused VEX back to
 * one of the user's own wallets (owner decision D5, plan 4.3). The backend
 * signs and broadcasts; the app never holds that key.
 *
 * THE DESTINATION IS CHOSEN, NEVER TYPED. Only a wallet that is BOTH linked
 * to the account AND in this app's inventory is offered and accepted; main
 * checks that membership on prepare and again on submit, against a fresh
 * account read, and the backend checks it a third time (403
 * `destination_not_linked`).
 *
 * ONE IDEMPOTENCY KEY PER APPROVED PROPOSAL. `prepare` mints the proposal
 * and its key together. A submit that ends in a transport failure (network,
 * deadline, 5xx) KEEPS the proposal, so pressing the button again sends the
 * SAME key and the backend answers with the same withdrawal instead of
 * creating a second one. A new proposal always gets a new key. A definitive
 * refusal or a success retires the proposal. Only while the proposal is
 * live: an expired one is refused, and History shows whether an unanswered
 * attempt reached Vex Cloud.
 *
 * AUDIT: one `asked` and one `decided` line per submit, correlated.
 */

import { randomUUID } from "node:crypto";
import type {
  VexCloudPrepareWithdrawalInput,
  VexCloudSubmitWithdrawalInput,
  VexCloudSubmitWithdrawalResult,
  VexCloudWithdrawal,
  VexCloudWithdrawalProposal,
} from "@shared/schemas/vex-cloud-funding.js";
import {
  formatMicroUsd,
  formatVexExact,
  microUsdToWeiCeil,
  parseRateX18,
  parseVexAmountText,
  VEX_CLOUD_CHAIN_ID,
  weiToMicroUsdFloor,
} from "@shared/vex-cloud-money.js";
import { log } from "../../logger/index.js";
import type { VexCloudAccountResponse, VexCloudApi, WithdrawalResponse } from "../api-client.js";
import { refused, type VexCloudOutcome } from "../outcome.js";
import { backendRefusal, requireBearer, type SessionPort } from "./backend-call.js";
import { ProposalStore, type StoredProposal } from "./proposal-store.js";

/** How long a withdrawal approval stays valid. */
export const WITHDRAWAL_PROPOSAL_TTL_MS = 300_000;

export interface WithdrawDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount" | "createWithdrawal" | "readWithdrawal">;
  /** In-app EVM wallet addresses. */
  readonly localWallets: () => readonly string[];
  readonly now: () => Date;
  /** Injected for tests; a fresh random key per proposal in production. */
  readonly mintIdempotencyKey?: () => string;
}

interface WithdrawalEntry extends StoredProposal {
  readonly proposal: VexCloudWithdrawalProposal;
  /** Minted with the proposal; reused by every transport retry of it. */
  readonly idempotencyKey: string;
}

let proposals = new ProposalStore<WithdrawalEntry>();
let submitting = new Set<string>();

/** Test-only reset. */
export function __resetWithdrawStateForTests(): void {
  proposals = new ProposalStore<WithdrawalEntry>();
  submitting = new Set<string>();
}

function defaultIdempotencyKey(): string {
  return `vxw_${randomUUID().replace(/-/g, "")}`;
}

export function toWithdrawal(response: WithdrawalResponse): VexCloudWithdrawal {
  const w = response.withdrawal;
  return {
    id: w.id,
    status: w.status,
    amountWei: w.amount_wei,
    destination: w.destination,
    txHash: w.tx_hash,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

/** Linked to the account AND in this app's inventory: the only destinations offered. */
export function eligibleDestinations(account: VexCloudAccountResponse, localWallets: readonly string[]): readonly string[] {
  const local = new Set(localWallets.map((address) => address.toLowerCase()));
  return account.wallets.map((wallet) => wallet.address).filter((address) => local.has(address.toLowerCase()));
}

function isEligible(account: VexCloudAccountResponse, localWallets: readonly string[], destination: string): boolean {
  return eligibleDestinations(account, localWallets).some((address) => address.toLowerCase() === destination.toLowerCase());
}

const NOTHING_SENT = "Nothing was sent.";

export async function prepareWithdrawal(
  deps: WithdrawDeps,
  input: VexCloudPrepareWithdrawalInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudWithdrawalProposal>> {
  const amount = parseVexAmountText(input.amountText);
  if (!amount.ok) {
    return refused(
      "invalid_amount",
      amount.reason === "too_precise"
        ? "VEX has 18 decimals; enter at most 18 digits after the point."
        : "Enter an amount of VEX above zero, as digits with at most one point.",
    );
  }
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  const account = read.value;
  if (!isEligible(account, deps.localWallets(), input.destination)) {
    return refused(
      "destination_not_linked",
      "Withdrawals go only to a wallet that is linked to your Vex Cloud account and is in this app. Pick one from the list.",
    );
  }
  if (account.status.paused) {
    return refused("account_paused", `Vex Cloud paused this account for review, so funds cannot leave it right now. ${NOTHING_SENT}`);
  }
  const rateX18 = account.rate.available ? parseRateX18(account.rate.vex_wei_per_micro_usd) : null;
  if (rateX18 === null) {
    return refused("rate_unavailable", `Vex Cloud has no current VEX price, so the $5 minimum cannot be checked. ${NOTHING_SENT} Try again in a few minutes.`);
  }
  const minimumMicroUsd = BigInt(account.limits.min_withdraw_micro_usd);
  const minimumWei = microUsdToWeiCeil(minimumMicroUsd, rateX18);
  if (amount.wei < minimumWei) {
    return refused(
      "below_minimum",
      `The minimum withdrawal is ${formatMicroUsd(minimumMicroUsd)}, which is ${formatVexExact(minimumWei)} VEX at the current rate.`,
    );
  }
  const withdrawable = account.withdrawable_wei === undefined ? null : BigInt(account.withdrawable_wei);
  if (withdrawable !== null && amount.wei > withdrawable) {
    return refused(
      "insufficient_withdrawable",
      `You can withdraw up to ${formatVexExact(withdrawable)} VEX now. Only finalized deposits can leave; funds reserved for running requests and pending deposits cannot.`,
    );
  }
  const remaining = account.limits.withdraw_daily_remaining_wei ?? null;
  if (remaining !== null && amount.wei > BigInt(remaining)) {
    return refused(
      "daily_limit_exceeded",
      `That is above your daily withdrawal limit: you can withdraw up to ${formatVexExact(BigInt(remaining))} VEX more today.`,
    );
  }
  const now = deps.now();
  const expiresAtMs = now.getTime() + WITHDRAWAL_PROPOSAL_TTL_MS;
  const mint = deps.mintIdempotencyKey ?? defaultIdempotencyKey;
  const entry = proposals.mint((proposalId) => ({
    proposalId,
    expiresAtMs,
    idempotencyKey: mint(),
    proposal: {
      proposalId,
      actor: "user",
      chainId: VEX_CLOUD_CHAIN_ID,
      amountWei: amount.wei.toString(),
      destination: input.destination,
      usdMicroEstimate: weiToMicroUsdFloor(amount.wei, rateX18).toString(),
      minimumWei: minimumWei.toString(),
      minimumMicroUsd: minimumMicroUsd.toString(),
      withdrawableWei: withdrawable === null ? null : withdrawable.toString(),
      dailyRemainingWei: remaining,
      dailyLimitMicroUsd: account.limits.withdraw_daily_limit_micro_usd ?? null,
      preparedAt: now.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  }));
  return { ok: true, value: entry.proposal };
}

export async function submitWithdrawal(
  deps: WithdrawDeps,
  input: VexCloudSubmitWithdrawalInput,
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<VexCloudSubmitWithdrawalResult>> {
  // Reserved before the first await: two clicks on one proposal never send in parallel.
  if (submitting.has(input.proposalId)) {
    return refused("already_running", "This withdrawal is already being sent. Wait for it to finish.");
  }
  submitting.add(input.proposalId);
  log.info(`[vex-cloud:withdraw] asked correlationId=${correlationId}`);
  let decided = "refused";
  try {
    const outcome = await runSubmit(deps, input, signal);
    decided = outcome.ok ? `accepted:${outcome.value.withdrawal.status}` : `refused:${outcome.refusal.kind}`;
    return outcome;
  } finally {
    submitting.delete(input.proposalId);
    log.info(`[vex-cloud:withdraw] decided outcome=${decided} correlationId=${correlationId}`);
  }
}

async function runSubmit(
  deps: WithdrawDeps,
  input: VexCloudSubmitWithdrawalInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudSubmitWithdrawalResult>> {
  const found = proposals.peek(input.proposalId);
  if (found.kind === "missing") {
    return refused("proposal_missing", `This withdrawal was already sent, cancelled or never prepared. ${NOTHING_SENT} Check History before starting a new one.`);
  }
  if (found.kind === "expired") {
    return refused("proposal_expired", `This withdrawal approval expired. Check History to see whether an earlier attempt reached Vex Cloud, then start a new one.`);
  }
  const { proposal, idempotencyKey } = found.entry;
  if (input.destination.toLowerCase() !== proposal.destination.toLowerCase() || input.amountWei !== proposal.amountWei) {
    proposals.drop(proposal.proposalId);
    return refused("proposal_changed", `The amount or destination differs from the withdrawal you reviewed. ${NOTHING_SENT} Review it again.`);
  }
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  if (!isEligible(read.value, deps.localWallets(), proposal.destination)) {
    proposals.drop(proposal.proposalId);
    return refused("destination_not_linked", `That wallet is no longer both linked and in this app. ${NOTHING_SENT}`);
  }
  const created = await deps.api.createWithdrawal(
    bearer.value,
    idempotencyKey,
    { amountWei: proposal.amountWei, destination: proposal.destination },
    signal,
  );
  if (created.ok) {
    proposals.drop(proposal.proposalId);
    return { ok: true, value: { withdrawal: toWithdrawal(created.value) } };
  }
  // A transport failure keeps the proposal and its key for a retry of THIS approval.
  const transient = created.failure.kind === "unavailable" || created.failure.kind === "cancelled";
  if (!transient) proposals.drop(proposal.proposalId);
  const refusal = await backendRefusal<VexCloudSubmitWithdrawalResult>(deps, created.failure);
  if (!refusal.ok && created.failure.kind === "unavailable") {
    return refused(
      refusal.refusal.kind,
      `${refusal.refusal.detail} Vex Cloud may or may not have received the withdrawal; pressing Withdraw again repeats the same request and cannot send it twice.`,
    );
  }
  return refusal;
}

export async function readWithdrawalStatus(
  deps: WithdrawDeps,
  withdrawalId: string,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudSubmitWithdrawalResult>> {
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readWithdrawal(bearer.value, withdrawalId, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  return { ok: true, value: { withdrawal: toWithdrawal(read.value) } };
}
