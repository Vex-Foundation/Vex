/**
 * THE AUTO TOP-UP RULE OWNER for the funding page: create, edit, pause,
 * resume and revoke, each under "the form is the approval".
 *
 * `prepare` reads everything fresh (session, account, linked wallets, the
 * pinned deposit address against the backend's, the minimum at the current
 * rate, the current rule and its version) and mints a single-use proposal
 * carrying every bound the rule will hold. `submit` consumes it, compares the
 * echoed action and bounds field by field, re-reads the account (the wallet
 * must still be linked and in the inventory, the pin still equal) and applies
 * the change to durable state with a compare-and-set on the reviewed version.
 *
 * | Bound | Set by | Checked at prepare | Re-checked at submit |
 * |---|---|---|---|
 * | source wallet | the user (inventory and linked only) | inventory, linked | inventory, linked (fresh account read) |
 * | VEX per top-up | the user (text, parsed here) | at least the minimum at the current rate | echo |
 * | max per day | the user, 1 to 24 | bounds | echo |
 * | 30-day cap | the user (text), at least one top-up | bounds | echo |
 * | expiry | the user, at most 90 days | bounds | echo; DB check against the approval time |
 * | trigger | constant `below_alert_percent` | | echo |
 * | destination | constant: the pinned deposit address | equal to the backend's | equal to the backend's |
 * | rule version | the stored rule | read | compare-and-set |
 *
 * AUDIT: one `asked` line when a submit starts and exactly one `decided`.
 */

import { getAddress } from "viem";
import type {
  VexCloudAutoTopUpBounds,
  VexCloudAutoTopUpGetResult,
  VexCloudAutoTopUpProposal,
  VexCloudAutoTopUpRule,
  VexCloudPrepareAutoTopUpInput,
  VexCloudSubmitAutoTopUpInput,
  VexCloudSubmitAutoTopUpResult,
} from "@shared/schemas/vex-cloud-auto-top-up.js";
import {
  parseVexAmountText,
  VEX_CLOUD_CHAIN_ID,
  VEX_DECIMALS,
  VEX_SYMBOL,
  VEX_TOKEN_ADDRESS,
  weiToMicroUsdFloor,
} from "@shared/vex-cloud-money.js";
import type { WalletInventoryEntry } from "@vex-lib/wallet.js";
import { log } from "../../logger/index.js";
import type { VexCloudAccountResponse, VexCloudApi } from "../api-client.js";
import { refused, type VexCloudOutcome } from "../outcome.js";
import { backendRefusal, requireBearer, type SessionPort } from "../funding/backend-call.js";
import { findWallet, isLinkedTo, minimumOf, pinRefusal, SENDER_NOT_LINKED_DETAIL } from "../funding/deposit-core.js";
import { ProposalStore, type StoredProposal } from "../funding/proposal-store.js";
import type { AutoTopUpRuleRow, FundingPolicyStore } from "./funding-store.js";
import { effectiveRuleState, validateRuleBounds, type RuleConditions } from "./rule-policy.js";

export const RULE_PROPOSAL_TTL_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RuleOwnerDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount">;
  readonly store: FundingPolicyStore;
  readonly listEvmWallets: () => readonly WalletInventoryEntry[];
  readonly pinnedDepositAddress: () => string | null;
  readonly conditions: () => Omit<RuleConditions, "depositAddressMatches" | "balanceReadFailing">;
  readonly balanceReadFailing: () => boolean;
  readonly now: () => Date;
  readonly newRuleId: () => string;
}

interface RuleProposalEntry extends StoredProposal {
  readonly proposal: VexCloudAutoTopUpProposal;
  readonly accountId: string;
}

let proposals = new ProposalStore<RuleProposalEntry>();

/** Test-only. */
export function __resetRuleProposalsForTests(): void {
  proposals = new ProposalStore<RuleProposalEntry>();
}

const NOTHING_CHANGED = "Nothing was changed.";

async function readSignedInAccount(deps: RuleOwnerDeps, signal: AbortSignal): Promise<VexCloudOutcome<VexCloudAccountResponse>> {
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return bearer;
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) return backendRefusal(deps, read.failure);
  return { ok: true, value: read.value };
}

