/**
 * The AGENT deposit owner behind `VexInferenceDepositPrepare` /
 * `VexInferenceDepositConfirm` (the engine host seam,
 * `src/vex-agent/tools/internal/vex-inference/host.ts`).
 *
 * WHAT THE MODEL CAN REACH. The engine passes the amount, the session's
 * selected EVM wallet (already scoped by the mission wallet policy) and the
 * session id. Nothing else. The destination is the pinned deposit address,
 * the chain 4663, the token VEX: all fixed by the shared deposit core.
 *
 * THE INTENT. Prepare runs the core's fresh reads and mints a single-use
 * intent bound to the session, valid 10 minutes (the wallet-send intent
 * TTL: long enough for a human to read the card). The card shows the intent
 * whole. Confirm consumes it only when it executes; a `needs_user_approval`
 * answer leaves it for the approved resume.
 *
 * AUTHORITY (decided here, from durable state for the rule):
 *
 * | Runtime authority | Rule | Result | Execution row |
 * |---|---|---|---|
 * | `approved_card` | ignored | executes | `agent_card` |
 * | `full_permission` | ignored | executes | `agent_full_permission` |
 * | `none` | active and covering (wallet, amount, caps, network fee ceiling) | executes under the rule, caps shared with the poller | `auto_top_up_agent` |
 * | `none` | absent or not covering | `needs_user_approval`, intent kept | none |
 *
 * `approved_card` arrives only after the engine proved the approval is bound
 * to this intent's complete card (`approval-binding.ts` in the agent tools);
 * a rejected card retires the intent ({@link retireAgentDeposit}).
 *
 * At the signing boundary the core re-checks every bound field, the executor
 * re-checks the rule from durable state, and the final check re-asks the
 * engine whether the source wallet is still in the session's scope.
 */

import type {
  AgentDepositConfirmRequest,
  AgentDepositConfirmResult,
  AgentDepositIntentView,
  AgentDepositPrepareRequest,
  HostOutcome,
} from "@vex-agent/tools/internal/vex-inference/host.js";
import {
  microUsdToWeiCeil,
  parseVexAmountText,
  VEX_CLOUD_CHAIN_ID,
  VEX_TOKEN_ADDRESS,
} from "@shared/vex-cloud-money.js";
import type { StagedFeeExposureLimit } from "@tools/evm-chains/staged-broadcast.js";
import { refused, type VexCloudOutcome } from "../outcome.js";
import { backendRefusal, requireBearer } from "./backend-call.js";
import { minimumOf, planDeposit, type DepositDeps } from "./deposit-core.js";
import { ProposalStore, type StoredProposal } from "./proposal-store.js";
import { executeRecordedDeposit, type RecordedExecutionDeps } from "../auto-top-up/executor.js";
import { ruleCoversAgentDeposit } from "../auto-top-up/rule-policy.js";
import { vexAmountView } from "../vex-inference-amounts.js";

/** The wallet-send intent TTL: long enough for a human to read and approve the card. */
export const AGENT_DEPOSIT_TTL_MS = 10 * 60_000;

interface AgentIntentEntry extends StoredProposal {
  readonly sessionId: string;
  readonly accountId: string;
  readonly view: AgentDepositIntentView;
  readonly feeBound: StagedFeeExposureLimit;
}

let intents = new ProposalStore<AgentIntentEntry>();

/** Test-only. */
export function __resetAgentDepositsForTests(): void {
  intents = new ProposalStore<AgentIntentEntry>();
}

export interface AgentDepositDeps extends RecordedExecutionDeps {
  readonly deposit: DepositDeps;
}

function toHost<T>(outcome: VexCloudOutcome<T>): HostOutcome<T> {
  return outcome.ok ? outcome : { ok: false, refusal: { kind: outcome.refusal.kind, detail: outcome.refusal.detail } };
}

/** Exact micro-USD from a decimal dollar string with at most 6 decimals. */
function parseUsdMicro(text: string): bigint | null {
  const match = /^([0-9]{1,12})(?:\.([0-9]{1,6}))?$/.exec(text);
  if (match === null) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return whole * 1_000_000n + fraction;
}

