/**
 * Direct tool invocation — bypasses the LLM. Used by power-user / debug
 * surfaces (the local operator shell — "shell settings panel") to exercise a
 * handler with explicit args.
 *
 * Builds a minimal but real `InternalToolContext` from the session row + any
 * active mission run, then calls `dispatchTool`. The result is a normal
 * `ToolResult` — no approval queue, no turn-loop deferred save. Caller
 * decides whether to persist to `messages`.
 *
 * **Security — OPERATOR / LOCAL-SHELL ONLY. Do NOT wire to vex-app.**
 *
 * This context is built with `approved: true`, which makes `runTool` the
 * ONE path that BYPASSES the approval gate: mutating tools run immediately
 * without an approval card, even under a `restricted` session. That is a
 * deliberate operator escape hatch for the local agent shell, where the
 * human at the keyboard *is* the operator and the invocation already carries
 * explicit privileged intent.
 *
 * Because it skips approval, exposing `runTool` through any vex-app surface
 * (IPC handler, preload bridge, or renderer) is FORBIDDEN. The renderer is
 * untrusted UI; reaching `runTool` from it would let untrusted input execute
 * mutating tools with the approval gate already lifted — defeating the
 * agent-policy approval invariant. The vex-app desktop UI must drive the
 * normal agent/turn-loop dispatch path instead, where mutating tools under
 * `restricted` still require approval (see `dispatchTool` →
 * `routeInternalTool`'s `pendingApproval` gate).
 *
 * A guard test pins this: see
 * `vex-app/src/main/ipc/__tests__/run-tool-boundary.test.ts`, which fails the
 * build if any file under `vex-app/src/` imports `runTool` (named, via the
 * `@vex-agent/engine` barrel, or as a namespace member). Do not relax that
 * guard to "make it compile" — move the call back behind the operator shell.
 */

import type { ToolResult } from "../../tools/types.js";
import type { InternalToolContext } from "../../tools/internal/types.js";
import { buildSessionWalletResolution, resolveWalletPolicy } from "./hydrate.js";
import { dispatchTool } from "../../tools/dispatcher.js";
import * as sessionsRepo from "../../db/repos/sessions.js";
import * as missionRunsRepo from "../../db/repos/mission-runs.js";
import * as missionsRepo from "../../db/repos/missions.js";
import { computeBand } from "./context-band.js";
import logger from "../../../utils/logger.js";

const DEFAULT_CONTEXT_LIMIT = 256_000;

/**
 * Invoke an internal / protocol tool directly by name with structured args.
 *
 * Returns a `ToolResult` (same shape the LLM would receive). Throws only
 * when `sessionId` does not exist — tool-level failures are captured in
 * `result.success = false` per the dispatcher contract.
 */
export async function runTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const session = await sessionsRepo.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const activeRun = await missionRunsRepo.getActiveRunBySession(sessionId);
  const mission = activeRun ? null : await missionsRepo.getActiveMission(sessionId);
  const missionId = activeRun?.missionId ?? mission?.id ?? null;
  const sessionKind = missionId ? "mission" : session.mode;

  const context: InternalToolContext = {
    sessionId,
    loadedDocuments: new Map(),
    sessionPermission: session.permission,
    approved: true,
    missionRunId: activeRun?.id ?? null,
    missionId,
    sessionKind,
    // Direct operator invoke is explicit, privileged intent — NOT agent
    // autonomy — so the plan-acceptance gate (which gates the agent's
    // autonomous execution) does not apply here.
    planMode: false,
    contextUsageBand: computeBand(session.tokenCount, DEFAULT_CONTEXT_LIMIT),
    sourceSurface: "vex_agent",
    sourceSession: sessionId,
    walletResolution: buildSessionWalletResolution(session),
    walletPolicy: resolveWalletPolicy(mission, activeRun),
  };

  const toolCallId = `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  logger.info("engine.run_tool.begin", {
    sessionId,
    tool: name,
    missionRunId: context.missionRunId,
  });

  const result = await dispatchTool({ name, args, toolCallId }, context);

  logger.info("engine.run_tool.completed", {
    sessionId,
    tool: name,
    success: result.success,
    pendingApproval: result.pendingApproval ?? false,
  });

  return result;
}
