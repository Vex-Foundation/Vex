/**
 * THE LOW-BALANCE WATCH: the user's alert percent, the reference amount it
 * applies to, and ONE notice per crossing.
 *
 * - The balance is available plus provisional (what can pay for inference).
 * - The REFERENCE is the balance high-water mark since the last credited
 *   deposit: every observation raises it to the balance when higher, and a
 *   newly credited deposit (a deposit id not seen before) resets it to the
 *   balance after that deposit.
 * - The THRESHOLD is `reference * percent / 100`, rounded down to whole wei.
 *   The balance is below the alert when it is strictly under the threshold.
 * - The CROSSING LATCH is durable (`vex_inference_balance_watch.below_alert`):
 *   the notice is emitted only on a transition from not-below to below, under
 *   the row's lock, so concurrent observers (the poller and an account read)
 *   cannot emit twice, and a restart does not re-emit a dip already told.
 *
 * - OBSERVATIONS ARE ORDERED. Each observation takes a monotonic generation
 *   ({@link ObservationGenerations}) BEFORE its balance read starts, and the
 *   write is admitted only when no newer generation was already applied for
 *   the account. A slow read that lands after a newer one is discarded: it
 *   can neither clear the latch (and re-arm a second notice for the same
 *   dip) nor move the reference backwards.
 * - A CREDIT RESETS THE REFERENCE ONLY WITH A LATER BALANCE. Callers read the
 *   deposits page BEFORE the generation and the balance read, so a credited
 *   deposit seen in that page is already included in the balance the reset
 *   uses.
 *
 * Observed from the poller's account reads and the agent's status read;
 * never from model input.
 */

import type { VexCloudAccountResponse } from "./api-client.js";
import type { BalanceWatchRow, FundingPolicyStore } from "./auto-top-up/funding-store.js";

export interface BalanceObservation {
  readonly alertPercent: number;
  readonly balanceWei: bigint;
  readonly referenceWei: bigint;
  readonly thresholdWei: bigint;
  readonly belowAlert: boolean;
  /** True for exactly the observation that crossed from not-below to below. */
  readonly crossed: boolean;
  /** True when this read was older than one already applied: nothing was written, the figures are the newer ones. */
  readonly stale: boolean;
}

/**
 * The per-process observation order. `next()` is called before a balance read
 * starts; `admit` runs inside the watch row's lock and accepts a generation
 * only if it is newer than every one already applied for that account.
 * In memory on purpose: a read from a previous process cannot land in this
 * one, so the order only has to hold within a process. Bounded by the number
 * of accounts observed.
 */
export interface ObservationGenerations {
  next(): number;
  admit(accountId: string, generation: number): boolean;
}

export function createObservationGenerations(): ObservationGenerations {
  let counter = 0;
  const applied = new Map<string, number>();
  return {
    next: () => {
      counter += 1;
      return counter;
    },
    admit: (accountId, generation) => {
      const latest = applied.get(accountId);
      if (latest !== undefined && generation < latest) return false;
      applied.set(accountId, generation);
      return true;
    },
  };
}

export function accountBalanceWei(account: VexCloudAccountResponse): bigint {
  return BigInt(account.balances.available.wei) + BigInt(account.balances.provisional.wei);
}

export function thresholdOf(referenceWei: bigint, alertPercent: number): bigint {
  return (referenceWei * BigInt(alertPercent)) / 100n;
}

/** The pure transition: the stored row and a new observation -> the next row. */
export function nextWatchRow(
  current: BalanceWatchRow | null,
  observation: { readonly accountId: string; readonly balanceWei: bigint; readonly newestCreditedDepositId: string | null; readonly alertPercent: number },
): BalanceWatchRow {
  const newDeposit =
    current !== null
    && observation.newestCreditedDepositId !== null
    && observation.newestCreditedDepositId !== current.lastCreditedDepositId;
  const referenceWei =
    current === null || newDeposit
      ? observation.balanceWei
      : current.referenceWei > observation.balanceWei ? current.referenceWei : observation.balanceWei;
  const belowAlert = observation.balanceWei < thresholdOf(referenceWei, observation.alertPercent);
  return {
    accountId: observation.accountId,
    referenceWei,
    lastBalanceWei: observation.balanceWei,
    belowAlert,
    lastCreditedDepositId: observation.newestCreditedDepositId ?? current?.lastCreditedDepositId ?? null,
  };
}

export interface BalanceWatchDeps {
  readonly store: Pick<FundingPolicyStore, "readAlertPercent" | "updateBalanceWatch">;
  readonly generations: ObservationGenerations;
  /** Emit the engine notice for one crossing. */
  readonly emitCrossing: (observation: BalanceObservation) => void;
}

/**
 * Record one observation and emit the notice when it is the crossing.
 * `generation` is the value {@link ObservationGenerations.next} returned
 * before the balance read started.
 */
export async function observeBalance(
  deps: BalanceWatchDeps,
  input: {
    readonly accountId: string;
    readonly balanceWei: bigint;
    readonly newestCreditedDepositId: string | null;
    readonly generation: number;
  },
): Promise<BalanceObservation> {
  const alertPercent = await deps.store.readAlertPercent();
  let stale = false;
  const { before, after } = await deps.store.updateBalanceWatch(input.accountId, (current) => {
    // Decided under the row lock, so two observations of one account are ordered here.
    if (current !== null && !deps.generations.admit(input.accountId, input.generation)) {
      stale = true;
      return current;
    }
    if (current === null) deps.generations.admit(input.accountId, input.generation);
    return nextWatchRow(current, { accountId: input.accountId, balanceWei: input.balanceWei, newestCreditedDepositId: input.newestCreditedDepositId, alertPercent });
  });
  const crossed = !stale && after.belowAlert && !(before?.belowAlert ?? false);
  const observation: BalanceObservation = {
    alertPercent,
    balanceWei: after.lastBalanceWei,
    referenceWei: after.referenceWei,
    thresholdWei: thresholdOf(after.referenceWei, alertPercent),
    belowAlert: after.belowAlert,
    crossed,
    stale,
  };
  if (crossed) deps.emitCrossing(observation);
  return observation;
}

/** The newest CREDITED deposit id on a deposits page (newest first), or `null`. */
export function newestCreditedDepositId(items: readonly { readonly id: string; readonly status: string }[]): string | null {
  return items.find((item) => item.status === "credited")?.id ?? null;
}
