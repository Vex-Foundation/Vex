/**
 * Long-running mission run bodies. Both functions assume their
 * dependencies were resolved by a `prepareMission*` helper and run
 * inside the protected try/finally so any throw lands the run in a
 * `paused_error` / `failed` terminal status via
 * `finalizeMissionRunError`.
 *
 * `runPreparedMissionStart`:
 *   - activation message
 *   - hydrate session
 *   - build tools
 *   - runTurnLoop
 *   - finalize status
 *   - lease release in finally
 *
 * `resumePreparedMissionRun`:
 *   - flip run → running (terminal-guarded CAS; refuses a stopped run)
 *   - hydrate
 *   - runTurnLoop with iteration counter snapshot
 *   - finalize status
 *
 * No fallible pre-flight read here — provider/config/run/mission/
 * permission must all be in the prepared context. That's the puzzle-04
 * phase-6 codex requirement: after `dispatched`, NO read that could
 * orphan a `running` mission_runs row.
 */

import {
  MissionRunPausedError,
  type TurnResult,
} from "../../types.js";
import { hydrateEngineSession } from "../hydrate.js";
import type { TurnLoopConfig } from "../turn-loop.js";
import { runTurnLoop } from "../turn-loop.js";
import {
  type MissionRunContractSnapshot,
  resolveMissionPromptContext,
} from "../../mission/run-contract.js";
import { resolveFrozenDeadlineMs } from "../../mission/mission-deadline.js";
import type { PromptStackOptions } from "../../prompts/index.js";
import { getOpenAITools, type ToolVisibilityBase } from "@vex-agent/tools/registry.js";
import {
  computeBand,
} from "../context-band.js";
import type { resolveProvider } from "@vex-agent/inference/registry.js";
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import type { Mission } from "@vex-agent/db/repos/missions.js";
import type { MissionRun } from "@vex-agent/db/repos/mission-runs.js";

import {
  finalizeMissionRunError,
  finalizeMissionRunStatus,
} from "./mission-finalize.js";
import {
  registerMissionRunAbortController,
  unregisterMissionRunAbortController,
} from "./abort.js";
import { toToolDefinitions, DEFAULT_LOOP_CONFIG } from "./shared.js";
import { maxIterationsForPermission } from "./iteration-budget.js";
import type { PreparedMissionStart } from "./mission-prepare.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";
import type { Permission } from "../../types.js";
import logger from "@utils/logger.js";

type Provider = NonNullable<Awaited<ReturnType<typeof resolveProvider>>>;
type ProviderConfig = NonNullable<
  Awaited<ReturnType<Provider["loadConfig"]>>
>;

/**
 * An operator Stop outranks a throw raised while the loop unwinds.
 *
 * When the run's `AbortController` has already fired, the user asked for the
 * run to end. If persisting the aborted turn (or anything else on the way out)
 * then throws, routing that through `finalizeMissionRunError` would park the
 * run in `paused_error` — a recoverable-looking state the operator never asked
 * for — AND leave the durable `stop_terminal` request pending forever, because
 * the loop that would have observed it is gone. That is the stranded stop
 * Codex flagged.
 *
 * So: run the SAME idempotent stop transaction every other stop path runs. It
 * lands the canonical terminal state (`stopped` / `user_stopped`, mission
 * `cancelled`), rejects pending approvals, cancels wakes, releases the lease
 * and consumes this run's stop request. Idempotent — a no-op if the observer
 * already applied it, and a no-op on an already-terminal run (e.g. the
 * stop-for-edit path, which owns its own `draft` mission state).
 *
 * The original error is still logged and still re-thrown by the caller; only
 * the persisted RUN STATE changes.
 */
async function finalizeUserStopAfterThrow(args: {
  readonly sessionId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly err: unknown;
}): Promise<void> {
  logger.error("engine.mission.throw_during_operator_stop", {
    runId: args.runId,
    missionId: args.missionId,
    sessionId: args.sessionId,
    errorClass:
      args.err instanceof Error ? args.err.constructor.name : typeof args.err,
  });
  try {
    const { applyUserStopTransaction } = await import(
      "../../runtime/lease-and-status.js"
    );
    await applyUserStopTransaction({
      sessionId: args.sessionId,
      missionRunId: args.runId,
    });
  } catch (stopErr) {
    // The stop write itself failed. Do NOT fall back to error finalization —
    // that would write the state we just decided is wrong. The durable
    // control request stays pending, which is the recoverable outcome: the
    // direct-abort path re-applies it.
    logger.error("engine.mission.operator_stop_finalize_failed", {
      runId: args.runId,
      sessionId: args.sessionId,
      errorClass:
        stopErr instanceof Error ? stopErr.constructor.name : typeof stopErr,
    });
  }
}

