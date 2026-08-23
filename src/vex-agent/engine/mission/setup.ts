/**
 * Mission setup — guided conversation handler for drafting missions.
 *
 * Flow:
 * 1. Load or create mission draft
 * 2. Parse model response into patch (safe boundary)
 * 3. Convert domain → row, update DB
 * 4. Validate draft → report missing fields
 * 5. If valid → set status ready
 */

import type { MissionDraft } from "../types.js";
import { extractMissionPatch, sanitizePatch } from "./patch-parser.js";
import { domainToRow, missionToDraft } from "./mapper.js";
import { validateDraft } from "./validator.js";
import { assessMissionMeasurability } from "./measurability.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import type { Mission } from "@vex-agent/db/repos/missions.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { emitMissionUpdate } from "../runtime/mission-bus.js";

export interface SetupResult {
  missionId: string;
  status: string;
  currentDraft: Partial<MissionDraft>;
  missingFields: string[];
  ready: boolean;
  /**
   * Model-facing measurability advisories (see `measurability.ts`). Never a
   * refusal and never part of the host-facing `data` block: these exist to make
   * the model fix an undecidable success criterion while the draft is still
   * being written.
   */
  warnings: string[];
  /**
   * Whether THIS call actually wrote draft fields. False for a read
   * (`getMissionSetupState`), for a fresh empty draft, and - the case that
   * matters - for a setup turn whose model output carried no applicable patch.
   *
   * `applyMissionPatch` emits a `mission_update` only when something changed, so
   * without this flag a setup turn that produced nothing is indistinguishable
   * from one that is progressing. `core/runner/setup-turn.ts` reads it to emit
   * the `setup_no_progress` signal the host UI needs to tell "still drafting"
   * from "drafting stalled".
   */
  draftWasWritten: boolean;
}

/**
 * MISSION SETUP STATE MACHINE (host-visible; see also `MissionControls.tsx`,
 * which renders exactly these states and no others).
 *
 *   absent ──(first mission turn)──> drafting
 *
 *   drafting          the row exists, `missingFields` is non-empty, status
 *                     `draft`. Only the model can leave this state, by calling
 *                     `MissionDraftUpdate`; `mission.updateDraft` is a stub, so
 *                     the host CANNOT fill these fields itself.
 *     ├─(setup turn wrote a patch, still incomplete)──> drafting
 *     ├─(setup turn wrote NO patch)─────────────────> drafting-stalled
 *     └─(patch completed every required field)──────> ready
 *
 *   drafting-stalled  a setup turn ended without touching the draft. The row is
 *                     unchanged and nothing will change it unless the user
 *                     speaks again. Escapes: ask again (a new setup turn) or
 *                     stop the mission. NOT an error state - the model may
 *                     simply have asked a clarifying question.
 *     └─(any later turn writes a patch)─────────────> drafting | ready
 *
 *   ready             every required field present, status `ready`. The host
 *                     may now accept the contract.
 *     ├─(host accepts)──────────────────────────────> accepted
 *     └─(a later patch clears a field)──────────────> drafting
 *
 *   accepted          `accepted_contract_hash` set and matching the current
 *                     contract. Start is live. Any contract-field edit clears
 *                     acceptance and returns to `ready` (dirty).
 *
 * Transitions are decided HERE and reported over `mission_update`; the renderer
 * never infers a transition from prose.
 */

// Detects prose that implies the mission can start while the DB draft is not
// ready. Slash commands were removed (host now starts via the Start mission
// button), so this keys off the start ACTION ("start the mission" / "Start
// mission button") plus explicit readiness claims — not a typed command.
const START_SUGGESTION_PATTERN =
  /(?:start(?:ing)?\s+(?:the\s+)?mission|ready\s+to\s+start|mission\s+is\s+ready|all\s+required\s+fields|ready\s*=\s*true)/i;

export function textSuggestsMissionStart(text: string | null): boolean {
  if (!text) return false;
  return START_SUGGESTION_PATTERN.test(text);
}

export function formatMissingMissionFields(missingFields: readonly string[]): string {
  return missingFields.length > 0 ? missingFields.join(", ") : "none reported";
}

export function formatMissionDraftNotReadyNotice(setup: SetupResult): string {
  return [
    "Mission draft is not ready in the database.",
    `DB status: ${setup.status}. Missing fields: ${formatMissingMissionFields(setup.missingFields)}.`,
    "The model must save the complete draft with MissionDraftUpdate before telling the user they can start the mission.",
  ].join(" ");
}

/**
 * Create a new mission draft for a session.
 */
