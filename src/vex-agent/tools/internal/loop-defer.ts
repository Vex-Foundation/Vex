/**
 * `loop_defer` handler — writes a pending wake row and emits the
 * `defer_until` engine signal. Turn-loop consumes the signal to tear down
 * the current batch and flip the mission run (or full-autonomous session)
 * to `paused_wake`; the wake executor then resumes at `due_at`.
 *
 * ## Two session shapes park through this tool (owner decree 2026-08-03)
 *
 *   - MISSION RUN — the wake row references the run; the run row is parked in
 *     `paused_wake` by the turn loop and the executor claims it by run status.
 *   - FULL-AUTONOMOUS AGENT SESSION — `missionRunId: null`. There is no run row,
 *     so the wake row IS the park and the executor claims the session lease
 *     (`wake/executor/agent-session.ts`). It goes through
 *     `enqueueSessionScopedWake` so the operator-stop gate and the INSERT commit
 *     together under the session control lock.
 *
 * Withholding this tool from agent sessions was the live "unlimited thoughts"
 * pathology: an agent waiting for a bridge had no way to sleep, so it polled.
 * Restricted agent sessions stay excluded — a human is in the loop there and a
 * defer would just stall the conversation.
 *
 * ## Validation is layered
 *
 *   1. Zod schema — argument shape, bounds, and the XOR between `after_ms` /
 *      `wake_at`. A single flat `.refine` so one error message covers "missing
 *      both" and "both present".
 *   2. Runtime defense-in-depth — `ctx.sessionKind`, `ctx.missionRunId` and
 *      `ctx.sessionPermission` must match the visibility gate. Even though
 *      `getOpenAITools` hides the tool where it does not apply, the dispatcher
 *      also runs on operator-resume and script paths where the visibility
 *      filter is bypassed, so the handler re-checks.
 *   3. Wake-time bounds — applied to the RESOLVED absolute time, so `after_ms`
 *      and `wake_at` cannot express different waits.
 *
 * ## A rejected `watch` NEVER fails the defer
 *
 * The single most damaging behavior of the previous implementation: an
 * unsupported watch type failed the whole call, so the run did not park and the
 * model stayed in the loop — the exact failure the tool exists to prevent. A
 * watch is an optimization over the timer. When it cannot be honoured, the
 * defer still parks on its timer and the refusal comes back as a named warning.
 *
 * ## ONE watch outcome does cancel the defer: the condition is already true
 *
 * A `token_price` watch whose threshold has ALREADY been crossed when the model
 * arms it is not a watch, it is news. Parking on it would sleep the session
 * through the very move it asked to be woken for, so no wake row is written, no
 * `defer_until` signal is emitted, and the model is handed the observed price
 * and told to act. This is the ONLY outcome that suppresses the park; an
 * unarmable condition still parks on its timer, per the paragraph above.
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
import { formatZodIssueForModel } from "./arg-validation.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import { currentDate } from "@vex-agent/engine/runtime-clock.js";
import { validateWakeWatchConditions } from "@vex-agent/engine/wake/watch-registry.js";
import { registerBuiltInWakeWatchEvaluators } from "@vex-agent/engine/wake/watch/index.js";

/**
 * Wait bounds, in MILLISECONDS, applied to the resolved absolute wake time.
 *
 * The minimum is not cosmetic: the wake executor ticks every 2 s, so a
 * sub-second defer is a busy-loop that costs a full park/resume cycle to buy
 * nothing. The maximum is 24 h and now binds `wake_at` too — it previously
 * bound only `after_ms`, so the same wait was expressible one way and refused
 * the other, and a model could schedule itself five years out.
 */
export const LOOP_DEFER_MIN_WAIT_MS = 1_000;
export const LOOP_DEFER_MAX_WAIT_MS = 24 * 60 * 60 * 1_000;

const REASON_MAX_CHARS = 500;
const MAX_WATCH_CONDITIONS = 4;
const MISSION_ACTIVATION_WAIT_PATTERN = new RegExp([
  String.raw`\/mission\s+(?:start|continue)`,
  String.raw`waiting\s+for\s+(?:the\s+)?(?:operator|user).{0,80}(?:\/mission\s+(?:start|continue)|mission\s+(?:start|continue)|(?:start|continue)\s+(?:the\s+)?mission)`,
  String.raw`(?:mission\s+)?(?:start|continue)\s+command`,
].join("|"), "i");

