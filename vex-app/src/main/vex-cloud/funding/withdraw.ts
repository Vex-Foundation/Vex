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
 * and its key together; a new proposal always gets a new key.
 *
 * TWO STORES, BECAUSE THERE ARE TWO STATES.
 *  - `approved`: prepared, never sent. Its deadline is the approval's: it is
 *    checked when looked up AND again right before the POST, after the fresh
 *    account read, so an approval that lapsed while that read ran is refused
 *    before anything leaves the app.
 *  - `unresolved`: SENT, and Vex Cloud's answer did not prove a refusal
 *    (`isDefinitiveRefusal`). The commit outcome is UNKNOWN: the withdrawal
 *    may exist. The entry and its key are kept, and "Check status" REPLAYS
 *    the same key with the same body. The backend's idempotency returns the
 *    existing withdrawal for that key before any other check
 *    (`VexVirtualsCompute/src/withdrawals/ledger.ts` `requestWithdrawal`).
 *
 * A REPLAY IS NOT A NEW APPROVAL. It is the request the user already
 * approved and sent, repeated byte for byte, so it is allowed after the
 * approval's expiry and does not re-run the local destination gate: if the
 * first POST committed, the replay can only return that withdrawal; if it
 * never landed, the backend runs every check of a create for it (linked,
 * paused, minimum, withdrawable, daily limit). Only a definitive refusal or a
 * success retires the key.
 *
 * AUDIT: one `asked` and one `decided` line per submit, correlated.
 */

import { randomUUID } from "node:crypto";
import type {
  VexCloudPrepareWithdrawalInput,
  VexCloudSubmitWithdrawalInput,
  VexCloudSubmitWithdrawalResult,
  VexCloudWithdrawal,
  VexCloudWithdrawalStatusResult,
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
import { backendRefusal, isDefinitiveRefusal, requireBearer, type SessionPort } from "./backend-call.js";
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

/** Retention of a sent proposal whose outcome is unknown: long enough to check it, bounded by the store. */
export const UNRESOLVED_WITHDRAWAL_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Prepared and approved, never sent. */
let approved = new ProposalStore<WithdrawalEntry>();
/** Sent, outcome unknown: replayable with the same key. */
let unresolved = new ProposalStore<WithdrawalEntry>();
let submitting = new Set<string>();

/** Test-only reset. */
export function __resetWithdrawStateForTests(): void {
  approved = new ProposalStore<WithdrawalEntry>();
  unresolved = new ProposalStore<WithdrawalEntry>();
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
  const entry = approved.mint(now.getTime(), (proposalId) => ({
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
    decided = !outcome.ok
      ? `refused:${outcome.refusal.kind}`
      : outcome.value.outcome === "accepted"
        ? `accepted:${outcome.value.withdrawal.status}`
        : "unknown";
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
  const nowMs = deps.now().getTime();
  const sent = unresolved.peek(input.proposalId, nowMs);
  if (sent.kind === "ok") return replay(deps, sent.entry, input, signal);

  const found = approved.peek(input.proposalId, nowMs);
  if (found.kind === "missing") {
    return refused("proposal_missing", `This withdrawal was already sent, cancelled or never prepared. ${NOTHING_SENT} Check History before starting a new one.`);
  }
  if (found.kind === "expired") {
    return refused("proposal_expired", `This withdrawal approval expired. ${NOTHING_SENT} Review the withdrawal again.`);
  }
  const entry = found.entry;
  const { proposal } = entry;
  if (!echoMatches(proposal, input)) {
    approved.drop(proposal.proposalId);
    return refused("proposal_changed", `The amount or destination differs from the withdrawal you reviewed. ${NOTHING_SENT} Review it again.`);
  }
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  if (!isEligible(read.value, deps.localWallets(), proposal.destination)) {
    approved.drop(proposal.proposalId);
    return refused("destination_not_linked", `That wallet is no longer both linked and in this app. ${NOTHING_SENT}`);
  }
  // The approval's deadline, AGAIN, after the account read and right before
  // the POST: a card that lapsed while the read ran is not an approval.
  if (deps.now().getTime() >= entry.expiresAtMs) {
    approved.drop(proposal.proposalId);
    return refused("proposal_expired", `This withdrawal approval expired before it was sent. ${NOTHING_SENT} Review the withdrawal again.`);
  }
  if (signal.aborted) return refused("cancelled", `Cancelled. ${NOTHING_SENT}`);

  // THE SEND. From here the withdrawal may exist on Vex Cloud, so the entry
  // moves to `unresolved` BEFORE the request leaves: whatever happens next,
  // its key survives until a definitive answer.
  approved.drop(proposal.proposalId);
  const kept: WithdrawalEntry = { ...entry, expiresAtMs: deps.now().getTime() + UNRESOLVED_WITHDRAWAL_RETENTION_MS };
  unresolved.adopt(kept, deps.now().getTime());
  return post(deps, kept, bearer.value, signal);
}

/** "Check status": the SAME key and body as the request already sent. Not a new approval, so no expiry or local gate. */
async function replay(
  deps: WithdrawDeps,
  entry: WithdrawalEntry,
  input: VexCloudSubmitWithdrawalInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudSubmitWithdrawalResult>> {
  if (!echoMatches(entry.proposal, input)) {
    // Never drop here: the key may already name a withdrawal.
    return refused("proposal_changed", "The amount or destination differs from the withdrawal that was sent. Check its status from the withdrawal itself.");
  }
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  return post(deps, entry, bearer.value, signal);
}

async function post(
  deps: WithdrawDeps,
  entry: WithdrawalEntry,
  bearer: string,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudSubmitWithdrawalResult>> {
  const { proposal, idempotencyKey } = entry;
  const created = await deps.api.createWithdrawal(
    bearer,
    idempotencyKey,
    { amountWei: proposal.amountWei, destination: proposal.destination },
    signal,
  );
  if (created.ok) {
    unresolved.drop(proposal.proposalId);
    return { ok: true, value: { outcome: "accepted", withdrawal: toWithdrawal(created.value) } };
  }
  if (isDefinitiveRefusal(created.failure)) {
    unresolved.drop(proposal.proposalId);
    return backendRefusal(deps, created.failure);
  }
  // Not a proven refusal: the withdrawal may exist. Keep the key for "Check status".
  return {
    ok: true,
    value: {
      outcome: "unknown",
      proposalId: proposal.proposalId,
      amountWei: proposal.amountWei,
      destination: proposal.destination,
    },
  };
}

function echoMatches(proposal: VexCloudWithdrawalProposal, input: VexCloudSubmitWithdrawalInput): boolean {
  return input.destination.toLowerCase() === proposal.destination.toLowerCase() && input.amountWei === proposal.amountWei;
}

export async function readWithdrawalStatus(
  deps: WithdrawDeps,
  withdrawalId: string,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudWithdrawalStatusResult>> {
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readWithdrawal(bearer.value, withdrawalId, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  return { ok: true, value: { withdrawal: toWithdrawal(read.value) } };
}
