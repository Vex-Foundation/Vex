/**
 * Same-process Desk dispatch result sharing.
 *
 * The approve IPC path and the scheduled `approved/not_started` recovery can
 * reach the same intent together. They must share the one dispatch result:
 * the Desk has no transcript row, so a CAS loser cannot reconstruct the tool
 * output from the durable status alone.
 */

import type { ApprovePrepareOutcome } from "../types.js";

type DeskDispatchOutcome = Extract<ApprovePrepareOutcome, { kind: "dispatched" }>;

const RECENT_RESULT_CAP = 256;
const inFlight = new Map<string, Promise<ApprovePrepareOutcome>>();
const recent = new Map<string, DeskDispatchOutcome>();

function remember(approvalId: string, outcome: DeskDispatchOutcome): void {
  recent.delete(approvalId);
  recent.set(approvalId, outcome);
  while (recent.size > RECENT_RESULT_CAP) {
    const oldest = recent.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

/** Join the active dispatch, or reuse its recent terminal result. */
export function readDeskApprovalDispatch(
  approvalId: string,
): Promise<ApprovePrepareOutcome> | null {
  const active = inFlight.get(approvalId);
  if (active !== undefined) return active;
  const completed = recent.get(approvalId);
  return completed === undefined ? null : Promise.resolve(completed);
}

/** Admit one owner and make every same-process caller await its exact result. */
export function runDeskApprovalDispatch(
  approvalId: string,
  dispatch: () => Promise<ApprovePrepareOutcome>,
): Promise<ApprovePrepareOutcome> {
  const existing = readDeskApprovalDispatch(approvalId);
  if (existing !== null) return existing;

  const flight = Promise.resolve()
    .then(dispatch)
    .then((outcome) => {
      if (outcome.kind === "dispatched") remember(approvalId, outcome);
      return outcome;
    });
  inFlight.set(approvalId, flight);
  const cleanup = (): void => {
    if (inFlight.get(approvalId) === flight) inFlight.delete(approvalId);
  };
  void flight.then(cleanup, cleanup);
  return flight;
}

/** Test seam: production entries are bounded by `RECENT_RESULT_CAP`. */
export function resetDeskApprovalDispatchesForTests(): void {
  inFlight.clear();
  recent.clear();
}
