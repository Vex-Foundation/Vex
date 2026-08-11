/**
 * Mission lifecycle — statuses, their classification sets, and the paused-run
 * error surfaced to callers.
 *
 * Implementation detail of `engine/types.ts`; import from there.
 */

// ── Mission lifecycle ───────────────────────────────────────────

export type MissionStatus =
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Canonical list of `MissionRunStatus` literals — single source of truth.
 * Engine repos, `vex-app` shared schemas, app DB whitelists, and the
 * `src/lib/diagnostics/bug-report-schema.ts` runtime status enum mirror
 * this array. A drift test pins them against each other so adding a new
 * status here fails CI if any mirror is out of sync.
 *
 * `paused_user` (puzzle 03) is the durable status for a user-requested
 * pause at the next safe checkpoint — distinct from `paused_approval`
 * (waiting on a queued tool approval) and `paused_wake` (sleeping
 * between iterations of an autonomous loop).
 */
export const MISSION_RUN_STATUSES = [
  "running",
  "paused_approval",
  "paused_wake",
  "paused_error",
  "paused_user",
  // Plan-mode: an active run paused because the agent wrote/changed a plan that
  // is not yet user-accepted. Resume is gated on plan ACCEPTANCE: refused while
  // unaccepted; once accepted it resumes via `plan.accept` OR any control resume
  // path. Never resumed by a plain user chat message (a runtime pause but NOT a
  // RESUMABLE_STOP).
  "paused_plan_acceptance",
  // Contract C3b: the run is parked waiting for the USER to fill and submit a
  // form the agent asked for (today: the token-launch form). Deliberately NOT
  // `paused_approval` — approval parking always enqueues an approval and
  // exposes an approval CARD, which is the very surface this path exists to
  // avoid. Its resume is claimed by the form continuation, not by the approval
  // lifecycle, so it is absent from APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES.
  // Cancel/expiry resume the turn with an honest tool result; it never hangs.
  "paused_user_form",
  "completed",
  "failed",
  "stopped",
  "cancelled",
] as const;

export type MissionRunStatus = (typeof MISSION_RUN_STATUSES)[number];

/**
 * Centralised classification of `MissionRunStatus` values. Engine, repo,
 * ingress router and UI cockpit MUST consult these sets rather than
 * enumerating literals so a new arm (e.g. `paused_user`) flows through
 * every decision point automatically.
 */
export const ACTIVE_RUN_STATUSES: ReadonlySet<MissionRunStatus> = new Set(["running"]);
export const PAUSED_RUN_STATUSES: ReadonlySet<MissionRunStatus> = new Set([
  "paused_approval",
  "paused_wake",
  "paused_error",
  "paused_user",
  "paused_plan_acceptance",
  "paused_user_form",
]);
export const TERMINAL_RUN_STATUSES: ReadonlySet<MissionRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
]);
export const ACTIVE_OR_PAUSED_RUN_STATUSES: ReadonlySet<MissionRunStatus> = new Set([
  ...ACTIVE_RUN_STATUSES,
  ...PAUSED_RUN_STATUSES,
]);

/**
 * The statuses from which a resolved approval's resume may claim its run and
 * flip it back to `running`. A run outside this set cannot be resumed until it
 * moves, and no amount of retrying moves it.
 *
 * TWO consumers that must never drift: the claim gate itself
 * (`approval-runtime/continuation.ts` passes it as `fromStatuses`) and the
 * fairness ordering of the approval-lifecycle scans
 * (`db/repos/approval-intents/lifecycle.ts`), which sorts rows whose run is
 * outside this set last so they cannot crowd newer approvals out of a
 * fixed-size batch. If the ordering disagreed with the gate it would either
 * deprioritise claimable rows or promote unclaimable ones.
 *
 * A list rather than a `ReadonlySet` because both consumers need one: the lease
 * claim takes `readonly MissionRunStatus[]`, and the scan passes it to Postgres
 * as an `= ANY($n)` array parameter.
 */
export const APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES = [
  "paused_approval",
  "running",
] as const satisfies readonly MissionRunStatus[];

/**
 * Read a validated own-property off an unvalidated thrown value — the same
 * "own-properties only, never `.cause`" idiom as
 * `core/runner/mission-error-signal.ts` / `inference/openrouter/errors.ts`,
 * duplicated locally (not imported) so this foundational, DB/inference-free
 * types file never depends on the runner layer.
 */
function ownProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Errno-shaped code guard — mirrors `lib/error-cause.ts` (not exported there; duplicated). */
const ERRNO_SHAPE = /^[A-Z][A-Z0-9_]{2,59}$/;

function validatedStatusCode(cause: unknown): number | null {
  for (const key of ["status", "statusCode"]) {
    const v = ownProperty(cause, key);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function validatedCauseCode(cause: unknown): string | null {
  const v = ownProperty(cause, "causeCode");
  return typeof v === "string" && ERRNO_SHAPE.test(v) ? v : null;
}

/**
 * Enum-label shape for the provider's `ApiErrorType` — mirrors the cap in
 * `inference/openrouter/provider-signals.ts` (not imported: no inference
 * dependency from this file). An OPEN enum, so any plausible label survives.
 */
const ENUM_LABEL_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

function validatedErrorType(cause: unknown): string | null {
  const v = ownProperty(cause, "errorType");
  return typeof v === "string" && ENUM_LABEL_SHAPE.test(v) ? v : null;
}

/**
 * SDK class names are a CLOSED dictionary, but checking membership here would
 * mean duplicating that 24-name vocabulary into this inference-free file. The
 * closed check already ran where the value was captured
 * (`inference/openrouter/error-class.ts`) and runs AGAIN as a `z.enum` at the
 * IPC boundary; this layer only needs to guarantee the value is a bounded
 * class-name-shaped token and not a smuggled message.
 */
const CLASS_NAME_SHAPE = /^[A-Z][A-Za-z0-9]{2,63}$/;

function validatedErrorClass(cause: unknown): string | null {
  const v = ownProperty(cause, "errorClass");
  return typeof v === "string" && CLASS_NAME_SHAPE.test(v) ? v : null;
}

function validatedRetryAfterSeconds(cause: unknown): number | null {
  const v = ownProperty(cause, "retryAfterSeconds");
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Recoverable failure surfaced by `startMission` / `resumeMissionRun` when a
 * provider call (or the surrounding hydrate / status update / prompt prep)
 * throws. The run is persisted in `paused_error` first, then this error is
 * re-thrown so shell action wrappers map it to `{ ok:false }` and the UI
 * shows a real failure with a recovery hint instead of a fake "started" line.
 *
 * Carries the original `cause` so callers can inspect or surface it.
 */
export class MissionRunPausedError extends Error {
  readonly runId: string;
  readonly missionId: string;
  readonly sessionId: string;
  /**
   * Lean, validated signals copied from `cause` (never the cause object
   * itself) so a shell action wrapper that only sees THIS error — not the
   * original normalized provider error — can still branch on transport/HTTP
   * shape (e.g. the chat IPC error mapper mapping 401/429/5xx to a specific
   * user-facing code). `null` when `cause` carries no matching validated
   * own-property. Never exposes anything else from `cause`.
   */
  readonly statusCode: number | null;
  readonly causeCode: string | null;
  /**
   * Provider error taxonomy carried alongside the transport shape, so the app
   * can answer "why did my mission stop" in bounded codes instead of a generic
   * failure. `errorType` is OpenRouter's OPEN `ApiErrorType` (stream path
   * only); `errorClass` names the SDK class that was thrown (the only signal
   * the six status-less shapes have); `retryAfterSeconds` is the provider's
   * own retry hint. All three are `null` when the cause carried nothing.
   */
  readonly errorType: string | null;
  readonly errorClass: string | null;
  readonly retryAfterSeconds: number | null;
  constructor(args: {
    runId: string;
    missionId: string;
    sessionId: string;
    cause: unknown;
  }) {
    const causeMessage =
      args.cause instanceof Error ? args.cause.message : String(args.cause);
    super(causeMessage, { cause: args.cause });
    this.name = "MissionRunPausedError";
    this.runId = args.runId;
    this.missionId = args.missionId;
    this.sessionId = args.sessionId;
    this.statusCode = validatedStatusCode(args.cause);
    this.causeCode = validatedCauseCode(args.cause);
    this.errorType = validatedErrorType(args.cause);
    this.errorClass = validatedErrorClass(args.cause);
    this.retryAfterSeconds = validatedRetryAfterSeconds(args.cause);
  }
}