/** The rule as the funding page shows it, with the derived plan 4.4 state. */
export async function ruleView(deps: Pick<RuleOwnerDeps, "store" | "conditions" | "now" | "balanceReadFailing">, rule: AutoTopUpRuleRow, depositAddressMatches: boolean | null): Promise<VexCloudAutoTopUpRule> {
  const now = deps.now();
  const usage = await deps.store.readRuleUsage(rule.ruleId, now);
  const state = effectiveRuleState(rule, usage, {
    ...deps.conditions(),
    depositAddressMatches,
    balanceReadFailing: deps.balanceReadFailing(),
  });
  const executions = await deps.store.listRuleExecutions(rule.ruleId, 10);
  return {
    ruleId: rule.ruleId,
    version: rule.version,
    state: state.state,
    suspendedReason: state.state === "suspended" ? state.reason : null,
    sourceWallet: getAddress(rule.sourceWallet),
    amountWei: rule.amountWei.toString(),
    maxPerDay: rule.maxPerDay,
    monthlyCapWei: rule.monthlyCapWei.toString(),
    trigger: rule.triggerKind,
    expiresAt: rule.expiresAt.toISOString(),
    approvedAt: rule.approvedAt.toISOString(),
    usedLast24Hours: usage.countLastDay,
    usedLast30DaysWei: usage.sumLast30DaysWei.toString(),
    recentExecutions: executions.flatMap((row) =>
      row.authority !== "auto_top_up_poller" && row.authority !== "auto_top_up_agent"
        ? []
        : [{
        executionId: row.executionId,
        authority: row.authority,
        amountWei: row.amountWei.toString(),
        status: row.status,
        refusalKind: row.refusalKind,
        txHash: row.txHash,
        askedAt: row.askedAt.toISOString(),
        decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
      }]),
  };
}

export async function readAutoTopUp(deps: RuleOwnerDeps, signal: AbortSignal): Promise<VexCloudOutcome<VexCloudAutoTopUpGetResult>> {
  const account = await readSignedInAccount(deps, signal);
  if (!account.ok) return account;
  const rule = await deps.store.readLiveRule(account.value.account_id);
  if (rule === null) return { ok: true, value: { rule: null } };
  const pinned = deps.pinnedDepositAddress();
  return { ok: true, value: { rule: await ruleView(deps, rule, pinRefusal(pinned, account.value.deposit_address) === null) } };
}

function parseAmount(text: string, what: string): VexCloudOutcome<bigint> {
  const parsed = parseVexAmountText(text);
  if (!parsed.ok) return refused("invalid_rule", `Enter the ${what} as VEX digits with at most one point and 18 decimals, above zero.`);
  return { ok: true, value: parsed.wei };
}

