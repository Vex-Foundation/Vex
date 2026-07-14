/**
 * `getContractStatus` — read-only mission contract status for
 * `mission.getDiff` IPC handler (puzzle 04 phase 6).
 *
 * Computes the current canonical contract hash from the mission row,
 * compares it against the accepted hash (if any), and returns a
 * structured status that the renderer's MissionContractCard can
 * consume:
 *
 *   - `currentHash` — sha-256 of canonical contract material now
 *   - `acceptedHash` — value of `accepted_contract_hash` (or null)
 *   - `isAccepted` — accepted + version matches + hashes match
 *   - `isDirty` — accepted is set but currentHash drifted from it
 *
 * Plain (non-locked) read per codex review: this is informational
 * only; the row lock at `commitMissionStart` is the atomic source of
 * truth for start-time acceptance.
 *
 * Session ownership check returned via discriminated union so the
 * renderer cannot phish another session's contract status by spoofing
 * `missionId`.
 */

import { getMission } from "../../db/repos/missions.js";

import {
  CONTRACT_HASH_VERSION,
  LEGACY_CONTRACT_HASH_VERSION,
  computeContractHash,
} from "./contract-hash.js";
import { missionToDraft } from "./mapper.js";

export interface GetContractStatusInput {
  readonly sessionId: string;
  readonly missionId: string;
}

export type GetContractStatusOutcome =
  | {
    readonly outcome: "ready";
    readonly missionId: string;
    readonly sessionId: string;
    readonly currentHash: string;
    readonly contractHashVersion: number;
    readonly acceptedHash: string | null;
    readonly acceptedAt: string | null;
    readonly acceptedBy: string | null;
    readonly acceptedContractHashVersion: number | null;
    /** Accepted + version matches + hashes equal. */
    readonly isAccepted: boolean;
    /** Accepted but draft has drifted since (start would be rejected). */
    readonly isDirty: boolean;
  }
  | { readonly outcome: "mission_not_found" }
  | {
    readonly outcome: "session_mismatch";
    readonly expectedSessionId: string;
  };

export async function getContractStatus(
  input: GetContractStatusInput,
): Promise<GetContractStatusOutcome> {
  const mission = await getMission(input.missionId);
  if (!mission) return { outcome: "mission_not_found" };
  if (mission.rootSessionId !== input.sessionId) {
    return {
      outcome: "session_mismatch",
      expectedSessionId: mission.rootSessionId,
    };
  }

  const acceptedHash = mission.acceptedContractHash;
  const acceptedVersion = mission.contractHashVersion;
  const acceptedVersionKnown = acceptedVersion === LEGACY_CONTRACT_HASH_VERSION || acceptedVersion === CONTRACT_HASH_VERSION;
  const currentHash = computeContractHash(
    missionToDraft(mission),
    acceptedVersionKnown ? acceptedVersion : CONTRACT_HASH_VERSION,
  );
  const versionOk = acceptedVersionKnown;
  const isAccepted = acceptedHash !== null
    && versionOk
    && currentHash === acceptedHash;
  const isDirty = acceptedHash !== null && !isAccepted;

  return {
    outcome: "ready",
    missionId: input.missionId,
    sessionId: input.sessionId,
    currentHash,
    contractHashVersion: acceptedVersionKnown ? acceptedVersion : CONTRACT_HASH_VERSION,
    acceptedHash,
    acceptedAt: mission.acceptedContractAt,
    acceptedBy: mission.acceptedContractBy,
    acceptedContractHashVersion: acceptedVersion,
    isAccepted,
    isDirty,
  };
}
