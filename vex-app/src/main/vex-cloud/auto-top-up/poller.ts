/**
 * THE AUTO TOP-UP POLLER: reads the Vex Inference balance on a fixed cadence
 * while the vault is unlocked, records the low-balance observation, and
 * executes the user's active rule when the balance is below the alert.
 *
 * LIFECYCLE (one owner, this module):
 *
 * - `start()` on vault unlock (`onSecretSessionLifecycle`), and only once
 *   recovery ran (`markRecoveryComplete`, the previous process's undecided
 *   executions marked unknown before anything new is admitted);
 * - `stop()` on vault lock and on quit, from the ordered quit cleanup before
 *   the local runtime stops: closes admission, cancels the timer, aborts the
 *   in-flight READS and DRAINS the in-flight tick. A deposit already past its
 *   final check runs to completion (the signing window is never interrupted)
 *   and is decided before `stop()` resolves;
 * - at most ONE tick at a time and at most one execution per tick; the
 *   executor's durable single flight keeps it to one per rule across the
 *   poller and the agent tool.
 *
 * A failing balance read suspends the rule for that tick (derived state,
 * `balance_read_failing`) and nothing is sent; the next tick reads again. It
 * never retries a deposit: an unknown outcome is counted and left for the
 * user to reconcile from History.
 */

import { log } from "../../logger/index.js";
import type { VexCloudApi } from "../api-client.js";
import { accountBalanceWei, newestCreditedDepositId, observeBalance, type BalanceWatchDeps } from "../balance-watch.js";
import { requireBearer } from "../funding/backend-call.js";
import { executeRecordedDeposit, markRecoveryComplete, type RecordedExecutionDeps } from "./executor.js";
import { effectiveRuleState, pollerShouldTopUp } from "./rule-policy.js";

export const AUTO_TOP_UP_POLL_INTERVAL_MS = 60_000;
/** The first tick after an unlock: soon, but after the window and the runtime settle. */
export const AUTO_TOP_UP_FIRST_TICK_MS = 5_000;

export interface PollerDeps extends RecordedExecutionDeps {
  readonly api: Pick<VexCloudApi, "readAccount" | "listDeposits">;
  readonly watch: BalanceWatchDeps;
  readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}

export type PollerTickOutcome =
  | "skipped_not_ready"
  | "skipped_signed_out"
  | "balance_read_failing"
  | "no_rule"
  | "not_triggered"
  | "suspended"
  | "executed"
  | "refused";

/** Last tick's facts, read by the funding page and the status read (derived `balance_read_failing`). */
export interface PollerSnapshot {
  readonly running: boolean;
  readonly lastTickAt: string | null;
  readonly lastOutcome: PollerTickOutcome | null;
  readonly balanceReadFailing: boolean;
}

export interface AutoTopUpPoller {
  start(): void;
  stop(): Promise<void>;
  /** One tick now (tests, and an explicit refresh). Joins a running tick instead of starting a second. */
  tickNow(): Promise<PollerTickOutcome>;
  snapshot(): PollerSnapshot;
}

export function createAutoTopUpPoller(deps: PollerDeps): AutoTopUpPoller {
  let running = false;
  /** Admission: closed by `stop()`, reopened by `start()`. A tick past this point sends nothing. */
  let admissionClosed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<PollerTickOutcome> | null = null;
  let controller: AbortController | null = null;
  let lastTickAt: string | null = null;
  let lastOutcome: PollerTickOutcome | null = null;
  let balanceReadFailing = false;

  async function tick(signal: AbortSignal): Promise<PollerTickOutcome> {
    const conditions = deps.conditions();
    if (!conditions.vaultUnlocked || !conditions.executionReady || conditions.quitting) return "skipped_not_ready";
    await markRecoveryComplete(deps.store, deps.deposit.now());
    const bearer = await requireBearer(deps.deposit);
    if (!bearer.ok) return "skipped_signed_out";

    const read = await deps.api.readAccount(bearer.value, signal);
    if (!read.ok) {
      balanceReadFailing = true;
      return "balance_read_failing";
    }
    balanceReadFailing = false;
    const account = read.value;
    const deposits = await deps.api.listDeposits(bearer.value, { cursor: null, limit: 20 }, signal);
    const observation = await observeBalance(deps.watch, {
      accountId: account.account_id,
      balanceWei: accountBalanceWei(account),
      newestCreditedDepositId: deposits.ok ? newestCreditedDepositId(deposits.value.items) : null,
    });

    const now = deps.deposit.now();
    await deps.store.expireRules(now);
    const rule = await deps.store.readLiveRule(account.account_id);
    if (rule === null) return "no_rule";
    const usage = await deps.store.readRuleUsage(rule.ruleId, now);
    const pinned = deps.deposit.pinnedDepositAddress();
    const state = effectiveRuleState(rule, usage, {
      ...deps.conditions(),
      depositAddressMatches: pinned !== null && account.deposit_address !== null && pinned.toLowerCase() === account.deposit_address.toLowerCase(),
      balanceReadFailing: false,
    });
    if (state.state !== "active") return "suspended";
    if (!pollerShouldTopUp(state, observation.belowAlert)) return "not_triggered";
    if (signal.aborted || admissionClosed) return "skipped_not_ready";

    const executed = await executeRecordedDeposit(
      deps,
      {
        authority: "auto_top_up_poller",
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        sessionId: null,
        from: rule.sourceWallet,
        amountWei: rule.amountWei,
        approved: null,
      },
      signal,
    );
    if (!executed.ok) {
      log.info(`[vex-cloud:auto-top-up] poller refused kind=${executed.refusal.kind}`);
      return "refused";
    }
    log.info(`[vex-cloud:auto-top-up] poller executed status=${executed.value.status}`);
    return "executed";
  }

  function runTick(): Promise<PollerTickOutcome> {
    if (inFlight !== null) return inFlight;
    controller = new AbortController();
    const signal = controller.signal;
    inFlight = tick(signal)
      .catch((cause: unknown) => {
        log.warn(`[vex-cloud:auto-top-up] tick failed type=${cause instanceof Error ? cause.name : typeof cause}`);
        return "refused" as const;
      })
      .then((outcome) => {
        lastTickAt = deps.deposit.now().toISOString();
        lastOutcome = outcome;
        return outcome;
      })
      .finally(() => {
        inFlight = null;
        controller = null;
      });
    return inFlight;
  }

  function schedule(ms: number): void {
    if (!running) return;
    timer = deps.setTimer(() => {
      timer = null;
      if (!running) return;
      void runTick().finally(() => schedule(AUTO_TOP_UP_POLL_INTERVAL_MS));
    }, ms);
  }

  return {
    start() {
      if (running) return;
      running = true;
      admissionClosed = false;
      schedule(AUTO_TOP_UP_FIRST_TICK_MS);
    },
    async stop() {
      // 1. close admission; 2. stop the producer; 3. cancel reads; 4. drain.
      running = false;
      admissionClosed = true;
      if (timer !== null) {
        deps.clearTimer(timer);
        timer = null;
      }
      controller?.abort();
      if (inFlight !== null) await inFlight;
    },
    tickNow() {
      return runTick();
    },
    snapshot() {
      return { running, lastTickAt, lastOutcome, balanceReadFailing };
    },
  };
}
