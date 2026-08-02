/**
 * Runtime schemas — durable control plane for active mission runs.
 *
 * Puzzle 03 expands the surface beyond the puzzle-01 stubs:
 *
 *  - `getState` reads the active row from `mission_runs` (statuses
 *    `running` / `paused_approval` / `paused_wake` / `paused_error` /
 *    `paused_user`) plus a bounded lease summary
 *    (`leaseActive` + `leaseExpiresAt`).
 *  - `requestPause` / `requestStop` / `requestResume` / `cancelWake`
 *    each return a per-action discriminated union — the renderer
 *    mutation hook switches on `outcome` to drive the correct UI
 *    transition. No raw owner IDs ever leave main.
 *  - `controlStateEvent` is the broadcast schema for the puzzle-03
 *    event spine — fires after a committed transition so the renderer
 *    invalidates the session's runtime state.
 *
 * Field names match the canonical refs vocabulary in BUG-REPORTING.md
 * §3 so the Phase 2 BugReportSink can stamp `sessionId` /
 * `missionRunId` / `stop_reason` straight from these DTOs.
 */

import { z } from "zod";
import {
  engineCauseCodeSchema,
  engineErrorClassSchema,
  engineErrorTypeSchema,
  engineStatusCodeSchema,
} from "./engine-error.js";
import { missionRunStatusSchema } from "./sessions.js";

// ── Sleeping (paused_wake) detail ───────────────────────────────────

/**
 * Bound on the agent-authored defer reason. Matches `loop_defer`'s own
 * `REASON_MAX_CHARS` (`src/vex-agent/tools/internal/loop-defer.ts`) so a
 * reason the engine accepted can always cross this boundary — a tighter bound
 * here would silently drop legitimate rows instead of showing them.
 */
export const PAUSED_WAKE_REASON_MAX_CHARS = 500;

/**
 * Bound on the watch summary. This is NOT free text from the row: main derives
 * it from the watch condition TYPE names in `loop_wake_requests.payload`, so
 * the bound only has to fit a handful of joined identifiers.
 */
export const PAUSED_WAKE_WATCH_SUMMARY_MAX_CHARS = 200;

/**
 * Why the run is asleep and until when, read from the session's pending
 * `loop_wake_requests` row.
 *
 * DISPLAY TEXT, NOT A CONTROL SIGNAL. `reason` is written by the model
 * (`loop_defer`'s `reason` argument) and `watchSummary` is derived from the
 * watch condition types — neither may ever be parsed to drive renderer
 * behavior, exactly as `claimed.ts` refuses to route on `wake.reason`. The
 * only machine-readable field is `dueAt`.
 *
 * The raw `payload` JSONB deliberately does NOT cross: it holds protocol-owned
 * condition variants (thresholds, token ids) that no UI needs and that would
 * become an accidental contract the moment a renderer read them.
 */
export const runtimePausedWakeSchema = z
  .object({
    /** `loop_wake_requests.due_at` — the scheduled resume time. */
    dueAt: z.string().datetime({ offset: true }),
    reason: z.string().max(PAUSED_WAKE_REASON_MAX_CHARS).nullable(),
    /** Joined watch condition types, or `null` for a plain timed defer. */
    watchSummary: z.string().max(PAUSED_WAKE_WATCH_SUMMARY_MAX_CHARS).nullable(),
  })
  .strict();
export type RuntimePausedWake = z.infer<typeof runtimePausedWakeSchema>;

// ── DTO returned by runtime.getState ────────────────────────────────

