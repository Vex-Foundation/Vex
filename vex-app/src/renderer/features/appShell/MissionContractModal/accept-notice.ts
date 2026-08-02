/**
 * Turning a `mission.acceptContract` attempt into user-facing copy.
 *
 * Moved out of `MissionContractModal.tsx` unchanged.
 */

import { assertNever, type Result } from "@shared/ipc/result.js";
import type { MissionAcceptContractResult } from "@shared/schemas/mission.js";

export function readAcceptOutcome(
  data: Result<MissionAcceptContractResult> | undefined,
): MissionAcceptContractResult["outcome"] | null {
  if (!data || !data.ok) return null;
  return data.data.outcome;
}

/**
 * Two failure surfaces feed this:
 *   - a resolved non-success `outcome` (handled IPC Result — the mutation
 *     "succeeded" at the transport level but the engine refused), and
 *   - a thrown/rejected mutation (`isError` — transport/IPC failure, where
 *     `accept.data` is absent).
 *
 * `plan_stale` / `plan_missing` keep their specific recovery copy; every other
 * non-success outcome maps to a generic "Couldn't accept: <reason>" so the user
 * never clicks Accept and sees nothing (the silent-failure bug). `accepted`
 * returns null (the diff query refetch reflects success).
 */
export function acceptNoticeFor(
  outcome: MissionAcceptContractResult["outcome"] | null,
  isError: boolean,
): string | null {
  if (outcome !== null) return outcomeNotice(outcome);
  // No resolved outcome but the mutation rejected → transport/IPC failure.
  if (isError) {
    return "Couldn't accept the contract — something went wrong. Try again.";
  }
  return null;
}

function outcomeNotice(
  outcome: MissionAcceptContractResult["outcome"],
): string | null {
  switch (outcome) {
    case "accepted":
      return null;
    case "plan_stale":
      return "Plan changed — review again before accepting.";
    case "plan_missing":
      return "No plan authored yet — ask Vex to write a plan first.";
    case "mission_not_found":
      return "Couldn't accept: this mission no longer exists. Refresh and try again.";
    case "session_mismatch":
      return "Couldn't accept: this contract belongs to a different session.";
    case "hash_mismatch":
      return "Couldn't accept: the contract changed since you reviewed it. Review the current contract and accept again.";
    case "status_blocked":
      return "Couldn't accept: this mission can no longer be accepted in its current state.";
    case "run_active":
      return "Couldn't accept: a run is already active for this mission.";
    default:
      return assertNever(outcome);
  }
}
