/**
 * THE AUTO TOP-UP RULE OWNER for the funding page: create, edit, pause,
 * resume and revoke, each under "the form is the approval".
 *
 * TWO KINDS OF CHANGE, two sets of prerequisites:
 *
 * | Action | Enables spending | Prepare reads | Submit re-checks |
 * |---|---|---|---|
 * | create, edit, resume | yes | session, account, linked wallets, pin equals the backend's, the minimum at the current rate, the stored rule and its version | account (same id), pin, wallet in the app and linked; version compare-and-set |
 * | pause, revoke | no | the STORED rule only (status, version, its account binding) | the stored rule's account binding and version compare-and-set |
 *
 * Stopping spending never waits on the backend: a pause or revoke needs no
 * session, account read, rate or pin, so it works while Vex Inference is
 * unreachable or has no price.
 *
 * `prepare` mints a single-use proposal carrying every bound the rule will
 * hold. `submit` consumes it, compares the echoed action and bounds field by
 * field, re-checks the table above and applies the change to durable state
 * with a compare-and-set on the reviewed version. Every change runs inside
 * {@link withRuleAuthorityChange}, which withdraws the authority of any
 * top-up already in flight under the old rule (`rule-authority.ts`).
 *
 * | Bound | Set by | Checked at prepare | Re-checked at submit |
 * |---|---|---|---|
 * | source wallet | the user (inventory and linked only) | inventory, linked | inventory, linked (fresh account read) |
 * | VEX per top-up | the user (text, parsed here) | at least the minimum at the current rate | echo |
 * | max per day | the user, 1 to 24 | bounds | echo |
 * | 30-day cap | the user (text), at least one top-up | bounds | echo |
 * | network fee ceiling per top-up | the user (ETH text, default measured), above zero, at most 0.01 ETH | bounds | echo |
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
import { withRuleAuthorityChange } from "./rule-authority.js";
import { effectiveRuleState, validateRuleBounds, type ObservedRuleConditions, type RuleConditions } from "./rule-policy.js";

export const RULE_PROPOSAL_TTL_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RuleOwnerDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount">;
  readonly store: FundingPolicyStore;
  readonly listEvmWallets: () => readonly WalletInventoryEntry[];
  readonly pinnedDepositAddress: () => string | null;
  readonly conditions: () => Omit<RuleConditions, ObservedRuleConditions>;
  readonly balanceReadFailing: () => boolean;
  /** Whether the poller's last attempt for this rule version was refused for its network fee. */
  readonly networkFeeAboveLimit: (rule: { readonly ruleId: string; readonly version: number }) => boolean;
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
export async function ruleView(
  deps: Pick<RuleOwnerDeps, "store" | "conditions" | "now" | "balanceReadFailing" | "networkFeeAboveLimit">,
  rule: AutoTopUpRuleRow,
  depositAddressMatches: boolean | null,
): Promise<VexCloudAutoTopUpRule> {
  const now = deps.now();
  const usage = await deps.store.readRuleUsage(rule.ruleId, now);
  const state = effectiveRuleState(rule, usage, {
    ...deps.conditions(),
    depositAddressMatches,
    balanceReadFailing: deps.balanceReadFailing(),
    networkFeeAboveLimit: deps.networkFeeAboveLimit(rule),
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
    maxNetworkFeeWei: rule.maxNetworkFeeWei === null ? null : rule.maxNetworkFeeWei.toString(),
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

/**
 * The account's live rule. When the backend cannot be read, the rule of the
 * account this process last read successfully is still shown (its state
 * reads "Balance cannot be read"), so the user can always pause or revoke
 * it; with no such account the backend's refusal stands.
 */
export async function readAutoTopUp(deps: RuleOwnerDeps, signal: AbortSignal): Promise<VexCloudOutcome<VexCloudAutoTopUpGetResult>> {
  const account = await readSignedInAccount(deps, signal);
  if (!account.ok) {
    const known = deps.conditions().signedInAccountId;
    if (known === null || account.refusal.kind === "not_signed_in" || account.refusal.kind === "cancelled") return account;
    const local = await deps.store.readLiveRule(known);
    return { ok: true, value: { rule: local === null ? null : await ruleView(deps, local, null) } };
  }
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
  if (input.action === "pause" || input.action === "revoke") return prepareStop(deps, input);
  return prepareSpending(deps, input, signal);
}

/** Pause and revoke: from the stored rule alone. No session, no account read, no rate, no pin. */
async function prepareStop(
  deps: RuleOwnerDeps,
  input: Extract<VexCloudPrepareAutoTopUpInput, { action: "pause" | "revoke" }>,
): Promise<VexCloudOutcome<VexCloudAutoTopUpProposal>> {
  const current = await deps.store.readRule(input.ruleId);
  if (current === null || current.version !== input.expectedVersion || (current.status !== "active" && current.status !== "paused")) {
    return refused("rule_changed", `The rule changed since this page showed it. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
  }
  if (input.action === "pause" && current.status !== "active") return refused("rule_not_active", `The rule is not active, so it cannot be paused. ${NOTHING_CHANGED}`);
  const pinned = deps.pinnedDepositAddress();
  if (pinned === null) return refused("deposits_not_open", `Deposits are not open in this version of Vex. ${NOTHING_CHANGED}`);
  return { ok: true, value: mintProposal(deps, input.action, current, current.accountId, storedBounds(current, await deps.store.readAlertPercent()), pinned, null) };
}

function storedBounds(rule: AutoTopUpRuleRow, alertPercent: number): VexCloudAutoTopUpBounds {
  return {
    sourceWallet: getAddress(rule.sourceWallet),
    amountWei: rule.amountWei.toString(),
    maxPerDay: rule.maxPerDay,
    monthlyCapWei: rule.monthlyCapWei.toString(),
    maxNetworkFeeWei: rule.maxNetworkFeeWei === null ? null : rule.maxNetworkFeeWei.toString(),
    trigger: "below_alert_percent",
    alertPercent,
    expiresAt: rule.expiresAt.toISOString(),
  };
}

function mintProposal(
  deps: RuleOwnerDeps,
  action: VexCloudAutoTopUpProposal["action"],
  current: AutoTopUpRuleRow | null,
  accountId: string,
  bounds: VexCloudAutoTopUpBounds,
  pinned: string,
  minimum: { readonly rateX18: bigint; readonly minimumWei: bigint; readonly minimumMicroUsd: bigint } | null,
): VexCloudAutoTopUpProposal {
  const now = deps.now();
  const rateX18 = minimum?.rateX18 ?? null;
  const minted = proposals.mint(now.getTime(), (proposalId) => ({
    proposalId,
    expiresAtMs: now.getTime() + RULE_PROPOSAL_TTL_MS,
    accountId,
    proposal: {
      proposalId,
      action,
      ruleId: current?.ruleId ?? null,
      expectedVersion: current?.version ?? null,
      actor: "user",
      chainId: VEX_CLOUD_CHAIN_ID,
      token: { address: VEX_TOKEN_ADDRESS, symbol: VEX_SYMBOL, decimals: VEX_DECIMALS },
      depositAddress: getAddress(pinned),
      bounds,
      amountUsdMicroEstimate: rateX18 === null ? null : weiToMicroUsdFloor(BigInt(bounds.amountWei), rateX18).toString(),
      monthlyCapUsdMicroEstimate: rateX18 === null ? null : weiToMicroUsdFloor(BigInt(bounds.monthlyCapWei), rateX18).toString(),
      minimumWei: minimum === null ? null : minimum.minimumWei.toString(),
      minimumMicroUsd: minimum === null ? null : minimum.minimumMicroUsd.toString(),
      preparedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RULE_PROPOSAL_TTL_MS).toISOString(),
    },
  }));
  return minted.proposal;
}

/** ETH has 18 decimals like VEX: the same exact text parser applies. */
function parseNetworkFee(text: string): VexCloudOutcome<bigint> {
  const parsed = parseVexAmountText(text);
  if (!parsed.ok) return refused("invalid_rule", `Enter the network fee limit as ETH digits with at most one point and 18 decimals, above zero. ${NOTHING_CHANGED}`);
  return { ok: true, value: parsed.wei };
}

/** Create, edit and resume: every funding prerequisite, read fresh. */
async function prepareSpending(
  deps: RuleOwnerDeps,
  input: Extract<VexCloudPrepareAutoTopUpInput, { action: "create" | "edit" | "resume" }>,
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

  let bounds: VexCloudAutoTopUpBounds;
  if (input.action === "create" || input.action === "edit") {
    if (input.action === "create" && current !== null) {
      return refused("rule_exists", `An auto top-up rule already exists for this account. Edit, pause or revoke it instead. ${NOTHING_CHANGED}`);
    }
    if (input.action === "edit" && (current === null || current.ruleId !== input.ruleId || current.version !== input.expectedVersion)) {
      return refused("rule_changed", `The rule changed since this page showed it. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
    }
    const entry = findWallet(deps, input.fields.sourceWallet);
    if (entry === undefined) return refused("wallet_not_in_inventory", `That wallet is not one of the EVM wallets in this app. ${NOTHING_CHANGED}`);
    if (!isLinkedTo(account.value, entry.address)) return refused("sender_not_linked", SENDER_NOT_LINKED_DETAIL);
    const amount = parseAmount(input.fields.amountText, "amount per top-up");
    if (!amount.ok) return amount;
    const cap = parseAmount(input.fields.monthlyCapText, "30-day cap");
    if (!cap.ok) return cap;
    const fee = parseNetworkFee(input.fields.maxNetworkFeeText);
    if (!fee.ok) return fee;
    const expiresAt = new Date(now.getTime() + input.fields.expiresInDays * DAY_MS);
    const verdict = validateRuleBounds(
      { sourceWallet: entry.address, amountWei: amount.value, maxPerDay: input.fields.maxPerDay, monthlyCapWei: cap.value, maxNetworkFeeWei: fee.value, expiresAt },
      { now, minimumWei: minimum.value.minimumWei },
    );
    if (!verdict.ok) return refused("invalid_rule", `${verdict.detail} ${NOTHING_CHANGED}`);
    bounds = {
      sourceWallet: getAddress(entry.address),
      amountWei: amount.value.toString(),
      maxPerDay: input.fields.maxPerDay,
      monthlyCapWei: cap.value.toString(),
      maxNetworkFeeWei: fee.value.toString(),
      trigger: "below_alert_percent",
      alertPercent,
      expiresAt: expiresAt.toISOString(),
    };
  } else {
    if (current === null || current.ruleId !== input.ruleId || current.version !== input.expectedVersion) {
      return refused("rule_changed", `The rule changed since this page showed it. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
    }
    if (current.status !== "paused") return refused("rule_not_active", `The rule is not paused, so it cannot be resumed. ${NOTHING_CHANGED}`);
    if (current.expiresAt.getTime() <= now.getTime()) return refused("rule_not_active", `The rule has expired; create a new one. ${NOTHING_CHANGED}`);
    if (current.maxNetworkFeeWei === null) {
      return refused("invalid_rule", `This rule has no network fee limit. Edit it to set one, which also resumes it. ${NOTHING_CHANGED}`);
    }
    bounds = storedBounds(current, alertPercent);
  }
  return { ok: true, value: mintProposal(deps, input.action, input.action === "create" ? null : current, account.value.account_id, bounds, pinned, minimum.value) };
}

function boundsEqual(a: VexCloudAutoTopUpBounds, b: VexCloudAutoTopUpBounds): boolean {
  return (
    a.sourceWallet.toLowerCase() === b.sourceWallet.toLowerCase()
    && a.amountWei === b.amountWei
    && a.maxPerDay === b.maxPerDay
    && a.monthlyCapWei === b.monthlyCapWei
    && a.maxNetworkFeeWei === b.maxNetworkFeeWei
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

  const ref = proposal.ruleId !== null && proposal.expectedVersion !== null
    ? { ruleId: proposal.ruleId, expectedVersion: proposal.expectedVersion }
    : null;
  if (proposal.action !== "create" && ref === null) {
    return refused("rule_changed", `This change names no rule. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
  }

  if (proposal.action === "pause" || proposal.action === "revoke") {
    // Stopping spending: the stored rule's account binding and the reviewed version, nothing remote.
    if (ref === null) return refused("rule_changed", `This change names no rule. ${NOTHING_CHANGED}`);
    const stored = await deps.store.readRule(ref.ruleId);
    if (stored === null || stored.accountId !== accountId) {
      return refused("rule_changed", `The rule changed before this change was applied. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
    }
    if (signal.aborted) return refused("cancelled", `Cancelled. ${NOTHING_CHANGED}`);
    const row = await withRuleAuthorityChange(ref.ruleId, () => proposal.action === "pause"
      ? deps.store.setRuleStatus({ ...ref, from: ["active"], to: "paused" })
      : deps.store.setRuleStatus({ ...ref, from: ["active", "paused"], to: "revoked" }));
    if (row === null) return refused("rule_changed", `The rule changed before this change was applied. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
    return { ok: true, value: { rule: await ruleView(deps, row, null) } };
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
  if (findWallet(deps, proposal.bounds.sourceWallet) === undefined) {
    return refused("wallet_not_in_inventory", `That wallet is no longer in this app. ${NOTHING_CHANGED}`);
  }
  if (!isLinkedTo(account.value, proposal.bounds.sourceWallet)) return refused("sender_not_linked", SENDER_NOT_LINKED_DETAIL);
  if (signal.aborted) return refused("cancelled", `Cancelled. ${NOTHING_CHANGED}`);

  const fee = proposal.bounds.maxNetworkFeeWei;
  if (fee === null) return refused("invalid_rule", `This change carries no network fee limit. ${NOTHING_CHANGED} Edit the rule to set one.`);
  const bounds = {
    sourceWallet: proposal.bounds.sourceWallet,
    amountWei: BigInt(proposal.bounds.amountWei),
    maxPerDay: proposal.bounds.maxPerDay,
    monthlyCapWei: BigInt(proposal.bounds.monthlyCapWei),
    maxNetworkFeeWei: BigInt(fee),
    expiresAt: new Date(proposal.bounds.expiresAt),
  };
  let row: AutoTopUpRuleRow | null = null;
  if (proposal.action === "create") {
    try {
      row = await deps.store.insertRule({ ruleId: deps.newRuleId(), accountId, ...bounds, approvedAt: now });
    } catch (cause) {
      if ((cause as { code?: unknown }).code === "23505") return refused("rule_exists", `An auto top-up rule already exists for this account. ${NOTHING_CHANGED}`);
      throw cause;
    }
  } else if (ref !== null) {
    row = proposal.action === "edit"
      ? await withRuleAuthorityChange(ref.ruleId, () => deps.store.editRule({ ...ref, ...bounds, approvedAt: now }))
      : await withRuleAuthorityChange(ref.ruleId, () => deps.store.setRuleStatus({ ...ref, from: ["paused"], to: "active" }));
  }
  if (row === null) return refused("rule_changed", `The rule changed before this change was applied. ${NOTHING_CHANGED} Reload the Auto top-up tab.`);
  return { ok: true, value: { rule: await ruleView(deps, row, true) } };
}