export async function prepareAutoTopUp(
  deps: RuleOwnerDeps,
  input: VexCloudPrepareAutoTopUpInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudAutoTopUpProposal>> {
  const pinned = deps.pinnedDepositAddress();
  const account = await readSignedInAccount(deps, signal);
  if (!account.ok) return account;
  const mismatch = pinRefusal(pinned, account.value.deposit_address);
  if (mismatch !== null) return mismatch;
  if (pinned === null) return refused("deposits_not_open", `Deposits are not open in this version of Vex. ${NOTHING_CHANGED}`);
  const minimum = minimumOf(account.value);
  if (!minimum.ok) return minimum;
  const alertPercent = await deps.store.readAlertPercent();
  const current = await deps.store.readLiveRule(account.value.account_id);
  const now = deps.now();

  let ruleId: string | null = null;
  let expectedVersion: number | null = null;
  let bounds: VexCloudAutoTopUpBounds;
  if (input.action === "create" || input.action === "edit") {
    if (input.action === "create" && current !== null) {
      return refused("rule_exists", `An auto top-up rule already exists for this account. Edit, pause or revoke it instead. ${NOTHING_CHANGED}`);
    }
    if (input.action === "edit") {
      if (current === null || current.ruleId !== input.ruleId || current.version !== input.expectedVersion) {
        return refused("rule_changed", `The rule changed since this page showed it. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
      }
      ruleId = current.ruleId;
      expectedVersion = current.version;
    }
    const entry = findWallet(deps, input.fields.sourceWallet);
    if (entry === undefined) return refused("wallet_not_in_inventory", `That wallet is not one of the EVM wallets in this app. ${NOTHING_CHANGED}`);
    if (!isLinkedTo(account.value, entry.address)) return refused("sender_not_linked", SENDER_NOT_LINKED_DETAIL);
    const amount = parseAmount(input.fields.amountText, "amount per top-up");
    if (!amount.ok) return amount;
    const cap = parseAmount(input.fields.monthlyCapText, "30-day cap");
    if (!cap.ok) return cap;
    const expiresAt = new Date(now.getTime() + input.fields.expiresInDays * DAY_MS);
    const verdict = validateRuleBounds(
      { sourceWallet: entry.address, amountWei: amount.value, maxPerDay: input.fields.maxPerDay, monthlyCapWei: cap.value, expiresAt },
      { now, minimumWei: minimum.value.minimumWei },
    );
    if (!verdict.ok) return refused("invalid_rule", `${verdict.detail} ${NOTHING_CHANGED}`);
    bounds = {
      sourceWallet: getAddress(entry.address),
      amountWei: amount.value.toString(),
      maxPerDay: input.fields.maxPerDay,
      monthlyCapWei: cap.value.toString(),
      trigger: "below_alert_percent",
      alertPercent,
      expiresAt: expiresAt.toISOString(),
    };
  } else {
    if (current === null || current.ruleId !== input.ruleId || current.version !== input.expectedVersion) {
      return refused("rule_changed", `The rule changed since this page showed it. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
    }
    if (input.action === "pause" && current.status !== "active") return refused("rule_not_active", `The rule is not active, so it cannot be paused. ${NOTHING_CHANGED}`);
    if (input.action === "resume" && current.status !== "paused") return refused("rule_not_active", `The rule is not paused, so it cannot be resumed. ${NOTHING_CHANGED}`);
    if (input.action === "resume" && current.expiresAt.getTime() <= now.getTime()) return refused("rule_not_active", `The rule has expired; create a new one. ${NOTHING_CHANGED}`);
    ruleId = current.ruleId;
    expectedVersion = current.version;
    bounds = {
      sourceWallet: getAddress(current.sourceWallet),
      amountWei: current.amountWei.toString(),
      maxPerDay: current.maxPerDay,
      monthlyCapWei: current.monthlyCapWei.toString(),
      trigger: "below_alert_percent",
      alertPercent,
      expiresAt: current.expiresAt.toISOString(),
    };
  }

  const rateX18 = minimum.value.rateX18;
  const minted = proposals.mint(now.getTime(), (proposalId) => ({
    proposalId,
    expiresAtMs: now.getTime() + RULE_PROPOSAL_TTL_MS,
    accountId: account.value.account_id,
    proposal: {
      proposalId,
      action: input.action,
      ruleId,
      expectedVersion,
      actor: "user",
      chainId: VEX_CLOUD_CHAIN_ID,
      token: { address: VEX_TOKEN_ADDRESS, symbol: VEX_SYMBOL, decimals: VEX_DECIMALS },
      depositAddress: getAddress(pinned),
      bounds,
      amountUsdMicroEstimate: weiToMicroUsdFloor(BigInt(bounds.amountWei), rateX18).toString(),
      monthlyCapUsdMicroEstimate: weiToMicroUsdFloor(BigInt(bounds.monthlyCapWei), rateX18).toString(),
      minimumWei: minimum.value.minimumWei.toString(),
      minimumMicroUsd: minimum.value.minimumMicroUsd.toString(),
      preparedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RULE_PROPOSAL_TTL_MS).toISOString(),
    },
  }));
  return { ok: true, value: minted.proposal };
}

function boundsEqual(a: VexCloudAutoTopUpBounds, b: VexCloudAutoTopUpBounds): boolean {
  return (
    a.sourceWallet.toLowerCase() === b.sourceWallet.toLowerCase()
    && a.amountWei === b.amountWei
    && a.maxPerDay === b.maxPerDay
    && a.monthlyCapWei === b.monthlyCapWei
    && a.trigger === b.trigger
    && a.alertPercent === b.alertPercent
    && a.expiresAt === b.expiresAt
  );
}

export async function submitAutoTopUp(
  deps: RuleOwnerDeps,
  input: VexCloudSubmitAutoTopUpInput,
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<VexCloudSubmitAutoTopUpResult>> {
  log.info(`[vex-cloud:auto-top-up] rule asked action=${input.action} correlationId=${correlationId}`);
  let decided = "refused";
  try {
    const outcome = await runSubmit(deps, input, signal);
    decided = outcome.ok ? `applied:${outcome.value.rule.state}` : `refused:${outcome.refusal.kind}`;
    return outcome;
  } finally {
    log.info(`[vex-cloud:auto-top-up] rule decided outcome=${decided} correlationId=${correlationId}`);
  }
}

async function runSubmit(
  deps: RuleOwnerDeps,
  input: VexCloudSubmitAutoTopUpInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudSubmitAutoTopUpResult>> {
  const now = deps.now();
  const found = proposals.consume(input.proposalId, now.getTime());
  if (found.kind === "missing") return refused("proposal_missing", `This change was already applied, cancelled or never prepared. ${NOTHING_CHANGED}`);
  if (found.kind === "expired") return refused("proposal_expired", `This approval expired. ${NOTHING_CHANGED} Review the change again.`);
  const { proposal, accountId } = found.entry;
  if (proposal.action !== input.action || !boundsEqual(proposal.bounds, input.bounds)) {
    return refused("proposal_changed", `The change differs from the one you reviewed. ${NOTHING_CHANGED} Review it again.`);
  }

  // Revalidate at commit: the same account, the wallet still linked and in the app, the pin still equal.
  const account = await readSignedInAccount(deps, signal);
  if (!account.ok) return account;
  if (account.value.account_id !== accountId) {
    return refused("account_changed", `You are signed in to a different Vex Inference account than the one this change was reviewed under. ${NOTHING_CHANGED}`);
  }
  const mismatch = pinRefusal(deps.pinnedDepositAddress(), account.value.deposit_address);
  if (mismatch !== null) return mismatch;
  if (proposal.depositAddress.toLowerCase() !== (deps.pinnedDepositAddress() ?? "").toLowerCase()) {
    return refused("deposit_address_mismatch", `The deposit address built into Vex changed after this change was reviewed. ${NOTHING_CHANGED}`);
  }
  if (input.action === "create" || input.action === "edit" || input.action === "resume") {
    if (findWallet(deps, proposal.bounds.sourceWallet) === undefined) {
      return refused("wallet_not_in_inventory", `That wallet is no longer in this app. ${NOTHING_CHANGED}`);
    }
    if (!isLinkedTo(account.value, proposal.bounds.sourceWallet)) return refused("sender_not_linked", SENDER_NOT_LINKED_DETAIL);
  }
  if (signal.aborted) return refused("cancelled", `Cancelled. ${NOTHING_CHANGED}`);

  const bounds = {
    sourceWallet: proposal.bounds.sourceWallet,
    amountWei: BigInt(proposal.bounds.amountWei),
    maxPerDay: proposal.bounds.maxPerDay,
    monthlyCapWei: BigInt(proposal.bounds.monthlyCapWei),
    expiresAt: new Date(proposal.bounds.expiresAt),
  };
  const ref = proposal.ruleId !== null && proposal.expectedVersion !== null
    ? { ruleId: proposal.ruleId, expectedVersion: proposal.expectedVersion }
    : null;
  if (proposal.action !== "create" && ref === null) {
    return refused("rule_changed", `This change names no rule. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
  }
  let row: AutoTopUpRuleRow | null = null;
  if (proposal.action === "create") {
    try {
      row = await deps.store.insertRule({ ruleId: deps.newRuleId(), accountId, ...bounds, approvedAt: now });
    } catch (cause) {
      if ((cause as { code?: unknown }).code === "23505") return refused("rule_exists", `An auto top-up rule already exists for this account. ${NOTHING_CHANGED}`);
      throw cause;
    }
  } else if (ref !== null) {
    switch (proposal.action) {
      case "edit":
        row = await deps.store.editRule({ ...ref, ...bounds, approvedAt: now });
        break;
      case "pause":
        row = await deps.store.setRuleStatus({ ...ref, from: ["active"], to: "paused" });
        break;
      case "resume":
        row = await deps.store.setRuleStatus({ ...ref, from: ["paused"], to: "active" });
        break;
      case "revoke":
        row = await deps.store.setRuleStatus({ ...ref, from: ["active", "paused"], to: "revoked" });
        break;
    }
  }
  if (row === null) return refused("rule_changed", `The rule changed before this change was applied. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
  return { ok: true, value: { rule: await ruleView(deps, row, true) } };
}
