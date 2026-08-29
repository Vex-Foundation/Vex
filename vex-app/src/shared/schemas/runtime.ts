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

// ── Session activity projection (M5) ────────────────────────────────

/**
 * ONE discriminated answer to "is this session doing anything right now, and
 * if it is asleep, until when".
 *
 * WHY IT EXISTS. A full-autonomy agent session alternates between lease-held
 * slices and lease-less parks on a pending wake. Every surface that wanted to
 * say what the session was doing had to re-derive that from `leaseActive` (a
 * sawtooth) plus a wake read it did not have, so the tape reported wake-driven
 * agent work as "Idle" while the agent was mid-run. This is the derived fact,
 * computed once in main from the same snapshot that answers `stoppable`.
 *
 * NOT A DUPLICATE OF `leaseActive`. `leaseActive` stays exactly what it was -
 * the raw lease summary. `activity` is the POLICY over it, and every consumer
 * reads the policy rather than re-deriving one of its own.
 *
 * SESSION-SCOPED ONLY. The sleeping arm is derived from the pending wake row
 * with `mission_run_id IS NULL`. A mission run's own wake keeps its dedicated,
 * richer channel (`pausedWake` + `status === "paused_wake"`), so a mission
 * session never reports `sleeping` here and the two surfaces cannot contradict
 * each other.
 */
export const runtimeActivitySchema = z.discriminatedUnion("kind", [
  /** No lease and no session-scoped wake: nothing of this session's own is running. */
  z.object({ kind: z.literal("none") }).strict(),
  /** A runner holds this session's lease right now. */
  z.object({ kind: z.literal("running") }).strict(),
  /**
   * Parked on a session-scoped wake. `nextWakeAt` is the pending row's
   * `due_at` - the ONE machine-readable fact of the park, exactly as
   * `pausedWake.dueAt` is for a mission run. No reason text rides here: the
   * agent-authored reason is display text with its own bound and its own
   * channel, and this projection gates a status word.
   */
  z
    .object({
      kind: z.literal("sleeping"),
      nextWakeAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
export type RuntimeActivity = z.infer<typeof runtimeActivitySchema>;

/**
 * Whether the operator's Recover affordance may be offered, mirrored from the
 * SAME unresolved-money-state reader the privileged retry IPC enforces with
 * (`approval-intents/money-state.ts`).
 *
 * DISPLAY MIRROR, NEVER AUTHORITY. `runtime-retry-dispatch.ts` re-reads this
 * fact under the session control lock and refuses on its own answer; this field
 * exists so the button can be honest BEFORE the click instead of offering an
 * action the engine will refuse. A renderer that ignored it would be rude, not
 * unsafe.
 *
 * FAIL-CLOSED and PRESENT ONLY for a `paused_error` run - the one status where
 * Recover is offered. An unreadable money state projects as `blocked`, because
 * an unknown money outcome is not a clear one (rule 90).
 *
 * `reasonKinds` are the reader's own STRUCTURAL labels (`wallet_intent_live`,
 * `approval_in_flight`, ...) - never a provider message, a row id or user
 * content. They are an open set: the reader gains kinds as the money path
 * gains state machines, so a consumer maps what it knows and keeps a total
 * default branch.
 */
/**
 * The one reason kind the DTO adds on top of the money-state reader's own set:
 * the state could not be read at all. Named rather than silent, so the surface
 * says "could not check" instead of inventing a blocking reason the reader
 * never reported.
 */
export const MONEY_STATE_UNREADABLE = "money_state_unreadable";

export const runtimeRecoveryReadinessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z
    .object({
      kind: z.literal("blocked"),
      reasonKinds: z.array(z.string().max(64)).max(50),
    })
    .strict(),
]);
export type RuntimeRecoveryReadiness = z.infer<
  typeof runtimeRecoveryReadinessSchema
>;

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
    /**
     * THE authoritative control-gating predicate: would pressing Stop do
     * anything for this session right now?
     *
     * Computed in main by `session-control-state.ts` from ONE snapshot —
     * active run OR live lease OR pending wake OR pending approval decision OR
     * incomplete approval lifecycle. Every disjunct is exactly a state the stop
     * dispatcher acts on.
     *
     * NO CONSUMER MAY RE-DERIVE IT, and in particular not from `leaseActive`.
     * That field is a sawtooth: true inside a runtime slice, false across every
     * `loop_defer` park, so a control keyed on it disappears while the agent is
     * still running and still stoppable. That was the defect.
     *
     * REQUIRED, not optional. It gates a safety control, and an absent value
     * silently read as `false` is the exact failure being fixed. Main and
     * renderer ship in one bundle, so a required field is safe here.
     */
    stoppable: z.boolean(),
    /**
     * What this session is doing right now (see `runtimeActivitySchema`).
     *
     * REQUIRED, like `stoppable`, and for the same reason: main and renderer
     * ship in one bundle, and an absent value read as "none" would report a
     * running agent as idle - the exact defect this field closes.
     */
    activity: runtimeActivitySchema,
    /**
     * Present ONLY while `status === "paused_error"` - the one state where the
     * Recover control is offered. See `runtimeRecoveryReadinessSchema`.
     */
    recoveryReady: runtimeRecoveryReadinessSchema.optional(),
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
    /**
     * `activity: running` is DERIVED from the live lease, so the two must agree
     * or the DTO carries two answers to one question. The converse is NOT
     * enforced: a lease held for a mission run's slice is legitimately
     * `running` here too, and a lease that expires between the two column
     * reads of one snapshot cannot happen (they come from the same row).
     */
    if (state.activity.kind === "running" && !state.leaseActive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity"],
        message: 'activity "running" requires an active lease',
      });
    }
    /**
     * Recover readiness is meaningless without the pause it gates. Present on
     * any other status would mean a surface could disable (or enable) Recover
     * from a fact that was never computed for that state.
     */
    if (state.recoveryReady !== undefined && state.status !== "paused_error") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recoveryReady"],
        message: 'recoveryReady is only valid when status is "paused_error"',
      });
    }
  });
export type RuntimeStateDto = z.infer<typeof runtimeStateDtoSchema>;

/**
 * The run + lease + pending-control projection, WITHOUT the two fields that
 * are composed at the IPC boundary rather than read from the run.
 *
 * `mission-runs-db.ts` reports these facts and must not know about wakes or the
 * control-gating policy; `stoppable` and `activity` are decided by the
 * aggregate, and `pausedWake` / `recoveryReady` by separate, status-gated
 * reads. Naming the subset keeps a required DTO field from silently becoming
 * that helper's problem.
 */
export type RuntimeRunStateFacts = Omit<
  RuntimeStateDto,
  "stoppable" | "pausedWake" | "activity" | "recoveryReady"
>;

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
