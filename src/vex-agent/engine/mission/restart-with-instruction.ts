/**
 * "Tell Vex what to do differently" — restart a mission after a stop.
 *
 * The user stopped a run, then typed what should change. This appends that
 * text as an ordinary operator instruction and prepares a NEW run against the
 * SAME already-accepted contract. `commit-start` already permits a new run
 * once the previous one is terminal, so nothing in the run state machine has
 * to move for this to work.
 *
 * REJECTED ALTERNATIVE: a new non-terminal run status so the stopped run could
 * "resume". Terminal statuses are read by the repo guards, the approval
 * snapshot builder, the lease observer, retry and resume — and terminal rows
 * are deliberately immutable audit history. A new status would have added an
 * arm to every one of those readers to save one row.
 *
 * ORDER IS LOAD-BEARING: the run is claimed BEFORE the instruction is written,
 * so a refused restart leaves the transcript byte-identical. See the comment
 * at the claim site.
 *
 * Shape mirrors `prepareMissionStart`: this function returns once the durable
 * `mission_runs` row exists and the lease is held, and the CALLER dispatches
 * `runPreparedMissionStart` in the background (`dispatchPreparedMission` in
 * the IPC layer). The engine never awaits a whole turn loop on a host command.
 *
 * The contract is NOT re-accepted here and cannot be edited from this path. If
 * the draft drifted since acceptance the restart refuses (`contract_dirty`)
 * and the host routes the user to Review/Edit — starting a run against a
 * contract the user never accepted is exactly the consent bypass acceptance
 * exists to prevent.
 *
 * The instruction is untrusted, model-visible text: sanitised and length
 * capped before it becomes a transcript row, and never interpolated into an
 * engine banner. It lands as a `user` message, which is what it is.
 */

import * as missionsRepo from "../../db/repos/missions.js";
import { addOperatorInstruction } from "../core/operator-instructions.js";
import type { PreparedMissionStart } from "../core/runner/mission-prepare.js";
// STATIC, never `await import(...)`: a rejected runtime load here would skip
// the release entirely and strand the session lease until its TTL with the
// heartbeat still renewing. `release-and-emit-chokepoint.test.ts` enforces
// this at every call site.
import { releaseLeaseAndEmitControlState } from "../runtime/release-and-emit.js";
import logger from "@utils/logger.js";

/**
 * Upper bound on the operator instruction, enforced here even though the IPC
 * schema also bounds it: this is engine-side validation of untrusted input and
 * must not depend on a caller having done its job. Matched to
 * `REJECT_REASON_MAX_LENGTH` — long enough for a paragraph of redirection,
 * short enough that it cannot dominate the prompt.
 */
export const RESTART_INSTRUCTION_MAX_LENGTH = 500;

export interface RestartMissionWithInstructionInput {
  readonly sessionId: string;
  readonly missionId: string;
  readonly instruction: string;
}

export type RestartMissionWithInstructionOutcome =
  /**
   * A durable run row exists and the lease is held. The caller MUST dispatch
   * `runPreparedMissionStart(prepared)`; that call owns the lease release.
   */
  | { readonly outcome: "prepared"; readonly prepared: PreparedMissionStart }
  /** The mission row — or the session row it belongs to — is gone. */
  | { readonly outcome: "mission_not_found" }
  | {
    readonly outcome: "session_mismatch";
    readonly expectedSessionId: string;
  }
  /** Instruction was empty (or only control characters) after sanitisation. */
  | { readonly outcome: "instruction_empty" }
  /** Never accepted, or the draft changed since acceptance → Review/Edit. */
  | {
    readonly outcome: "contract_dirty";
    readonly reason: "not_accepted" | "stale_acceptance" | "plan_not_accepted";
  }
  /** A run is still live — the user must stop it before restarting. */
  | { readonly outcome: "run_active" }
  /** Another runner holds the session lease; transient, retry. */
  | { readonly outcome: "lease_busy" }
  /** Draft is no longer complete, or no provider — host shows the reason. */
  | { readonly outcome: "not_ready" }
  | { readonly outcome: "provider_unavailable" };

/**
 * Normalise the operator instruction before it becomes transcript text.
 *
 * Control characters (newlines included) are collapsed for the same reason
 * `sanitizeRejectReason` collapses them: without it, typed text could forge
 * lines that read like `[Engine: ...]` banners inside a document the agent
 * re-reads every turn.
 */