const LoopDeferArgs = z
  .object({
    after_ms: z
      .number()
      .int({ message: "after_ms must be an integer number of milliseconds" })
      .min(LOOP_DEFER_MIN_WAIT_MS, {
        message: `after_ms is in MILLISECONDS and must be ≥ ${LOOP_DEFER_MIN_WAIT_MS} (1s)`,
      })
      .max(LOOP_DEFER_MAX_WAIT_MS, {
        message: `after_ms is in MILLISECONDS and must be ≤ ${LOOP_DEFER_MAX_WAIT_MS} (24h)`,
      })
      .optional(),
    wake_at: z
      .string()
      .datetime({
        message:
          "wake_at must be an ISO-8601 UTC timestamp ending in Z, e.g. \"2026-08-03T10:00:00Z\"",
      })
      .optional(),
    reason: z
      .string({ error: "reason is required and must be a non-empty string" })
      .min(1, { message: "reason is required (non-empty)" })
      .max(REASON_MAX_CHARS, { message: `reason must be ≤ ${REASON_MAX_CHARS} chars` }),
    // The scheduler validates only this envelope. Variant fields are owned by
    // the evaluator registered by the protocol that supplies the condition.
    watch: z.array(z.looseObject({}))
      .min(1, { message: "watch must include at least one condition" })
      .max(MAX_WATCH_CONDITIONS, {
        message: `watch may include at most ${MAX_WATCH_CONDITIONS} conditions`,
      })
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
    return fail(`loop_defer: ${formatZodIssueForModel(parsed.error.issues[0], params)}`);
  }
  const { after_ms, wake_at, reason, watch } = parsed.data;

  // Layer 2 — runtime defense-in-depth.
  const shape = resolveDeferShape(context);
  if (shape === null) {
    return fail(
      "loop_defer is only available inside an active mission run or a Full-Autonomous "
      + "agent session. A restricted agent session waits for the user instead — end your "
      + "turn with a normal reply.",
    );
  }

  if (MISSION_ACTIVATION_WAIT_PATTERN.test(reason)) {
    return fail(
      "loop_defer: this mission run is already active. Do not wait for the operator to start or continue the mission; execute the frozen Mission Contract now.",
    );
  }

  // Layer 3 — resolve the absolute wake time, then bound it. Both input forms
  // land on the SAME bounds; `after_ms` is relative to the runtime clock and
  // `wake_at` is parsed as an absolute UTC instant (Zod already required the
  // designator, so this is never NaN and never local-time).
  const now = currentDate().getTime();
  const dueAtMs = after_ms !== undefined ? now + after_ms : Date.parse(wake_at!);
  const waitMs = dueAtMs - now;
  if (waitMs < LOOP_DEFER_MIN_WAIT_MS) {
    return fail(
      `loop_defer: wake time must be at least ${LOOP_DEFER_MIN_WAIT_MS} ms (1s) in the future. `
      + `Current time is ${new Date(now).toISOString()}.`,
    );
  }
  if (waitMs > LOOP_DEFER_MAX_WAIT_MS) {
    return fail(
      `loop_defer: wake time must be at most ${LOOP_DEFER_MAX_WAIT_MS} ms (24h) from now. `
      + `Current time is ${new Date(now).toISOString()}.`,
    );
  }

  const dueAt = new Date(dueAtMs);
  const { payload, rejectedWatch, satisfiedWatch } = await buildWatchPayload(watch, context);

  // A condition that is ALREADY TRUE is the one watch outcome that must stop the
  // park: sleeping on an event that has happened costs the session its whole
  // timer for nothing. No row is written, so nothing has to be cancelled later.
  if (satisfiedWatch.length > 0) {
    return {
      success: true,
      output:
        `Not deferred - ${satisfiedWatch.join(" | ")} Act on it now.`
        + (payload === null
          ? ""
          : " Your other watch conditions were NOT armed either, because nothing was scheduled;"
            + " re-send them with a fresh loop_defer if you still want them.")
        + (rejectedWatch.length === 0
          ? ""
          : ` A separate condition was also unusable (${rejectedWatch.join(" | ")}).`),
      data: {
        deferred: false,
        watch_satisfied: satisfiedWatch,
        watch_rejected: rejectedWatch,
      },
    };
  }

  const row = shape.kind === "mission"
    ? await loopWakeRepo.enqueue({
      sessionId: context.sessionId,
      missionRunId: shape.missionRunId,
      dueAt,
      reason,
      payload,
    })
    : await enqueueAgentSessionDefer(context.sessionId, dueAt, reason, payload);

  if (row === "stopped") {
    return fail(
      "loop_defer: this session has been stopped by the operator, so no wake was scheduled.",
    );
  }

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
    output: `Loop deferred until ${row.dueAt} (defer_id=${row.id}).${watchNote(rejectedWatch)}`,
    data: {
      defer_id: row.id,
      due_at: row.dueAt,
      watch_armed: payload === null ? [] : (payload.conditions as unknown[]),
      watch_rejected: rejectedWatch,
    },
    engineSignal: {
      type: "defer_until",
      reason,
      summary: `Deferred until ${row.dueAt}`,
      dueAt: row.dueAt,
    },
  };
}

