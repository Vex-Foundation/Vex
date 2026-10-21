/**
 * The Vex Inference STATUS read behind `VexInferenceStatus` (engine host
 * seam): the account, the low-balance alert, the current model's published
 * prices, a page of recent usage, whether deposits are open, and the auto
 * top-up rule with its derived state.
 *
 * Read only: it signs nothing and moves nothing. It does record one balance
 * observation (the alert's high-water mark), which is the same observation
 * the poller and the funding page make.
 *
 * Partial answers are honest: a failed `/v1/models` read reports the model
 * as `priced: false` with the reason; a failed usage page fails the read
 * rather than claiming there is no usage.
 */

import type { HostOutcome, VexInferenceStatusReport, VexInferenceStatusRequest } from "@vex-agent/tools/internal/vex-inference/host.js";
import { parseRateX18 } from "@shared/vex-cloud-money.js";
import type { VexCloudApi } from "./api-client.js";
import { accountBalanceWei, newestCreditedDepositId, observeBalance, type BalanceWatchDeps } from "./balance-watch.js";
import { backendRefusal, requireBearer, type SessionPort } from "./funding/backend-call.js";
import type { FundingPolicyStore } from "./auto-top-up/funding-store.js";
import { effectiveRuleState, type ObservedRuleConditions, type RuleConditions } from "./auto-top-up/rule-policy.js";
import { backendAmountView, pricePerMillionView, vexAmountView } from "./vex-inference-amounts.js";

export interface StatusDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "readAccount" | "listUsage" | "listDeposits" | "listModels">;
  readonly store: FundingPolicyStore;
  readonly watch: BalanceWatchDeps;
  readonly pinnedDepositAddress: () => string | null;
  readonly conditions: () => Omit<RuleConditions, ObservedRuleConditions>;
  /** Whether the poller's last attempt for this rule version was refused for its network fee. */
  readonly networkFeeAboveLimit: (rule: { readonly ruleId: string; readonly version: number }) => boolean;
  readonly now: () => Date;
}

function toHost<T>(outcome: { ok: false; refusal: { kind: string; detail: string } }): HostOutcome<T> {
  return { ok: false, refusal: { kind: outcome.refusal.kind, detail: outcome.refusal.detail } };
}

