/**
 * `loop_defer` handler — writes a pending wake row and emits the
 * `defer_until` engine signal. Turn-loop consumes the signal to tear down
 * the current batch and flip the mission run (or full-autonomous session)
 * to `paused_wake`; the wake executor then resumes at `due_at`.
 *
 * Validation is layered:
 *   1. Zod schema — argument shape, bounds, and the XOR between
 *      `after_ms` / `wake_at`. A single flat `.refine` so one error
 *      message covers "missing both" and "both present".
 *   2. Runtime defense-in-depth — `ctx.sessionKind` and (for mission)
 *      `ctx.missionRunId` must match the visibility gate. Even though
 *      `getOpenAITools` hides the tool in chat / setup / subagent, the
 *      dispatcher also runs on operator-resume and script paths where the
 *      visibility filter is bypassed, so the handler re-checks.
 *
 * One-pending-per-session is enforced at the DB level (partial unique
 * index, see migration 011). `loopWakeRepo.enqueue` returns `null` when
 * the conflict fires — we surface that back to the model as a soft
 * no-op so it doesn't double-enqueue on retry.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { fail } from "./types.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import { currentDate } from "@vex-agent/engine/runtime-clock.js";
import { validateWakeWatchConditions } from "@vex-agent/engine/wake/watch-registry.js";

const ONE_SECOND_MS = 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const REASON_MAX_CHARS = 500;
const MISSION_ACTIVATION_WAIT_PATTERN = new RegExp([
  String.raw`\/mission\s+(?:start|continue)`,
  String.raw`waiting\s+for\s+(?:the\s+)?(?:operator|user).{0,80}(?:\/mission\s+(?:start|continue)|mission\s+(?:start|continue)|(?:start|continue)\s+(?:the\s+)?mission)`,
  String.raw`(?:mission\s+)?(?:start|continue)\s+command`,
].join("|"), "i");

const LoopDeferArgs = z
  .object({
    after_ms: z
      .number()
      .int({ message: "after_ms must be an integer" })
      .min(ONE_SECOND_MS, { message: `after_ms must be ≥ ${ONE_SECOND_MS} (1s)` })
      .max(ONE_DAY_MS, { message: `after_ms must be ≤ ${ONE_DAY_MS} (24h)` })
      .optional(),
    wake_at: z
      .string()
      .datetime({ message: "wake_at must be an ISO8601 timestamp" })
      .optional(),
    reason: z
      .string({ error: "reason is required and must be a non-empty string" })
      .min(1, { message: "reason is required (non-empty)" })
      .max(REASON_MAX_CHARS, { message: `reason must be ≤ ${REASON_MAX_CHARS} chars` }),
    // The scheduler validates only this envelope. Variant fields are owned by
    // the evaluator registered by the protocol that supplies the condition.
    watch: z.array(z.object({ type: z.string().min(1) }).passthrough())
      .min(1, { message: "watch must include at least one condition" })
      .max(4, { message: "watch may include at most 4 conditions" })
      .optional(),
  })
  .refine(
    (v) => (v.after_ms !== undefined) !== (v.wake_at !== undefined),
    { message: "Provide exactly one of `after_ms` or `wake_at` (not both, not neither)" },
  );

export async function handleLoopDefer(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  // Layer 1 — Zod argument shape.
  const parsed = LoopDeferArgs.safeParse(params);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return fail(`loop_defer: ${firstIssue?.message ?? "invalid arguments"}`);
  }
  const { after_ms, wake_at, reason, watch } = parsed.data;

  // Layer 2 — runtime defense-in-depth.
  if (!isMissionRunContext(context)) {
    return fail(
      "loop_defer is only available inside an active mission run",
    );
  }

  if (MISSION_ACTIVATION_WAIT_PATTERN.test(reason)) {
    return fail(
      "loop_defer: this mission run is already active. Do not wait for the operator to start or continue the mission; execute the frozen Mission Contract now.",
    );
  }

  // Compute absolute wake time from whichever input the model chose.
  const now = currentDate().getTime();
  const dueAtMs = after_ms !== undefined
    ? now + after_ms
    : Date.parse(wake_at!); // wake_at validated by Zod.datetime — never NaN here.

  if (!Number.isFinite(dueAtMs) || dueAtMs <= now) {
    return fail("loop_defer: wake time must be in the future");
  }

  const dueAt = new Date(dueAtMs);

  let payload: Record<string, unknown> | null = null;
  if (watch !== undefined) {
    try {
      const conditions = await validateWakeWatchConditions(watch, context);
      payload = { watchId: randomUUID(), watchVersion: 1, conditions };
    } catch (error) {
      return fail(`loop_defer: ${error instanceof Error ? error.message : "watch validation failed"}`);
    }
  }

  const row = await loopWakeRepo.enqueue({
    sessionId: context.sessionId,
    missionRunId: context.missionRunId!, // non-null verified by isMissionRunContext above
    dueAt,
    reason,
    payload,
  });

  if (row === null) {
    // Partial unique index blocked the insert — a pending wake for this
    // session already exists. Surface loudly so the model doesn't think
    // its new request "took" while the old one still runs.
    return fail(
      "loop_defer: a pending wake already exists for this session. Only one pending wake per session is allowed — wait for it to fire or rely on user preemption.",
    );
  }

  return {
    success: true,
    output: `Loop deferred until ${row.dueAt} (defer_id=${row.id})`,
    data: { defer_id: row.id, due_at: row.dueAt },
    engineSignal: {
      type: "defer_until",
      reason,
      summary: `Deferred until ${row.dueAt}`,
      dueAt: row.dueAt,
    },
  };
}

function isMissionRunContext(ctx: InternalToolContext): boolean {
  if (ctx.role === "subagent") return false;
  return ctx.sessionKind === "mission" && ctx.missionRunId !== null;
}
