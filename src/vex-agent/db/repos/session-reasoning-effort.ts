/**
 * The session's chosen chat reasoning effort (`sessions.reasoning_effort`,
 * migration 174, Kairos E-1).
 *
 * Written when an interactive chat turn carries a composer pick; read by the
 * turns nobody typed (wake continuations, approval and form resumes) so they
 * run at the operator's effort instead of the provider default. `null` means
 * the operator never picked.
 *
 * Mission runs never read this: their effort is part of the accepted mission
 * contract (see `engine/mission/reasoning-effort.ts`).
 */

import { executeWith, getPool, queryOne } from "../client.js";
import type { ReasoningEffort } from "@vex-agent/inference/types.js";
import { isReasoningEffort } from "@vex-agent/inference/reasoning-effort.js";

export async function setSessionReasoningEffort(
  sessionId: string,
  effort: ReasoningEffort,
): Promise<void> {
  await executeWith(
    getPool(),
    "UPDATE sessions SET reasoning_effort = $2 WHERE id = $1",
    [sessionId, effort],
  );
}

/** Read the persisted pick; a missing row or an unknown stored value reads as `null`. */
export async function getSessionReasoningEffort(sessionId: string): Promise<ReasoningEffort | null> {
  const row = await queryOne<{ reasoning_effort: string | null }>(
    "SELECT reasoning_effort FROM sessions WHERE id = $1",
    [sessionId],
  );
  const value = row?.reasoning_effort ?? null;
  return isReasoningEffort(value) ? value : null;
}
