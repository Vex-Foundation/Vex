/**
 * Chat IPC schemas.
 *
 * `vex.chat.submit` is the renderer's single typed path for operator text.
 * For mission sessions, the first submit also becomes the initial goal
 * snapshot; the engine then continues through mission setup.
 */

import { z } from "zod";
import { INITIAL_GOAL_MAX_LENGTH } from "./sessions.js";
import { reasoningEffortSchema } from "./reasoning.js";

export const CHAT_MESSAGE_MAX_LENGTH = INITIAL_GOAL_MAX_LENGTH;

/**
 * Operator-facing reasoning effort (S6). The FULL OpenRouter transport
 * enum — extracted to `reasoning.ts` so both this file and `sessions.ts`
 * can import it without a `chat.ts` <-> `sessions.ts` circular import
 * (this file already imports `INITIAL_GOAL_MAX_LENGTH` from sessions.ts).
 * Whether a GIVEN model supports a GIVEN value is a per-model capability
 * (`SessionModelDto.reasoning`, `sessions.ts`), not a schema-level
 * restriction — the transport enum stays maximal.
 */
export { reasoningEffortSchema };
export type { ReasoningEffort } from "./reasoning.js";

export const chatSubmitInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    message: z
      .string()
      .trim()
      .min(1, "Message is required.")
      .max(
        CHAT_MESSAGE_MAX_LENGTH,
        `Message must be ${CHAT_MESSAGE_MAX_LENGTH} characters or less.`,
      ),
    /**
     * Per-turn reasoning effort (S6/D6). Optional + additive. Absent means
     * "no explicit choice" — the engine sends NO reasoning param at all and
     * the provider's own model default applies (the forced "medium"
     * fallback is retired). An explicit value (including "none") is sent
     * verbatim, but ONLY when the model actually advertises reasoning
     * support (`InferenceConfig.supportsReasoningEffort`). Ignored by
     * mission interrupt/resume paths.
     */
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();
export type ChatSubmitInput = z.infer<typeof chatSubmitInputSchema>;

/**
 * Mirrors the engine's `StopReason` union (src/vex-agent/engine/types.ts).
 * Must stay a SUPERSET of what `chat.submit` can surface: the handler pipes
 * `submitOperatorInstruction(...).stopReason` straight into the validated
 * output, and the ingress `paused_wake` preempt branch returns a full
 * `resumeMissionRun` TurnResult — so ANY turn-loop stop reason (including
 * `user_paused` from the pause control and `plan_acceptance_required` from
 * a mission-run `plan_write`) can reach this schema. A missing member here
 * turns a successful turn into an `internal.unexpected` IPC error (S7 fix
 * for the S6 finding; pinned by sessions-chat.test.ts).
 */
/**
 * IPC input for `vex.chat.steer` (A33). Same session/message bounds as
 * `chat.submit`; no reasoningEffort — a steer joins the LIVE turn's
 * configuration instead of choosing its own.
 */
export const chatSteerInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    message: z
      .string()
      .trim()
      .min(1, "Message is required.")
      .max(
        CHAT_MESSAGE_MAX_LENGTH,
        `Message must be ${CHAT_MESSAGE_MAX_LENGTH} characters or less.`,
      ),
  })
  .strict();
export type ChatSteerInput = z.infer<typeof chatSteerInputSchema>;

/**
 * Discriminated outcome of `vex.chat.steer`:
 *   - `queued_live` — exactly one `operator_interrupt` row was persisted
 *     (logged before it can become model-visible); the live loop delivers
 *     it at the next tool-batch boundary, never mid tool call.
 *   - `no_active_turn` — nothing persisted; the caller submits normally.
 * Not idempotent on `queued_live` (one row per call): never auto-retry.
 */
export const chatSteerOutcomeSchema = z.enum(["queued_live", "no_active_turn"]);
export type ChatSteerOutcome = z.infer<typeof chatSteerOutcomeSchema>;

export const chatSteerResultSchema = z
  .object({
    outcome: chatSteerOutcomeSchema,
  })
  .strict();
export type ChatSteerResult = z.infer<typeof chatSteerResultSchema>;

/**
 * Hand-mirrored from the engine's canonical `STOP_REASONS` tuple
 * (`src/vex-agent/engine/types/stop-reasons.ts`), business members first then
 * runtime, in that exact order. `check:boundaries` forbids this package from
 * importing the engine, so the list cannot be derived here; the sequence is
 * pinned instead by the cross-package drift guard
 * `src/__tests__/vex-agent/engine/stop-reason-vocabulary-drift.test.ts`.
 * A reason missing here makes an honest engine stop fail strict validation at
 * the IPC boundary, which is why the guard compares sequences and not sets.
 */
export const chatStopReasonSchema = z.enum([
  "goal_reached",
  "deadline_reached",
  "capital_depleted",
  "max_loss_hit",
  "no_viable_opportunity",
  "emergency_stop",
  "user_stopped",
  "approval_required",
  "checkpoint_pause",
  "iteration_limit",
  "timeout",
  "waiting_for_wake",
  "waiting_for_compact_commit",
  "compact_unable_at_critical",
  "system_error",
  "user_paused",
  "plan_acceptance_required",
  "user_form_required",
  "no_progress",
  "restart_orphan",
  "tool_call_loop",
]);
export type ChatStopReason = z.infer<typeof chatStopReasonSchema>;

export const chatMissionStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ChatMissionStatus = z.infer<typeof chatMissionStatusSchema>;

export const chatSubmitResultSchema = z
  .object({
    text: z.string().nullable(),
    toolCallsMade: z.number().int().min(0),
    pendingApprovals: z.array(z.string()),
    stopReason: chatStopReasonSchema.nullable(),
    missionStatus: chatMissionStatusSchema.nullable(),
    treatedAsInitialGoal: z.boolean(),
  })
  .strict();
export type ChatSubmitResult = z.infer<typeof chatSubmitResultSchema>;