export async function createMissionDraft(sessionId: string): Promise<SetupResult> {
  const missionId = `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await missionsRepo.createDraft(missionId, sessionId);

  return {
    missionId,
    status: "draft",
    currentDraft: {},
    missingFields: [
      "title", "goal", "capitalSource", "startingCapital",
      "allowedWallets", "allowedChains", "allowedProtocols",
      "riskProfile", "successCriteria", "stopConditions",
    ],
    ready: false,
    warnings: [],
    draftWasWritten: false,
  };
}

/**
 * Apply a model-produced patch to an existing mission draft.
 *
 * Safe pipeline: extractMissionPatch(unknown) → sanitizePatch()
 * → Partial<MissionDraft> → domainToRow() → repo.updateDraft()
 */
export async function applyMissionPatch(
  missionId: string,
  rawModelOutput: unknown,
): Promise<SetupResult> {
  // Early existence guard — preserves the "not found" contract for the
  // no-write path (the model can send an empty/no-op patch).
  const existing = await missionsRepo.getMission(missionId);
  if (!existing) throw new Error(`Mission ${missionId} not found`);

  // Parse + sanitize (safe boundary).
  // Puzzle 04: model can no longer set `stopConditionsAccepted` — patch
  // parser drops it. Acceptance is host-only via `mission.acceptContract`
  // and lives on `missions.accepted_contract_hash` (mig 023).
  let draftWasWritten = false;
  const extracted = extractMissionPatch(rawModelOutput);
  if (extracted) {
    const sanitized = sanitizePatch(extracted);
    if (Object.keys(sanitized).length > 0) {
      draftWasWritten = true;
      const rowPatch = domainToRow(sanitized);

      // Phase 4d-5: read-merge-write the JSONB partial-update fields under a
      // row lock so a concurrent host write (mission.setAutoRetry merging
      // `autoRetryEnabled` into constraints_json) is not lost to a stale
      // in-memory merge. Both writers serialize on the missions row lock;
      // the merge runs against the FRESH locked row, never a pre-tx snapshot.
      await withTransaction(async (client) => {
        const locked = await missionsRepo.getMissionForUpdate(client, missionId);
        if (!locked) {
          throw new Error(`Mission ${missionId} disappeared before update`);
        }
        // Merge JSONB blobs with existing to avoid losing fields on a
        // partial update.
        if (rowPatch.capital_source_json && locked.capitalSourceJson) {
          rowPatch.capital_source_json = {
            ...locked.capitalSourceJson,
            ...rowPatch.capital_source_json,
          };
        }
        if (rowPatch.constraints_json && locked.constraintsJson) {
          rowPatch.constraints_json = {
            ...locked.constraintsJson,
            ...rowPatch.constraints_json,
          };
        }

        await missionsRepo.updateDraft(missionId, rowPatch, client);
        // Any mission-contract field mutation invalidates prior acceptance —
        // an edited draft's canonical hash no longer matches the accepted one,
        // so it must go back through Accept contract before it can start.
        if (locked.acceptedContractHash !== null) {
          await missionsRepo.clearAcceptance(client, missionId);
        }
      });
    }
  }

  // Re-load after update
  const updated = await missionsRepo.getMission(missionId);
  if (!updated) throw new Error(`Mission ${missionId} disappeared after update`);

  // Validate
  const validation = validateDraft(updated);

  // Keep status aligned with validation. Edits can clear a previously-ready
  // field, so a ready draft must fall back to draft until complete again.
  let status = updated.status;
  let readinessChanged = false;
  if (validation.valid && updated.status === "draft") {
    await missionsRepo.setStatus(missionId, "ready");
    status = "ready";
    readinessChanged = true;
  } else if (!validation.valid && updated.status === "ready") {
    await missionsRepo.setStatus(missionId, "draft");
    status = "draft";
    readinessChanged = true;
  }

  // Emit-after-commit: every write above has resolved, so a subscriber that
  // refetches on this signal is guaranteed to see the row we just wrote. A
  // no-op patch (model sent nothing applicable, readiness unchanged) emits
  // nothing — an event that implies a change nobody made is noise the
  // renderer would pay a refetch for.
  if (readinessChanged || draftWasWritten) {
    emitMissionUpdate({
      sessionId: updated.rootSessionId,
      missionId,
      kind: readinessChanged ? "readiness_changed" : "draft_updated",
    });
  }

  const currentDraft = missionToDraft(updated);

  return {
    missionId,
    status,
    currentDraft,
    missingFields: validation.missing,
    ready: validation.valid,
    warnings: assessMissionMeasurability(currentDraft).map((w) => w.message),
    draftWasWritten,
  };
}

/**
 * Get current setup state for a mission.
 */
export async function getMissionSetupState(missionId: string): Promise<SetupResult | null> {
  const mission = await missionsRepo.getMission(missionId);
  if (!mission) return null;

  const validation = validateDraft(mission);
  const currentDraft = missionToDraft(mission);

  return {
    missionId,
    status: mission.status,
    currentDraft,
    missingFields: validation.missing,
    ready: validation.valid,
    warnings: assessMissionMeasurability(currentDraft).map((w) => w.message),
    // A read never writes.
    draftWasWritten: false,
  };
}