// ── Context shape ──────────────────────────────────────────────────

type DeferShape =
  | { readonly kind: "mission"; readonly missionRunId: string }
  | { readonly kind: "agent_session" };

/**
 * Which park shape this context is entitled to, or `null` when none is.
 *
 * `permission: "full"` is what separates a Full-Autonomous agent session from a
 * restricted one. The restricted case is not an oversight: a restricted session
 * only ever acts between user messages, so parking it removes the human's turn
 * without buying any autonomy.
 */
function resolveDeferShape(ctx: InternalToolContext): DeferShape | null {
  if (ctx.sessionKind === "mission" && ctx.missionRunId !== null) {
    return { kind: "mission", missionRunId: ctx.missionRunId };
  }
  if (ctx.sessionKind === "agent" && ctx.sessionPermission === "full") {
    return { kind: "agent_session" };
  }
  return null;
}

async function enqueueAgentSessionDefer(
  sessionId: string,
  dueAt: Date,
  reason: string,
  payload: Record<string, unknown> | null,
): Promise<loopWakeRepo.LoopWakeRequest | null | "stopped"> {
  const { enqueueSessionScopedWake } = await import(
    "@vex-agent/engine/core/runner/runtime-continuation.js"
  );
  const outcome = await enqueueSessionScopedWake({ sessionId, dueAt, reason, payload });
  return outcome.kind === "stopped" ? "stopped" : outcome.row;
}

// ── Watch ──────────────────────────────────────────────────────────

/**
 * Build the wake payload from the requested watch conditions.
 *
 * Rejections are RETURNED, never thrown: see the module header — a watch that
 * cannot be armed must degrade the defer to its timer, not cancel it. When no
 * condition survives, the payload is `null` and the row is a plain timed wake,
 * byte-identical to one the model never attached a watch to.
 */
async function buildWatchPayload(
  watch: readonly Record<string, unknown>[] | undefined,
  context: InternalToolContext,
): Promise<{
  payload: Record<string, unknown> | null;
  rejectedWatch: readonly string[];
  satisfiedWatch: readonly string[];
}> {
  if (watch === undefined) return { payload: null, rejectedWatch: [], satisfiedWatch: [] };

  registerBuiltInWakeWatchEvaluators();
  const { accepted, rejected, satisfied } = await validateWakeWatchConditions(watch, context);
  if (accepted.length === 0) {
    return { payload: null, rejectedWatch: rejected, satisfiedWatch: satisfied };
  }
  return {
    payload: { watchId: randomUUID(), watchVersion: 1, conditions: accepted },
    rejectedWatch: rejected,
    satisfiedWatch: satisfied,
  };
}

/** The rejected-watch warning, phrased identically wherever it is appended. */
function watchNote(rejectedWatch: readonly string[]): string {
  return rejectedWatch.length === 0
    ? ""
    : ` Watch NOT armed (${rejectedWatch.join(" | ")}). The wake above still fires on time.`;
}