export const runtimeStateDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    /**
     * `true` exactly when an active or paused mission run row exists
     * for the session. Agent-mode sessions (no missions) resolve to
     * `false` with the run-scoped fields all `null`.
     */
    hasActiveRun: z.boolean(),
    missionRunId: z.string().nullable(),
    /** `mission_runs.status` (puzzle 03 widens with `paused_user`). */
    status: missionRunStatusSchema.nullable(),
    stopReason: z.string().nullable(),
    lastCheckpointAt: z.string().datetime({ offset: true }).nullable(),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    iterationCount: z.number().int().min(0).nullable(),
    /** `runner_leases` summary — bounded so owner IDs stay internal. */
    leaseActive: z.boolean(),
    leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
    /**
     * Topmost pending or observed control request kind for the
     * session, or `null` if none. Renderer uses this to gate the
     * pause/stop/resume buttons (`pending_resume` -> disable pause).
     */
    pendingControlKind: z
      .enum(["pause_after_step", "stop_terminal", "resume", "cancel_wake"])
      .nullable(),
    /**
     * Bounded classification of the failure that paused this run, read from
     * `mission_runs.stop_evidence_json`.
     *
     * CODES, NEVER PROSE. The evidence row also holds `errorMessage` and the
     * run holds `stop_summary`; neither may ever appear here. They are raw
     * provider/exception text — the same untrusted free-text class as
     * `memory_jobs.last_error`, which is excluded from every DTO with a test
     * asserting the omission. The renderer classifies from these codes and
     * writes its own copy; the human-readable text stays server-side in the
     * logs and in mission evidence.
     *
     * OPTIONAL, and every key inside it optional too: evidence written before
     * the engine persisted these signals has none of them, and a run that
     * paused for a reason with nothing classifiable to say has none either.
     * Absent ⇒ the renderer shows its generic framing. A consumer must treat
     * `errorType` as an OPEN enum with a total default branch — it is
     * OpenRouter's canonical `ApiErrorType`, carried verbatim.
     */
    lastError: z
      .object({
        // SAME validators as the live `EV.engine.error` payload — deliberately
        // imported rather than restated. Two vocabularies for one concept is
        // the exact failure this channel exists to avoid: a renderer that maps
        // `errorClass` from the push event but sees an arbitrary 120-char
        // string from the DTO would need two mapping tables, and the looser
        // one would quietly become the real contract.
        errorType: engineErrorTypeSchema.optional(),
        errorClass: engineErrorClassSchema.optional(),
        statusCode: engineStatusCodeSchema.optional(),
        causeCode: engineCauseCodeSchema.optional(),
      })
      .strict()
      .optional(),
    /**
     * Present ONLY while `status === "paused_wake"` and a pending wake row
     * still exists for the session. Absent otherwise — including for a
     * `paused_wake` run whose row was already claimed or cancelled, which is a
     * real transient the renderer must read as "not sleeping" rather than as
     * "sleeping, details missing".
     *
     * OPTIONAL rather than nullable so the additive extension is invisible to
     * every existing consumer: a DTO built before this field existed still
     * parses, and `exactOptionalPropertyTypes` keeps "absent" and "null" from
     * being conflated at the call site.
     */
    pausedWake: runtimePausedWakeSchema.optional(),
  })
  .strict()
  /**
   * One-way invariant. `pausedWake` present ⇒ `status === "paused_wake"`,
   * because the renderer treats its presence alone as "this run is sleeping";
   * sleep details on a running run would render a countdown over live work.
   *
   * The converse is deliberately NOT enforced: a `paused_wake` run whose
   * pending row was just claimed or cancelled legitimately arrives without the
   * field, and that race must stay parseable.
   */
  .superRefine((state, ctx) => {
    if (state.pausedWake !== undefined && state.status !== "paused_wake") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pausedWake"],
        message: 'pausedWake is only valid when status is "paused_wake"',
      });
    }
  });
export type RuntimeStateDto = z.infer<typeof runtimeStateDtoSchema>;

// ── Inputs ──────────────────────────────────────────────────────────

export const runtimeRequestInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();
export type RuntimeRequestInput = z.infer<typeof runtimeRequestInputSchema>;

// ── Per-action result discriminated unions ──────────────────────────

