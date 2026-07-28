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
 *   - flip run → running
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
import type { PreparedMissionStart } from "./mission-prepare.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";
import type { Permission } from "../../types.js";
import logger from "@utils/logger.js";
import {
  isRunnerLeaseLostError,
  throwIfRunnerLeaseLost,
} from "../../runtime/lease-loss.js";

type Provider = NonNullable<Awaited<ReturnType<typeof resolveProvider>>>;
type ProviderConfig = NonNullable<
  Awaited<ReturnType<Provider["loadConfig"]>>
>;

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
      }),
    );

    const loopConfig: TurnLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      contextLimit: prepared.config.contextLimit,
      baseVisibility,
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
      controller.signal,
      undefined,
      prepared.sessionLease.signal,
    );

    throwIfRunnerLeaseLost(prepared.sessionLease.signal);

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
    if (isRunnerLeaseLostError(err)) {
      logger.info("engine.mission.stale_runner_exited", {
        runId: prepared.runId,
        sessionId: prepared.sessionId,
      });
      throw err;
    }
    await finalizeMissionRunError(
      prepared.missionId,
      prepared.runId,
      prepared.sessionId,
      err,
    );
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
  }
}

// ── resumePreparedMissionRun ────────────────────────────────────

export interface PreparedResumeRun {
  readonly runId: string;
  readonly run: MissionRun;
  readonly mission: Mission;
  readonly provider: Provider;
  readonly config: ProviderConfig;
  readonly leaseSignal?: AbortSignal;
}

export async function resumePreparedMissionRun(
  prepared: PreparedResumeRun,
): Promise<TurnResult> {
  const controller = registerMissionRunAbortController(prepared.runId);
  try {
    await missionRunsRepo.updateStatus(prepared.runId, "running");

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
      }),
    );

    const loopConfig: TurnLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      contextLimit: prepared.config.contextLimit,
      baseVisibility,
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
      controller.signal,
      undefined,
      prepared.leaseSignal,
    );

    throwIfRunnerLeaseLost(prepared.leaseSignal);

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
    if (isRunnerLeaseLostError(err)) {
      logger.info("engine.mission.stale_runner_exited", {
        runId: prepared.runId,
        sessionId: prepared.run.sessionId,
      });
      throw err;
    }
    await finalizeMissionRunError(
      prepared.run.missionId,
      prepared.runId,
      prepared.run.sessionId,
      err,
    );
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