async function coverage(
  deps: AgentDepositDeps,
  accountId: string,
  from: string,
  amountWei: bigint,
  maxNetworkFeeWei: bigint,
  depositAddressMatches: boolean,
): Promise<AgentDepositIntentView["autoTopUp"]> {
  let rule;
  try {
    rule = await deps.store.readLiveRule(accountId);
  } catch {
    return { covered: false, reason: "the auto top-up rule could not be read" };
  }
  if (rule === null) return { covered: false, reason: "no auto top-up rule exists" };
  const now = deps.deposit.now();
  const usage = await deps.store.readRuleUsage(rule.ruleId, now);
  const verdict = ruleCoversAgentDeposit(
    rule,
    usage,
    { ...deps.conditions(), depositAddressMatches, balanceReadFailing: false, networkFeeAboveLimit: false },
    { from, amountWei, maxNetworkFeeWei },
  );
  return verdict.covered ? { covered: true, ruleId: rule.ruleId } : { covered: false, reason: verdict.reason };
}

export async function prepareAgentDeposit(
  deps: AgentDepositDeps,
  request: AgentDepositPrepareRequest,
  signal: AbortSignal,
): Promise<HostOutcome<AgentDepositIntentView>> {
  const bearer = await requireBearer(deps.deposit);
  if (!bearer.ok) return toHost(bearer);
  const read = await deps.deposit.api.readAccount(bearer.value, signal);
  if (!read.ok) return toHost(await backendRefusal(deps.deposit, read.failure));
  const account = read.value;

  let amountWei: bigint;
  if (request.amount.unit === "VEX") {
    const parsed = parseVexAmountText(request.amount.value);
    if (!parsed.ok) return toHost(refused("invalid_amount", "The VEX amount must be digits with at most 18 decimals, above zero."));
    amountWei = parsed.wei;
  } else {
    const microUsd = parseUsdMicro(request.amount.value);
    if (microUsd === null || microUsd === 0n) return toHost(refused("invalid_amount", "The USD amount must be digits with at most 6 decimals, above zero."));
    const minimum = minimumOf(account);
    if (!minimum.ok) return toHost(minimum);
    amountWei = microUsdToWeiCeil(microUsd, minimum.value.rateX18);
  }

  const planned = await planDeposit(deps.deposit, { walletAddress: request.walletAddress, amountWei }, signal, account);
  if (!planned.ok) return toHost(planned);
  const plan = planned.value;
  const rateX18 = plan.minimum.rateX18;
  const autoTopUp = await coverage(deps, account.account_id, plan.from, plan.amountWei, plan.feeBound.maxNetworkFeeWei, true);

  const now = deps.deposit.now();
  const expiresAtMs = now.getTime() + AGENT_DEPOSIT_TTL_MS;
  const minted = intents.mint(now.getTime(), (uuid) => {
    const intentId = `vxdep-${uuid}`;
    const view: AgentDepositIntentView = {
      intentId,
      chainId: VEX_CLOUD_CHAIN_ID,
      token: { address: VEX_TOKEN_ADDRESS, symbol: "VEX", decimals: 18 },
      amount: vexAmountView(plan.amountWei, rateX18),
      requested: request.amount,
      from: plan.from,
      depositAddress: plan.to,
      minimum: vexAmountView(plan.minimum.minimumWei, rateX18),
      networkFee: {
        gasLimit: plan.feeBound.gasLimit.toString(),
        maxFeePerGasWei: plan.feeBound.maxFeePerGas.toString(),
        maxPriorityFeePerGasWei: plan.feeBound.maxPriorityFeePerGas.toString(),
        maxNetworkFeeWei: plan.feeBound.maxNetworkFeeWei.toString(),
        nativeSymbol: "ETH",
        nativeDecimals: 18,
      },
      walletVex: vexAmountView(plan.walletVexWei, rateX18),
      preparedAt: now.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      autoTopUp,
    };
    return { proposalId: intentId, expiresAtMs, sessionId: request.sessionId, accountId: account.account_id, view, feeBound: plan.feeBound };
  });
  return { ok: true, value: minted.view };
}

