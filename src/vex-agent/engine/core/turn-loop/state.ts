/**
 * Turn-loop state types — the public config/result shapes for `runTurnLoop`.
 * Extracted from `turn-loop.ts` for scaling.
 *
 * Pure declarations only: no runtime behavior, no side effects. The
 * orchestrator (`turn-loop.ts`) and its callers consume these via the
 * façade re-export, so the public surface is unchanged.
 */

import type { StopReason } from "../../types.js";
import type { ToolVisibilityBase } from "@vex-agent/tools/registry.js";

export interface TurnLoopConfig {
  maxIterations: number;
  timeoutMs: number;
  contextLimit: number;
  /**
   * Static visibility axes (permission, role, sessionKind, missionRunActive)
   * the runner knows up-front. `buildTurnPromptStack` augments this per turn
   * with the live band + `hasSessionMemory` to build the SINGLE
   * `ToolVisibilityContext` that drives BOTH the tools array and the Tool Map.
   */
  baseVisibility?: ToolVisibilityBase;
  /**
   * The owner id THIS runner acquired the session lease with.
   *
   * Required for the compaction-apply boundary action: consuming a cutover
   * rewrites the transcript, so only the actual lease holder may do it, and the
   * check is an EQUALITY against the live lease — never the row's current owner
   * adopted as our identity. Absent ⇒ the action is not registered at all and no
   * cutover is consumed, which is the safe default for a caller that does not
   * hold a lease.
   */
  runnerOwnerId?: string;
  /**
   * Hard mission time-box as an absolute epoch (ms). When set, the turn loop
   * stops with `deadline_reached` the moment `Date.now() >= missionDeadlineMs`,
   * independent of the agent — checked first each iteration, before another
   * inference call is spent. Computed from the run's immutable `started_at` +
   * the configured duration (see `engine/mission/mission-deadline.ts`).
   * Null/undefined = no box.
   */
  missionDeadlineMs?: number | null;
}

export interface TurnLoopResult {
  text: string | null;
  toolCallsMade: number;
  pendingApprovals: string[];
  stopReason: StopReason | null;
  /** Structured stop payload — summary/evidence from mission_stop. */
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> };
}
