/**
 * THE VEX INFERENCE RUNTIME: the one owner that composes, mounts and stops the
 * funding policy pieces that outlive a single IPC call:
 *
 * - the engine host (`registerVexInferenceHost`) behind the agent's
 *   `VexInferenceStatus` and deposit tools;
 * - the auto top-up poller, started on vault unlock and stopped on lock
 *   (`onSecretSessionLifecycle`) and on quit (the ordered quit task in
 *   `index.ts`, before the local runtime stops Postgres);
 * - the signed-in account tracker the rule conditions read;
 * - the balance watch and its engine notice.
 *
 * `startVexInferenceRuntime` is idempotent and returns the composed pieces
 * the IPC handlers share, so the funding page, the agent and the poller reach
 * the world through the same deps and one durable store.
 */

import { randomUUID } from "node:crypto";
import { emitVexInferenceBalanceLowNotice } from "@vex-agent/inference/inference-notice-bus.js";
import {
  registerVexInferenceHost,
  resetVexInferenceHost,
  type VexInferenceHost,
} from "@vex-agent/tools/internal/vex-inference/host.js";
import { executionGateState, isExecutionGateOpen } from "../lifecycle/execution-gate.js";
import { log } from "../logger/index.js";
import { isSecretSessionUnlocked, onSecretSessionLifecycle } from "../secrets/session.js";
import type { VexCloudApi } from "./api-client.js";
import type { BalanceWatchDeps } from "./balance-watch.js";
import type { DepositDeps } from "./funding/deposit-core.js";
import { confirmAgentDeposit, peekAgentDeposit, prepareAgentDeposit, type AgentDepositDeps } from "./funding/agent-deposit.js";
import { productionFundingPolicyStore, type FundingPolicyStore } from "./auto-top-up/funding-store.js";
import { createAutoTopUpPoller, type AutoTopUpPoller } from "./auto-top-up/poller.js";
import type { RuleConditions } from "./auto-top-up/rule-policy.js";
import type { RuleOwnerDeps } from "./auto-top-up/rule-proposals.js";
import type { VexCloudDeps } from "./production.js";
import { readVexInferenceStatus, type StatusDeps } from "./status.js";

export type LiveConditions = Omit<RuleConditions, "depositAddressMatches" | "balanceReadFailing">;

// ── signed-in account tracker ────────────────────────────────────────────

let signedInAccountId: string | null = null;

/** Wrap the client so every successful account read records the signed-in account, and a 401 forgets it. */
export function trackAccountReads<A extends Pick<VexCloudApi, "readAccount">>(api: A): A {
  return {
    ...api,
    readAccount: async (bearer: string, signal: AbortSignal) => {
      const read = await api.readAccount(bearer, signal);
      if (read.ok) signedInAccountId = read.value.account_id;
      else if (read.failure.kind === "unauthorized") signedInAccountId = null;
      return read;
    },
  };
}

export function forgetSignedInAccount(): void {
  signedInAccountId = null;
}

export function currentSignedInAccountId(): string | null {
  return signedInAccountId;
}

// ── composition ──────────────────────────────────────────────────────────

export interface VexInferenceRuntime {
  readonly store: FundingPolicyStore;
  readonly deposit: DepositDeps;
  readonly watch: BalanceWatchDeps;
  readonly ruleOwner: RuleOwnerDeps;
  readonly poller: AutoTopUpPoller;
  readonly conditions: () => LiveConditions;
}