export async function readVexInferenceStatus(
  deps: StatusDeps,
  request: VexInferenceStatusRequest,
  signal: AbortSignal,
): Promise<HostOutcome<VexInferenceStatusReport>> {
  const bearer = await requireBearer(deps);
  if (!bearer.ok) return toHost(bearer);
  // Deposits BEFORE the balance read: a credit this page shows is inside the
  // balance the alert reference resets to; a failed read keeps the stored one.
  const deposits = await deps.api.listDeposits(bearer.value, { cursor: null, limit: 20 }, signal);
  const generation = deps.watch.generations.next();
  const read = await deps.api.readAccount(bearer.value, signal);
  if (!read.ok) {
    const refusal = await backendRefusal<never>(deps, read.failure);
    return refusal.ok ? { ok: false, refusal: { kind: "unavailable", detail: "The account could not be read." } } : toHost(refusal);
  }
  const account = read.value;
  const rateX18 = account.rate.available ? parseRateX18(account.rate.vex_wei_per_micro_usd) : null;

  const usage = await deps.api.listUsage(bearer.value, { cursor: request.usageCursor, limit: request.usageLimit }, signal);
  if (!usage.ok) {
    const refusal = await backendRefusal<never>(deps, usage.failure);
    return refusal.ok ? { ok: false, refusal: { kind: "unavailable", detail: "The usage page could not be read." } } : toHost(refusal);
  }

  const observation = await observeBalance(deps.watch, {
    accountId: account.account_id,
    balanceWei: accountBalanceWei(account),
    newestCreditedDepositId: deposits.ok ? newestCreditedDepositId(deposits.value.items) : null,
    generation,
  });

  let model: VexInferenceStatusReport["model"];
  if (request.modelId === null) {
    model = { id: "unknown", effort: request.effort, priced: false, reason: "No model is configured." };
  } else {
    const models = await deps.api.listModels(bearer.value, signal);
    const row = models.ok ? models.value.data.find((entry) => entry.id === request.modelId) : undefined;
    const input = row === undefined ? null : pricePerMillionView(row.pricing.prompt, rateX18);
    const output = row === undefined ? null : pricePerMillionView(row.pricing.completion, rateX18);
    if (!models.ok) {
      model = { id: request.modelId, effort: request.effort, priced: false, reason: "The Vex Inference model list could not be read." };
    } else if (row === undefined || input === null || output === null) {
      model = { id: request.modelId, effort: request.effort, priced: false, reason: "The configured model is not in the Vex Inference model list." };
    } else {
      const reasoning = row.pricing.internal_reasoning === undefined ? null : pricePerMillionView(row.pricing.internal_reasoning, rateX18);
      model = {
        id: row.id,
        effort: request.effort,
        priced: true,
        inputPerMillion: input,
        outputPerMillion: output,
        reasoningPerMillion: reasoning,
        reasoningNote: reasoning === null ? "Vex Inference publishes no separate reasoning price for this model; reasoning tokens are billed as output." : null,
      };
    }
  }

  const pinned = deps.pinnedDepositAddress();
  const backendAddress = account.deposit_address;
  const depositState: VexInferenceStatusReport["deposits"]["state"] =
    pinned === null ? "not_pinned"
    : backendAddress === null ? "backend_not_configured"
    : backendAddress.toLowerCase() === pinned.toLowerCase() ? "open"
    : "address_mismatch";

  let autoTopUp: VexInferenceStatusReport["autoTopUp"] = { state: "none" };
  const rule = await deps.store.readLiveRule(account.account_id);
  if (rule !== null) {
    const now = deps.now();
    const used = await deps.store.readRuleUsage(rule.ruleId, now);
    const state = effectiveRuleState(rule, used, {
      ...deps.conditions(),
      depositAddressMatches: depositState === "open",
      balanceReadFailing: false,
      networkFeeAboveLimit: deps.networkFeeAboveLimit(rule),
    });
    autoTopUp = {
      ruleId: rule.ruleId,
      state: state.state,
      suspendedReason: state.state === "suspended" ? state.reason : null,
      sourceWallet: rule.sourceWallet,
      amountPerTopUp: vexAmountView(rule.amountWei, rateX18),
      maxPerDay: rule.maxPerDay,
      monthlyCap: vexAmountView(rule.monthlyCapWei, rateX18),
      maxNetworkFeeWei: rule.maxNetworkFeeWei === null ? null : rule.maxNetworkFeeWei.toString(),
      usedLast24Hours: used.countLastDay,
      usedLast30Days: vexAmountView(used.sumLast30DaysWei, rateX18),
      expiresAt: rule.expiresAt.toISOString(),
      trigger: rule.triggerKind,
    };
  }

  const nextCursor = usage.value.next_cursor;
  return {
    ok: true,
    value: {
      account: { accountId: account.account_id, paused: account.status.paused, drainMode: account.status.drain_mode },
      balances: {
        available: backendAmountView(account.balances.available),
        provisional: backendAmountView(account.balances.provisional),
        reserved: backendAmountView(account.balances.reserved),
        claimable: backendAmountView(account.balances.claimable),
        cashbackPending: account.balances.cashback_pending === undefined ? null : backendAmountView(account.balances.cashback_pending),
        pendingWithdrawal: backendAmountView(account.balances.pending_withdrawal),
      },
      rate: account.rate.available
        ? {
          available: true,
          vexWeiPerMicroUsd: account.rate.vex_wei_per_micro_usd,
          source: account.rate.source,
          ageSeconds: account.rate.age_seconds,
          observedAt: account.rate.observed_at,
          validUntil: account.rate.valid_until,
        }
        : { available: false, reason: account.rate.reason },
      alert: {
        percent: observation.alertPercent,
        reference: vexAmountView(observation.referenceWei, rateX18),
        threshold: vexAmountView(observation.thresholdWei, rateX18),
        balance: vexAmountView(observation.balanceWei, rateX18),
        belowAlert: observation.belowAlert,
      },
      model,
      usage: {
        items: usage.value.items.map((item) => ({
          requestId: item.request_id,
          model: item.model,
          effort: item.effort,
          status: item.status,
          upstreamCostMicroUsd: item.upstream_cost_micro_usd,
          charged: item.charged_wei === null ? null : vexAmountView(BigInt(item.charged_wei), rateX18),
          clampReason: item.clamp_reason,
          createdAt: item.created_at,
        })),
        limit: request.usageLimit,
        hasMore: nextCursor !== null,
        ...(nextCursor !== null && { nextCursor }),
      },
      deposits: { open: depositState === "open", state: depositState, pinnedAddress: pinned, backendAddress },
      autoTopUp,
    },
  };
}