function lookup(sessionId: string, intentId: string, nowMs: number): HostOutcome<AgentIntentEntry> {
  const found = intents.peek(intentId, nowMs);
  // A cross-session id reads exactly like a missing one.
  if (found.kind === "missing" || (found.kind === "ok" && found.entry.sessionId !== sessionId)) {
    return { ok: false, refusal: { kind: "proposal_missing", detail: "No such prepared deposit in this session: it was already sent, expired or never prepared. Nothing was signed. Prepare the deposit again." } };
  }
  if (found.kind === "expired") {
    return { ok: false, refusal: { kind: "proposal_expired", detail: "This prepared deposit expired. Nothing was signed. Prepare the deposit again to see current figures." } };
  }
  return { ok: true, value: found.entry };
}

export function peekAgentDeposit(deps: AgentDepositDeps, sessionId: string, intentId: string): HostOutcome<AgentDepositIntentView> {
  const found = lookup(sessionId, intentId, deps.deposit.now().getTime());
  return found.ok ? { ok: true, value: found.value.view } : found;
}

/** Retire an intent whose card the user rejected or let expire. A missing or cross-session id is a no-op. */
export function retireAgentDeposit(deps: AgentDepositDeps, sessionId: string, intentId: string): void {
  const found = intents.peek(intentId, deps.deposit.now().getTime());
  if (found.kind === "ok" && found.entry.sessionId !== sessionId) return;
  intents.drop(intentId);
}

export async function confirmAgentDeposit(
  deps: AgentDepositDeps,
  request: AgentDepositConfirmRequest,
  signal: AbortSignal,
): Promise<HostOutcome<AgentDepositConfirmResult>> {
  const found = lookup(request.sessionId, request.intentId, deps.deposit.now().getTime());
  if (!found.ok) return found;
  const entry = found.value;
  const view = entry.view;
  const amountWei = BigInt(view.amount.wei);

  let ruleId: string | null = null;
  let ruleVersion: number | null = null;
  let authority: "agent_card" | "agent_full_permission" | "auto_top_up_agent";
  if (request.authority.kind === "approved_card") {
    authority = "agent_card";
  } else if (request.authority.kind === "full_permission") {
    authority = "agent_full_permission";
  } else {
    const rule = await deps.store.readLiveRule(entry.accountId).catch(() => null);
    if (rule === null) return { ok: true, value: { kind: "needs_user_approval", reason: "no active auto top-up rule covers it", intent: view } };
    const usage = await deps.store.readRuleUsage(rule.ruleId, deps.deposit.now());
    const verdict = ruleCoversAgentDeposit(
      rule,
      usage,
      { ...deps.conditions(), depositAddressMatches: true, balanceReadFailing: false, networkFeeAboveLimit: false },
      { from: view.from, amountWei, maxNetworkFeeWei: entry.feeBound.maxNetworkFeeWei },
    );
    if (!verdict.covered) return { ok: true, value: { kind: "needs_user_approval", reason: verdict.reason, intent: view } };
    authority = "auto_top_up_agent";
    ruleId = rule.ruleId;
    ruleVersion = rule.version;
  }

  // Single use from here on: a second confirm of the same intent finds nothing.
  const consumed = intents.consume(request.intentId, deps.deposit.now().getTime());
  if (consumed.kind !== "ok") {
    return { ok: false, refusal: { kind: "proposal_missing", detail: "This prepared deposit was already used or expired. Nothing was signed." } };
  }

  const executed = await executeRecordedDeposit(
    deps,
    {
      authority,
      ruleId,
      ruleVersion,
      sessionId: request.sessionId,
      from: view.from,
      amountWei,
      approved: {
        from: view.from,
        to: view.depositAddress,
        amountWei,
        feeBound: entry.feeBound,
        expiresAtMs: entry.expiresAtMs,
      },
      extraFinal: () => {
        const blocked = request.sourceWalletStillAllowed(view.from);
        return blocked === null ? null : { kind: "wallet_not_in_inventory", detail: blocked };
      },
    },
    signal,
  );
  if (!executed.ok) return toHost(executed);
  return {
    ok: true,
    value: {
      kind: "executed",
      status: executed.value.status,
      txHash: executed.value.txHash,
      transferProven: executed.value.transferProven,
      notified: executed.value.notified,
      authority: authority === "agent_card" ? "approved_card" : authority === "agent_full_permission" ? "full_permission" : "auto_top_up_rule",
      ruleId,
      executionId: executed.value.executionId,
      intent: view,
    },
  };
}