export function composeVexInferenceRuntime(
  deps: VexCloudDeps,
  options: { readonly store: FundingPolicyStore; readonly conditions?: () => LiveConditions },
): VexInferenceRuntime {
  const api = trackAccountReads(deps.api);
  const clearSession = async (): ReturnType<VexCloudDeps["clearSession"]> => {
    forgetSignedInAccount();
    return deps.clearSession();
  };
  const deposit: DepositDeps = { ...deps.deposit, readSession: deps.account.readSession, clearSession, api };
  const conditions =
    options.conditions
    ?? ((): LiveConditions => ({
      now: deps.deposit.now(),
      vaultUnlocked: isSecretSessionUnlocked(),
      quitting: executionGateState() === "shutting_down",
      executionReady: isExecutionGateOpen(),
      signedInAccountId,
    }));
  const watch: BalanceWatchDeps = {
    store: options.store,
    emitCrossing: (observation) => {
      emitVexInferenceBalanceLowNotice({
        alertPercent: observation.alertPercent,
        balanceWei: observation.balanceWei,
        thresholdWei: observation.thresholdWei,
        referenceWei: observation.referenceWei,
      });
    },
  };
  const poller = createAutoTopUpPoller({
    deposit,
    store: options.store,
    conditions,
    api,
    watch,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
  });
  const ruleOwner: RuleOwnerDeps = {
    readSession: deps.account.readSession,
    clearSession,
    api,
    store: options.store,
    listEvmWallets: deps.deposit.listEvmWallets,
    pinnedDepositAddress: deps.deposit.pinnedDepositAddress,
    conditions,
    balanceReadFailing: () => poller.snapshot().balanceReadFailing,
    now: deps.deposit.now,
    newRuleId: () => `vxrule-${randomUUID()}`,
  };
  return { store: options.store, deposit, watch, ruleOwner, poller, conditions };
}

/** The engine host over a composed runtime. */
export function vexInferenceHost(runtime: VexInferenceRuntime, deps: VexCloudDeps): VexInferenceHost {
  const agent: AgentDepositDeps = { deposit: runtime.deposit, store: runtime.store, conditions: runtime.conditions };
  const status: StatusDeps = {
    readSession: runtime.deposit.readSession,
    clearSession: runtime.deposit.clearSession,
    api: { ...deps.api, readAccount: runtime.deposit.api.readAccount },
    store: runtime.store,
    watch: runtime.watch,
    pinnedDepositAddress: runtime.deposit.pinnedDepositAddress,
    conditions: runtime.conditions,
    now: runtime.deposit.now,
  };
  return {
    readStatus: (request, signal) => readVexInferenceStatus(status, request, signal),
    prepareAgentDeposit: (request, signal) => prepareAgentDeposit(agent, request, signal),
    peekAgentDeposit: (sessionId, intentId) => peekAgentDeposit(agent, sessionId, intentId),
    confirmAgentDeposit: (request, signal) => confirmAgentDeposit(agent, request, signal),
  };
}

let mounted: { readonly runtime: VexInferenceRuntime; readonly unsubscribe: () => void } | null = null;

/**
 * Compose the production runtime once, mount the engine host, and tie the
 * poller to the vault lifecycle. Idempotent.
 */
export function startVexInferenceRuntime(deps: VexCloudDeps): VexInferenceRuntime {
  if (mounted !== null) return mounted.runtime;
  const runtime = composeVexInferenceRuntime(deps, { store: productionFundingPolicyStore() });
  registerVexInferenceHost(vexInferenceHost(runtime, deps));
  const unsubscribe = onSecretSessionLifecycle((state) => {
    if (state === "unlocked") runtime.poller.start();
    else void runtime.poller.stop();
  });
  if (isSecretSessionUnlocked()) runtime.poller.start();
  mounted = { runtime, unsubscribe };
  return runtime;
}

/**
 * Stop admission, unmount the host and drain the poller (an in-flight
 * deposit past its final check completes and is decided first). Called from
 * the ordered quit task before the local runtime stops Postgres, and from the
 * IPC teardown. Idempotent.
 */
export async function stopVexInferenceRuntime(): Promise<void> {
  const current = mounted;
  if (current === null) return;
  mounted = null;
  current.unsubscribe();
  resetVexInferenceHost();
  try {
    await current.runtime.poller.stop();
  } catch (cause) {
    log.warn(`[vex-cloud:runtime] poller stop failed type=${cause instanceof Error ? cause.name : typeof cause}`);
  }
}