export function sanitizeRestartInstruction(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .trim()
    .slice(0, RESTART_INSTRUCTION_MAX_LENGTH);
}

export async function restartMissionWithInstruction(
  input: RestartMissionWithInstructionInput,
): Promise<RestartMissionWithInstructionOutcome> {
  const instruction = sanitizeRestartInstruction(input.instruction);
  if (instruction.length === 0) {
    return { outcome: "instruction_empty" };
  }

  const mission = await missionsRepo.getMission(input.missionId);
  if (!mission) return { outcome: "mission_not_found" };
  if (mission.rootSessionId !== input.sessionId) {
    return {
      outcome: "session_mismatch",
      expectedSessionId: mission.rootSessionId,
    };
  }

  // ORDER IS A TRUST BOUNDARY. Claim FIRST, append only under the won claim.
  //
  // The reverse order (append, then gate) shipped briefly and was wrong: the
  // instruction is model-visible text, so a direct renderer call against a
  // mission that was already RUNNING got a refusal back AND still injected an
  // operator instruction into the live run. The caller sees "no"; the agent
  // silently receives new orders. Same hole for a dirty contract, a busy
  // lease, or an unready draft.
  //
  // `prepareMissionStart` is the authoritative gate: acceptance, hash drift,
  // plan acceptance, readiness, no-active-run, and the session lease, all
  // resolved before it returns `prepared`. Past that point the lease is held
  // and the durable run row exists, so the append below cannot race a
  // concurrent run and the new run's first turn is guaranteed to load it —
  // the caller starts the turn loop only after we return.
  const { prepareMissionStart } = await import("../core/runner/mission-prepare.js");
  const prepared = await prepareMissionStart({
    missionId: input.missionId,
    sessionId: input.sessionId,
  });

  if (prepared.outcome === "prepared") {
    try {
      await addOperatorInstruction(input.sessionId, instruction, {
        missionRestart: true,
        missionId: input.missionId,
      });
    } catch (cause) {
      // The claim succeeded but the run would start WITHOUT the redirection
      // the user asked for — i.e. it would do exactly what they just stopped.
      // Refuse to hand the run off, and unwind it through the same path
      // `runPreparedMissionStart` uses for its own throws so the row does not
      // sit `running` with no lease and no loop behind it.
      logger.error("engine.mission.restart_instruction_append_failed", {
        sessionId: input.sessionId,
        missionId: input.missionId,
        runId: prepared.prepared.runId,
        errorClass:
          cause instanceof Error ? cause.constructor.name : typeof cause,
      });
      // The lease release lives in `finally` so a failure inside the finalize
      // (including its dynamic import) can never cost the lease — the same
      // ordering `runPreparedMissionStart` uses.
      try {
        const { finalizeMissionRunError } = await import(
          "../core/runner/mission-finalize.js"
        );
        await finalizeMissionRunError(
          input.missionId,
          prepared.prepared.runId,
          input.sessionId,
          cause,
        );
      } finally {
        await releaseLeaseAndEmitControlState(
          prepared.prepared.sessionLease,
          input.sessionId,
          { missionRunId: prepared.prepared.runId },
        );
      }
      throw cause;
    }
  }

  logger.info("engine.mission.restart_with_instruction", {
    sessionId: input.sessionId,
    missionId: input.missionId,
    outcome: prepared.outcome,
    instructionLength: instruction.length,
  });

  switch (prepared.outcome) {
    case "prepared":
      return { outcome: "prepared", prepared: prepared.prepared };
    case "mission_not_found":
    case "session_not_found":
      return { outcome: "mission_not_found" };
    case "session_mismatch":
      return {
        outcome: "session_mismatch",
        expectedSessionId: prepared.expectedSessionId,
      };
    case "not_accepted":
      return { outcome: "contract_dirty", reason: "not_accepted" };
    case "stale_acceptance":
      return { outcome: "contract_dirty", reason: "stale_acceptance" };
    case "plan_not_accepted":
      return { outcome: "contract_dirty", reason: "plan_not_accepted" };
    case "active_run_exists":
    case "session_has_active_run":
      return { outcome: "run_active" };
    case "lease_busy":
      return { outcome: "lease_busy" };
    case "not_ready":
      return { outcome: "not_ready" };
    case "provider_unavailable":
      return { outcome: "provider_unavailable" };
  }
}
