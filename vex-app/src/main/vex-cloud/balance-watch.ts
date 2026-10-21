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
 * Observed from the poller's account reads, the funding page's alert read and
 * the agent's status read; never from model input.
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
  /** Emit the engine notice for one crossing. */
  readonly emitCrossing: (observation: BalanceObservation) => void;
}

/** Record one observation and emit the notice when it is the crossing. */
export async function observeBalance(
  deps: BalanceWatchDeps,
  input: { readonly accountId: string; readonly balanceWei: bigint; readonly newestCreditedDepositId: string | null },
): Promise<BalanceObservation> {
  const alertPercent = await deps.store.readAlertPercent();
  const { before, after } = await deps.store.updateBalanceWatch(input.accountId, (current) =>
    nextWatchRow(current, { ...input, alertPercent }),
  );
  const crossed = after.belowAlert && !(before?.belowAlert ?? false);
  const observation: BalanceObservation = {
    alertPercent,
    balanceWei: after.lastBalanceWei,
    referenceWei: after.referenceWei,
    thresholdWei: thresholdOf(after.referenceWei, alertPercent),
    belowAlert: after.belowAlert,
    crossed,
  };
  if (crossed) deps.emitCrossing(observation);
  return observation;
}

/** The newest CREDITED deposit id on a deposits page (newest first), or `null`. */
export function newestCreditedDepositId(items: readonly { readonly id: string; readonly status: string }[]): string | null {
  return items.find((item) => item.status === "credited")?.id ?? null;
}