export const runtimeRequestPauseResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("queued"), requestId: z.string().uuid() })
    .strict(),
  z
    .object({
      outcome: z.literal("already_pending"),
      requestId: z.string().uuid(),
    })
    .strict(),
  z.object({ outcome: z.literal("no_active_run") }).strict(),
  z
    .object({
      outcome: z.literal("already_paused"),
      status: missionRunStatusSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("terminal"),
      status: missionRunStatusSchema,
    })
    .strict(),
  /**
   * `status === 'running'` but the lease is NOT active — no runner is
   * observing, so enqueueing `pause_after_step` would be unobservable (it
   * would sit pending forever, same bug class as issue #12's stop dead-end).
   * The run is effectively already parked/idle; the safe next actions are
   * Resume/Retry (reclaim) or Stop (end).
   *
   * IPC-LEVEL CONTRACT, no renderer consumer yet: `runtime.requestPause` has
   * no call-site in the renderer today (`useRequestPause` is defined but
   * unused, and there is no Pause control in the UI). Like the sibling
   * `already_paused` outcome, this is a total-classification result the
   * handler must return; when a Pause control is added, map it to a neutral
   * "run is already parked — nothing to pause" notice, NOT an error. This
   * comment intentionally does NOT claim any current UI mapping.
   */
  z.object({ outcome: z.literal("already_parked") }).strict(),
]);
export type RuntimeRequestPauseResult = z.infer<typeof runtimeRequestPauseResultSchema>;

export const runtimeRequestStopResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("queued"), requestId: z.string().uuid() })
    .strict(),
  // A paused run is aborted directly (no runner to observe a queued stop).
  z.object({ outcome: z.literal("stopped") }).strict(),
  z
    .object({
      outcome: z.literal("already_terminal"),
      status: missionRunStatusSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("no_active_run") }).strict(),
]);
export type RuntimeRequestStopResult = z.infer<typeof runtimeRequestStopResultSchema>;

export const runtimeRequestResumeResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("resumed"), runId: z.string() })
    .strict(),
  z
    .object({ outcome: z.literal("already_running"), runId: z.string() })
    .strict(),
  z.object({ outcome: z.literal("no_active_run") }).strict(),
  z
    .object({
      outcome: z.literal("blocked_approval"),
      pendingApprovalId: z.string(),
    })
    .strict(),
  z
    .object({ outcome: z.literal("blocked_error"), reason: z.string() })
    .strict(),
  z
    .object({
      outcome: z.literal("lease_busy"),
      retryAfterMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type RuntimeRequestResumeResult = z.infer<typeof runtimeRequestResumeResultSchema>;

export const runtimeCancelWakeResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("cancelled_wake"),
      cancelledCount: z.number().int().min(0),
    })
    .strict(),
  z.object({ outcome: z.literal("no_pending_wake") }).strict(),
]);
export type RuntimeCancelWakeResult = z.infer<typeof runtimeCancelWakeResultSchema>;

// ── Engine -> renderer control-state event ──────────────────────────

export const CONTROL_STATE_EVENT_TYPE = "engine.control.state" as const;

export const controlStateEventSchema = z
  .object({
    type: z.literal(CONTROL_STATE_EVENT_TYPE),
    sessionId: z.string().uuid(),
    /** `mission_runs.id` for the affected run, or `null` for session-only flows. */
    missionRunId: z.string().nullable(),
    /** Current status after the committed transition (or `null` if no run). */
    runStatus: missionRunStatusSchema.nullable(),
    /** Stop reason set by the transition, or `null`. */
    stopReason: z.string().nullable(),
    /** Topmost pending control request kind after the transition. */
    pendingControlKind: z
      .enum(["pause_after_step", "stop_terminal", "resume", "cancel_wake"])
      .nullable(),
    /** Lease summary — owner IDs intentionally NOT exposed. */
    leaseActive: z.boolean(),
    leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
    correlationId: z.string().nullable(),
  })
  .strict();
export type ControlStateEvent = z.infer<typeof controlStateEventSchema>;