/** Epoch ms -> ISO string for the agent-facing Runtime Clock, or null. */
function deadlineMsToIso(deadlineMs: number | null | undefined): string | null {
  return deadlineMs != null ? new Date(deadlineMs).toISOString() : null;
}

// ── runPreparedMissionStart ─────────────────────────────────────

interface MissionActivationMessageInput {
  readonly sessionId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly permission: Permission;
}

async function addMissionActivationMessage(
  input: MissionActivationMessageInput,
): Promise<void> {
  const content = [
    "[Engine: mission_started — The operator accepted the mission draft and started the run from the host UI.",
    "You are now inside an active mission run.",
    "Do not ask the operator to start or continue the mission again.",
    "Treat earlier setup messages asking the operator to start the mission as historical context only.",
    "Execute the frozen Mission Contract now.]",
  ].join(" ");

  await appendEngineMessage(input.sessionId, content, {
    source: "engine",
    messageType: "mission_started",
    visibility: "internal",
    payload: {
      missionId: input.missionId,
      runId: input.runId,
      permission: input.permission,
    },
  });
}

export async function runPreparedMissionStart(
  prepared: PreparedMissionStart,
): Promise<TurnResult> {
  const controller = registerMissionRunAbortController(prepared.runId);
  try {
    await addMissionActivationMessage({
      sessionId: prepared.sessionId,
      missionId: prepared.missionId,
      runId: prepared.runId,
      permission: prepared.permission,
    });

    const hydrated = await hydrateEngineSession(prepared.sessionId);
    if (!hydrated) throw new Error(`Session ${prepared.sessionId} not found`);

    const promptOptions: PromptStackOptions = {
      missionRunContext: {
        missionPromptContext: prepared.contractSnapshot.missionPromptContext,
        iterationCount: 0,
      },
    };

    const baseVisibility: ToolVisibilityBase = {
      sessionId: prepared.sessionId,
      permission: prepared.permission,
      sessionKind: "mission",
      missionRunActive: true,
      planMode: hydrated.context.planMode ?? false,
    };
    // Seed tools — overridden per turn by buildTurnPromptStack with the live
    // band + `hasSessionMemory`.
    const tools = toToolDefinitions(
      getOpenAITools({
        ...baseVisibility,
        contextUsageBand: computeBand(hydrated.tokenCount, prepared.config.contextLimit),
        hasSessionMemory: false,
        // Compaction axes are FALSE here by design: this is the runner's
        // pre-loop bootstrap tools array, built before any per-turn preparation
        // read exists. The loop rebuilds the surface every iteration from the
        // real state (`buildTurnPromptStack`), so the conservative answer costs
        // at most one turn without the bypass, while guessing could open it.
        preparationBypassesBarrier: false,
        hasCompactionSummaryReady: false,
      }),
    );

    const loopConfig: TurnLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      // Permission-aware per-turn iteration budget — see `iteration-budget.ts`.
      // A Full-Autonomous MISSION gets the same generous budget as a
      // Full-Autonomous agent session (owner decision 2026-07-29); a restricted
      // mission is byte-identical to before (`DEFAULT_LOOP_CONFIG`'s 50).
      maxIterations: maxIterationsForPermission(prepared.permission),
      contextLimit: prepared.config.contextLimit,
      baseVisibility,
    // The lease this runner actually holds. Threaded so the compaction-apply
    // boundary action can PROVE ownership (equality against the live lease)
    // rather than adopting whatever owner the row currently names.
      runnerOwnerId: prepared.sessionLease.ownerId,
      // Deadline from FROZEN inputs (run started_at + snapshot durationMinutes),
      // never the live mission row — see mission-deadline.ts.
      missionDeadlineMs: resolveFrozenDeadlineMs(
        hydrated.context.missionRunStartedAt,
        prepared.contractSnapshot,
      ),
    };

    const result = await runTurnLoop(
      {
        ...hydrated.context,
        missionRunId: prepared.runId,
        sessionKind: "mission",
        missionDeadline: deadlineMsToIso(loopConfig.missionDeadlineMs) ?? hydrated.context.missionDeadline ?? null,
      },
      hydrated.messages,
      hydrated.summary,
      hydrated.tokenCount,
      prepared.provider,
      prepared.config,
      tools,
      loopConfig,
      promptOptions,
      // The operator Stop signal is threaded into BOTH the tool-call
      // iteration boundary (pos 10 `abortSignal`) AND the in-flight inference
      // stream (pos 11 `inferenceAbortSignal`) — same shape as
      // `setup-turn.ts`. Without pos 11 a Stop could not cancel a live
      // provider call and the run kept generating until the call finished.
      // Partial assistant text is persisted as a stopped row by the existing
      // `turnResult.inferenceAborted` branch in `turn-loop.ts`; nothing on
      // the mission-run path parses that text (mission patches only come from
      // the `mission_draft_update` tool or the setup turn), so no
      // `user_stopped` text guard is needed here.
      controller.signal, // abortSignal
      controller.signal, // inferenceAbortSignal
    );

    const missionStatus = await finalizeMissionRunStatus(
      prepared.missionId,
      prepared.runId,
      prepared.sessionId,
      result.stopReason,
      result.stopPayload,
    );

    return {
      text: result.text,
      toolCallsMade: result.toolCallsMade,
      pendingApprovals: result.pendingApprovals,
      stopReason: result.stopReason,
      missionStatus,
    };
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      await finalizeUserStopAfterThrow({
        sessionId: prepared.sessionId,
        missionId: prepared.missionId,
        runId: prepared.runId,
        err,
      });
    } else {
      await finalizeMissionRunError(
        prepared.missionId,
        prepared.runId,
        prepared.sessionId,
        err,
      );
    }
    throw new MissionRunPausedError({
      runId: prepared.runId,
      missionId: prepared.missionId,
      sessionId: prepared.sessionId,
      cause: err,
    });
  } finally {
    unregisterMissionRunAbortController(prepared.runId);
    await releaseLeaseAndEmitControlState(
      prepared.sessionLease,
      prepared.sessionId,
      { missionRunId: prepared.runId },
    );
    // The end-of-turn resume hook fires inside the helper above, strictly
    // after the release. See `end-of-turn-resume-hook.ts`.
  }
}

