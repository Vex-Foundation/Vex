/**
 * MISSION CONTRACT REQUEST - the blocked capability raises the contract
 * surface instead of dead-ending on a notice.
 *
 * Modelled on VS Code's workspace-trust request
 * (`src/vs/workbench/services/workspaces/common/workspaceTrust.ts`), where a
 * capability that cannot run (`startDebugging`, task execution) BEGINS by
 * awaiting a trust request rather than reporting a refusal the user cannot act
 * on. Three properties transfer, and one deliberately does not.
 *
 * TRANSFERRED:
 *   1. Single-flight and joinable. A second blocked capability joins the first
 *      request instead of stacking a second surface; both callers settle from
 *      the same decision.
 *   2. Tri-state result: `granted` | `refused` | `cancelled`. Cancellation is a
 *      real third outcome, never a silent `false`.
 *   3. Never resolve ahead of the commit. `granted` is settled ONLY from the
 *      `mission.acceptContract` success path, after the engine reports
 *      `outcome: "accepted"` - the same point VS Code waits for a real state
 *      change via `Event.once` rather than resolving on the button press.
 *
 * NOT TRANSFERRED, and it must never be: workspace trust is a boolean the user
 * flips at will and it then stands. Mission acceptance authorizes real fund
 * movement. This module grants NOTHING. It opens a surface; the acceptance it
 * may lead to still goes through `mission.acceptContract`, still binds to the
 * exact contract hash under review, and is still revalidated at start
 * (`engine/mission/commit-start.ts`). A `granted` result is a REPORT that an
 * acceptance committed, not a permission this module holds, hands on, or can
 * replay. Nothing here may ever be cached, reused across missions, or consulted
 * in place of the engine's own gate.
 *
 * Lifetime: renderer-session ephemeral. Requests are keyed by session and
 * cleared on settle; a pending request whose session is left behind is
 * cancelled by `cancelMissionContractRequest`, which every dismissal path calls.
 */

import { create } from "zustand";

/**
 * Why the contract surface was raised. Purely for the copy shown on the
 * surface - it never widens or narrows what may be accepted.
 */
export type MissionContractRequestReason =
  /** The user asked to see the contract (badge, notice control). */
  | "user"
  /** `mission.start` was refused because the contract is not accepted or not ready. */
  | "start_blocked";

export type MissionContractRequestOutcome =
  /** An acceptance actually committed for this session. */
  | "granted"
  /** The engine refused the acceptance (a non-`accepted` outcome, or a failure). */
  | "refused"
  /** The user dismissed the surface without a decision. */
  | "cancelled";

interface PendingRequest {
  readonly sessionId: string;
  readonly reason: MissionContractRequestReason;
}

interface MissionContractRequestState {
  /** The one in-flight request, or null. Single-flight by construction. */
  readonly pending: PendingRequest | null;
}

export const useMissionContractRequestStore = create<MissionContractRequestState>(
  () => ({ pending: null }),
);

/**
 * Joiners of the CURRENT request. Kept outside the store because resolvers are
 * functions: rule 08 keeps non-serialisable callbacks out of rendered state,
 * and nothing renders from this list.
 */
let joiners: ((outcome: MissionContractRequestOutcome) => void)[] = [];

function settle(outcome: MissionContractRequestOutcome): void {
  const waiting = joiners;
  joiners = [];
  useMissionContractRequestStore.setState({ pending: null });
  for (const resolve of waiting) resolve(outcome);
}

/**
 * Raise the mission contract surface and wait for the decision.
 *
 * Single-flight: a request while one is pending for the SAME session joins it
 * and settles together. A request for a DIFFERENT session cancels the stale one
 * first - its surface is no longer reachable, so leaving its callers hanging
 * would be a leak, and reporting anything but `cancelled` would be a lie.
 *
 * The caller must open the surface itself (the modal lives in `MissionRail`,
 * driven by `uiStore.reviewModal`); this owns only the request's lifetime and
 * its outcome.
 */
export function requestMissionContract(input: {
  readonly sessionId: string;
  readonly reason: MissionContractRequestReason;
}): Promise<MissionContractRequestOutcome> {
  const { pending } = useMissionContractRequestStore.getState();
  if (pending !== null && pending.sessionId !== input.sessionId) {
    settle("cancelled");
  } else if (pending !== null) {
    // Join: same session, same surface, one decision for both callers.
    return new Promise((resolve) => {
      joiners.push(resolve);
    });
  }
  useMissionContractRequestStore.setState({
    pending: { sessionId: input.sessionId, reason: input.reason },
  });
  return new Promise((resolve) => {
    joiners.push(resolve);
  });
}

/**
 * Report that an acceptance COMMITTED for this session. Call only from the
 * `mission.acceptContract` success path with `outcome === "accepted"` - never
 * from the button press, never optimistically.
 */
export function grantMissionContractRequest(sessionId: string): void {
  const { pending } = useMissionContractRequestStore.getState();
  if (pending === null || pending.sessionId !== sessionId) return;
  settle("granted");
}

/** The engine refused the acceptance, or the accept call failed. */
export function refuseMissionContractRequest(sessionId: string): void {
  const { pending } = useMissionContractRequestStore.getState();
  if (pending === null || pending.sessionId !== sessionId) return;
  settle("refused");
}

/**
 * The surface was dismissed without a decision (Escape, backdrop, badge
 * toggle-closed, unmount). Idempotent: a second call after settle is a no-op.
 */
export function cancelMissionContractRequest(sessionId?: string): void {
  const { pending } = useMissionContractRequestStore.getState();
  if (pending === null) return;
  if (sessionId !== undefined && pending.sessionId !== sessionId) return;
  settle("cancelled");
}

/** Test seam: drop any pending request without resolving observers twice. */
export function resetMissionContractRequests(): void {
  if (useMissionContractRequestStore.getState().pending !== null) {
    settle("cancelled");
  }
  joiners = [];
}
