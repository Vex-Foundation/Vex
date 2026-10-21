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
 *
 * A plan whose network fee bound is above the rule's ceiling is refused
 * (nothing signed, recorded `refused`, not counted) and the rule reads
 * suspended `network_fee_above_limit` ("Network fee above your limit"). The
 * poller tries again after {@link FEE_RETRY_AFTER_MS}, not every tick, so a
 * fee spike leaves one refused row per interval instead of one per minute.
 *
 * Each tick reads the deposits page FIRST, then takes the observation
 * generation, then reads the balance (`balance-watch.ts`): a credit the page
 * shows is included in the balance the reference resets to.
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
/** After a fee refusal, the next attempt waits this long (the rule reads suspended meanwhile). */
export const FEE_RETRY_AFTER_MS = 10 * 60_000;

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
  /**
   * The rule version whose last attempt was refused because the network fee
   * was above its ceiling, or `null`. Keyed by version: an edit (a new
   * ceiling) clears it for the views at once.
   */
  readonly networkFeeAboveLimit: { readonly ruleId: string; readonly version: number } | null;
}

/** Whether a poller snapshot marks THIS rule version as suspended for its network fee. */
export function feeSuspended(snapshot: PollerSnapshot, rule: { readonly ruleId: string; readonly version: number }): boolean {
  const marked = snapshot.networkFeeAboveLimit;
  return marked !== null && marked.ruleId === rule.ruleId && marked.version === rule.version;
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
  /** The last fee refusal (deposit clock, ms) and the rule version it was for, or `null`. Cleared by any other outcome. */
  let feeRefused: { readonly ruleId: string; readonly version: number; readonly atMs: number } | null = null;

  async function tick(signal: AbortSignal): Promise<PollerTickOutcome> {
    const conditions = deps.conditions();
    if (!conditions.vaultUnlocked || !conditions.executionReady || conditions.quitting) return "skipped_not_ready";
    await markRecoveryComplete(deps.store, deps.deposit.now());
    const bearer = await requireBearer(deps.deposit);
    if (!bearer.ok) return "skipped_signed_out";

    // Deposits first: a credit this page shows is then inside the balance read below.
    const deposits = await deps.api.listDeposits(bearer.value, { cursor: null, limit: 20 }, signal);
    const generation = deps.watch.generations.next();
    const read = await deps.api.readAccount(bearer.value, signal);
    if (!read.ok) {
      balanceReadFailing = true;
      return "balance_read_failing";
    }
    balanceReadFailing = false;
    const account = read.value;
    const observation = await observeBalance(deps.watch, {
      accountId: account.account_id,
      balanceWei: accountBalanceWei(account),
      newestCreditedDepositId: deposits.ok ? newestCreditedDepositId(deposits.value.items) : null,
      generation,
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
      // The poller decides whether to try again itself, below.
      networkFeeAboveLimit: false,
    });
    if (state.state !== "active") return "suspended";
    if (!pollerShouldTopUp(state, observation.belowAlert)) return "not_triggered";
    if (signal.aborted || admissionClosed) return "skipped_not_ready";
    if (
      feeRefused !== null
      && feeRefused.ruleId === rule.ruleId
      && feeRefused.version === rule.version
      && now.getTime() - feeRefused.atMs < FEE_RETRY_AFTER_MS
    ) return "suspended";

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
      feeRefused = executed.refusal.kind === "network_fee_above_limit"
        ? { ruleId: rule.ruleId, version: rule.version, atMs: deps.deposit.now().getTime() }
        : null;
      log.info(`[vex-cloud:auto-top-up] poller refused kind=${executed.refusal.kind}`);
      return "refused";
    }
    feeRefused = null;
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
      return { running, lastTickAt, lastOutcome, balanceReadFailing, networkFeeAboveLimit: feeRefused === null ? null : { ruleId: feeRefused.ruleId, version: feeRefused.version } };
    },
  };
}