// ── resumePreparedMissionRun ────────────────────────────────────

export interface PreparedResumeRun {
  readonly runId: string;
  /**
   * The session/run lease owner id the CALLER claimed and holds for the whole
   * resume. Required, exactly like a mission START threads
   * `prepared.sessionLease.ownerId`: the resumed turn loop can only force a
   * prepared compaction apply by proving ownership by equality against the live
   * lease, and every resume entry point (wake, auto-retry, approval
   * continuation, ingress preempt, IPC resume/retry, recover) does hold one.
   */
  readonly runnerOwnerId: string;
  readonly run: MissionRun;
  readonly mission: Mission;
  readonly provider: Provider;
  readonly config: ProviderConfig;
}

export async function resumePreparedMissionRun(
  prepared: PreparedResumeRun,
): Promise<TurnResult> {
  const controller = registerMissionRunAbortController(prepared.runId);
  try {
    // GUARDED flip, not `updateStatus`. `resumeMissionRun` checks the run is
    // non-terminal at the TOP of the function, then awaits a provider resolve,
    // a config load and a mission read before reaching here — a check-then-act
    // window an operator Stop can land inside. An unconditional flip would
    // re-open the stopped run, clear the stop evidence the user's Stop wrote,
    // and then run a whole turn on it. The CAS makes the refusal authoritative.
    const started = await missionRunsRepo.startRunIfNotTerminal(prepared.runId);
    if (!started) {
      throw new Error(
        `Run ${prepared.runId} reached a terminal status before the resume could start — refusing to re-open it`,
      );
    }

    const hydrated = await hydrateEngineSession(prepared.run.sessionId);
    if (!hydrated) {
      throw new Error(`Session ${prepared.run.sessionId} not found`);
    }
    // Permission read from hydrated context — keeps the fallible
    // permission lookup INSIDE the protected try so a failure lands
    // the run in `paused_error` via `finalizeMissionRunError` instead
    // of leaving it orphaned at `running`.
    const permission: Permission = hydrated.context.sessionPermission;

    const missionPromptContext = resolveMissionPromptContext({
      snapshot:
        prepared.run.contractSnapshotJson as MissionRunContractSnapshot | null,
      fallbackMission: prepared.mission,
    });
    const promptOptions: PromptStackOptions = {
      missionRunContext: {
        missionPromptContext,
        iterationCount: prepared.run.iterationCount,
      },
    };

    const baseVisibility: ToolVisibilityBase = {
      sessionId: prepared.run.sessionId,
      permission,
      sessionKind: "mission",
      missionRunActive: true,
      planMode: hydrated.context.planMode ?? false,
    };
    // Seed tools — overridden per turn by buildTurnPromptStack with the live
    // band + `hasSessionMemory`.
    const tools = toToolDefinitions(
      getOpenAITools({
        ...baseVisibility,
        contextUsageBand: computeBand(hydrated.tokenCount, prepared.config.contextLimit),
        hasSessionMemory: false,
        // Compaction axes are FALSE here by design: this is the runner's
        // pre-loop bootstrap tools array, built before any per-turn preparation
        // read exists. The loop rebuilds the surface every iteration from the
        // real state (`buildTurnPromptStack`), so the conservative answer costs
        // at most one turn without the bypass, while guessing could open it.
        preparationBypassesBarrier: false,
        hasCompactionSummaryReady: false,
      }),
    );

    const loopConfig: TurnLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      // Permission-aware per-turn iteration budget — see `iteration-budget.ts`.
      // Same rule on resume as on start; a resumed slice must not silently get
      // a different budget from the one the run started with.
      maxIterations: maxIterationsForPermission(permission),
      contextLimit: prepared.config.contextLimit,
      baseVisibility,
      // The lease this resume actually runs under — same contract as a mission
      // start above, so a resumed slice can consume a prepared cutover too.
      runnerOwnerId: prepared.runnerOwnerId,
      // Deadline from FROZEN inputs (run started_at + the SAME snapshot the run
      // was committed with), so a wake/resume re-derives the identical box —
      // never the live mission row. See mission-deadline.ts.
      missionDeadlineMs: resolveFrozenDeadlineMs(
        hydrated.context.missionRunStartedAt,
        prepared.run.contractSnapshotJson,
      ),
    };

    const result = await runTurnLoop(
      {
        ...hydrated.context,
        missionRunId: prepared.runId,
        sessionKind: "mission",
        missionDeadline: deadlineMsToIso(loopConfig.missionDeadlineMs) ?? hydrated.context.missionDeadline ?? null,
      },
      hydrated.messages,
      hydrated.summary,
      hydrated.tokenCount,
      prepared.provider,
      prepared.config,
      tools,
      loopConfig,
      promptOptions,
      // Dual-signal Stop — see the rationale at the `runPreparedMissionStart`
      // call site above.
      controller.signal, // abortSignal
      controller.signal, // inferenceAbortSignal
    );

    const missionStatus = await finalizeMissionRunStatus(
      prepared.run.missionId,
      prepared.runId,
      prepared.run.sessionId,
      result.stopReason,
      result.stopPayload,
    );

    return {
      text: result.text,
      toolCallsMade: result.toolCallsMade,
      pendingApprovals: result.pendingApprovals,
      stopReason: result.stopReason,
      missionStatus,
    };
  } catch (err: unknown) {
    // Same operator-Stop-outranks-a-throw rule as `runPreparedMissionStart`.
    if (controller.signal.aborted) {
      await finalizeUserStopAfterThrow({
        sessionId: prepared.run.sessionId,
        missionId: prepared.run.missionId,
        runId: prepared.runId,
        err,
      });
    } else {
      await finalizeMissionRunError(
        prepared.run.missionId,
        prepared.runId,
        prepared.run.sessionId,
        err,
      );
    }
    throw new MissionRunPausedError({
      runId: prepared.runId,
      missionId: prepared.run.missionId,
      sessionId: prepared.run.sessionId,
      cause: err,
    });
  } finally {
    unregisterMissionRunAbortController(prepared.runId);
  }
}
