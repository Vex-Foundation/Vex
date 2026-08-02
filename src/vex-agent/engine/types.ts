/**
 * Engine types — pure domain types for the engine layer.
 *
 * No DB imports, no inference imports. These types define the
 * engine's vocabulary: session axes, mission lifecycle, stop
 * conditions, message taxonomy, and context contracts.
 */

// ── Session axes ────────────────────────────────────────────────

/**
 * Engine-level session discriminator.
 *
 * `"agent"` is a one-shot conversational session (may use tools, may execute
 * tx subject to `Permission`). `"mission"` is a goal-driven session that
 * runs in a loop (agent self-schedules wake via `loop_defer`).
 *
 * The session-level `mode` column on `sessions` is the source of truth;
 * this type is propagated through `EngineContext`, `InternalToolContext`,
 * and `ProtocolExecutionContext` so tool visibility and prompt shaping can
 * branch on it. Immutable per session.
 */
export type SessionKind = "agent" | "mission";

/**
 * Session-scoped approval policy. Replaces the previous `LoopMode` tri-state
 * (`off|restricted|full`) — the `off` arm collapses into `mode === "agent"`
 * (no loop), and `restricted | full` becomes its own immutable axis.
 *
 *  - `"restricted"` — every mutating tool requires user approval (default)
 *  - `"full"` — mutating tools auto-execute without approval
 *
 * Immutable per session; set at session creation.
 */
export type Permission = "restricted" | "full";

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

// ── Stop conditions ─────────────────────────────────────────────

export type BusinessStopReason =
  | "goal_reached"
  | "deadline_reached"
  | "capital_depleted"
  | "max_loss_hit"
  | "no_viable_opportunity"
  | "emergency_stop"
  | "user_stopped";

export type RuntimeStopReason =
  | "approval_required"
  | "checkpoint_pause"
  | "iteration_limit"
  | "timeout"
  | "waiting_for_wake"
  | "waiting_for_compact_commit"
  | "compact_unable_at_critical"
  | "system_error"
  /** User requested pause at the next safe checkpoint (puzzle 03). */
  | "user_paused"
  /** Plan-mode: agent wrote/changed a plan that needs user acceptance before
   *  execution can resume. Resumed only by the `plan.accept` IPC. */
  | "plan_acceptance_required"
  /**
   * §C3b: the agent opened a launch form and the turn is parked until the human
   * answers it. Sibling of `approval_required` — the call it stopped on has no
   * transcript result yet, and `resumeAgentAfterUserForm` appends the only one.
   */
  | "user_form_required";

export type StopReason = BusinessStopReason | RuntimeStopReason;

// ── Message taxonomy ────────────────────────────────────────────

export type MessageSource =
  | "user"
  | "assistant"
  | "engine"
  | "tool"
  | "system";

export type MessageType =
  | "chat"
  /** A chat turn whose streaming was stopped mid-response (Stage 9-5a). */
  | "chat_stopped"
  | "mission_setup"
  | "mission_summary"
  | "mission_recovered"
  | "mission_started"
  | "operator_interrupt"
  | "approval_pause"
  | "continue"
  | "checkpoint"
  | "wake_due"
  | "tool_result"
  /**
   * A trusted prepare→execute handoff the engine synthesized itself (never
   * model output — see `dispatchPreparedActionFollowUp`). Paired with
   * `source: "engine"` on the same assistant-role row so an auditor reading
   * `messages` directly can never mistake it for a real model-authored
   * tool_call, even though the row keeps `role: "assistant"` for the
   * provider transcript format.
   */
  | "prepared_action_follow_up"
  /**
   * Engine cue injected when an approval decision has been resolved and its
   * tool result is already in the transcript — the agent is being woken to
   * continue from it. Distinct from `operator_interrupt` (which means the user
   * cut in) and from `approval_pause` (which means the run STOPPED to ask).
   */
  | "approval_resolved";

export type MessageVisibility = "user" | "internal";

// ── Mission draft — domain model (camelCase, typed) ─────────────

/** Required fields for a mission to transition from draft → ready. */
export interface MissionDraft {
  title: string | null;
  goal: string | null;
  capitalSource: string | null;
  startingCapital: string | null;
  allowedWallets: string[] | null;
  allowedChains: string[] | null;
  allowedProtocols: string[] | null;
  riskProfile: string | null;
  successCriteria: string[] | null;
  stopConditions: string[] | null;
  /** Optional — mission may have no deadline. */
  deadline: string | null;
  /**
   * Optional hard time-box in whole minutes. The turn-loop deadline
   * enforcer stops the run at `started_at + this` (see
   * `engine/mission/mission-deadline.ts`). Absent -> env override -> 60min
   * default. Distinct from `deadline` (free-text, informational only).
   */
  durationMinutes: number | null;
  /**
   * Enforceable spend ceiling for an autonomous token launch (C6), as a RAW
   * integer amount string paired with {@link maxLaunchValueDecimals}. `null`
   * means NO CEILING SET, which FAILS CLOSED — it is not "unlimited".
   * HOST-AUTHORED ONLY (deliberately absent from `patch-parser.ts`).
   * Units, the decimals===18 requirement and the comparison itself live in
   * `engine/mission/launch-ceiling.ts` — read it before using either field.
   */
  maxLaunchValueRaw: string | null;
  /** Decimals for {@link maxLaunchValueRaw}. Must be 18 to be enforceable. */
  maxLaunchValueDecimals: number | null;
  /**
   * How many tokens the agent may create in this mission (C6b). A
   * non-negative whole number; `null` means NO CEILING SET and FAILS CLOSED,
   * exactly like {@link maxLaunchValueRaw} — a mission that was never set up
   * to create tokens can never create one unattended.
   *
   * The value ceiling alone is not enough: a loop that stays under the
   * per-launch cap could still mint dozens of tokens. HOST-AUTHORED ONLY
   * (deliberately absent from `patch-parser.ts`); enforcement lives in
   * `engine/mission/launch-ceiling.ts`.
   */
  maxLaunchCount: number | null;
}

/**
 * Required fields that must be non-null for draft → ready transition.
 * `deadline` is intentionally excluded — it's optional.
 */
export const MISSION_DRAFT_REQUIRED_FIELDS: readonly (keyof MissionDraft)[] = [
  "title",
  "goal",
  "capitalSource",
  "startingCapital",
  "allowedWallets",
  "allowedChains",
  "allowedProtocols",
  "riskProfile",
  "successCriteria",
  "stopConditions",
] as const;

// ── Mission patch — untrusted model output ──────────────────────

/** Raw patch from model — must be validated/sanitized before DB write. */
export interface MissionPatch {
  [key: string]: unknown;
}

// ── Engine context ──────────────────────────────────────────────

/**
 * Mission wallet policy, resolved once at hydration (puzzle 5 phase 5B) and
 * enforced at wallet resolution. NOT gated on `sessionKind` — it rides the
 * explicit `WalletPolicy` value.
 *   - none: not under a mission → no mission-level wallet restriction.
 *   - mission_allowed: wallet must be in the accepted contract's allowedWallets.
 *   - invalid: under a mission but the active-run snapshot is missing /
 *     malformed / has empty allowedWallets → fail closed (contract drift).
 */
export type WalletPolicy =
  | { kind: "none" }
  | { kind: "mission_allowed"; allowedWallets: string[] }
  | { kind: "invalid"; reason: string };

/** Passed to runner, turn, prompt stack — everything the engine needs. */
export interface EngineContext {
  sessionId: string;
  sessionKind: SessionKind;
  /**
   * Session-scoped approval policy, hydrated once from `sessions.permission`
   * at engine entry. Immutable for the duration of the turn — every approval
   * gate (`tools/protocols/runtime.ts`, `tools/internal/wallet/send.ts`)
   * reads this single value rather than re-querying the DB or threading a
   * stale `loopMode` through.
   */
  sessionPermission: Permission;
  missionId: string | null;
  missionRunId: string | null;
  /** Session creation time from DB; used only for runtime clock prompt context. */
  sessionStartedAt?: string | null;
  /** Active mission run start time from DB; null outside active mission runs. */
  missionRunStartedAt?: string | null;
  /** Optional mission deadline from the frozen mission constraints. */
  missionDeadline?: string | null;
  /** Per-session selected wallets (id + address), hydrated from the session row. */
  selectedEvmWallet: { id: string; address: string } | null;
  selectedSolanaWallet: { id: string; address: string } | null;
  /** Mission wallet policy (snapshot-derived); enforced at wallet resolution. */
  walletPolicy: WalletPolicy;
  loadedDocuments: Map<string, string>;
  /**
   * How the agent should address the user, from the DB-backed "Vex setup"
   * user profile (`soul` singleton). Set by hydration; optional so
   * non-hydrated/test contexts render without it. Advisory style only — never
   * widens permissions.
   */
  userDisplayName?: string | null;
  /**
   * User's standing style/preference instructions from the user profile, or
   * null when unconfigured. Optional for the same reason as
   * `userDisplayName`. Rendered as subordinate style guidance in the prompt
   * (after the authoritative safety/permission layers) — never overrides
   * tool, permission, mission, approval, or safety rules.
   */
  userInstructionsMd?: string | null;
  /**
   * Short self-description of the user's work, from the user profile, or
   * null when unconfigured. Optional for the same reason as
   * `userDisplayName`. Advisory context only.
   */
  userWorkDescription?: string | null;
  /**
   * Preferred tone/register from the user profile ("Vex setup" 043), or null
   * when unconfigured. Optional for the same reason as `userDisplayName`.
   * Advisory style guidance only, rendered as a subordinate identity-layer
   * line; an unrecognized token is silently skipped at render time (see
   * `engine/prompts/identity.ts`) rather than surfaced. Never widens
   * permissions or changes tool/approval/safety behavior.
   */
  userStylePreset?: string | null;
  /**
   * Self-described style traits from the user profile ("Vex setup" 043,
   * e.g. "warm", "emoji"), or an empty array when none are set. Optional for
   * the same reason as `userDisplayName`. Advisory style guidance only;
   * unrecognized tokens are silently skipped at render time.
   */
  userCharacteristics?: readonly string[];
  /**
   * Self-described risk appetite from the user profile ("Vex setup" 043), or
   * null when unconfigured. Optional for the same reason as
   * `userDisplayName`. Shapes TONE only — the identity layer renders an
   * explicit disclaimer that it never changes approval requirements, limits,
   * or safety behavior.
   */
  userRiskAppetite?: string | null;
  /**
   * Plan-mode (session-scoped). Set by hydration as the turn-start snapshot
   * driving tool visibility and the `# Active Plan` prompt layer. Optional so
   * non-hydrated/test contexts default to plan-mode OFF.
   *
   * NOTE: the dispatcher's hard execution gate does NOT read `planAccepted`
   * from here — it does a live per-call repo read, because a `plan_write` can
   * invalidate acceptance mid-batch (esp. in agent mode, which does not pause).
   * These fields are the model-facing snapshot only.
   */
  planMode?: boolean;
  /** Active plan markdown for this session, or null when none/disabled. */
  planMd?: string | null;
  /** True when the current `planMd` has been user-accepted (snapshot). */
  planAccepted?: boolean;
}

// ── Turn result ─────────────────────────────────────────────────

/** Returned from engine entry points (processAgentTurn, startMission, etc.) */
export interface TurnResult {
  /** Text response from model — null when only tool calls were made. */
  text: string | null;
  /** Number of tool calls dispatched during this turn/loop. */
  toolCallsMade: number;
  /** Approval IDs enqueued during this turn (for restricted mode). */
  pendingApprovals: string[];
  /** If the run stopped, the reason. Null if still running or chat mode. */
  stopReason: StopReason | null;
  /** Current mission status after this turn. Null for chat sessions. */
  missionStatus: MissionStatus | null;
}

// ── Message metadata ────────────────────────────────────────────

/** Engine metadata attached to messages — extends the base message model. */
export interface MessageMetadata {
  source?: MessageSource;
  messageType?: MessageType;
  visibility?: MessageVisibility;
  originSessionId?: string;
  /**
   * Free-form envelope persisted into the `messages.metadata` JSONB column —
   * the ONLY part of this type that reaches it (db/repos/messages/write.ts).
   * Mirrors the repo-level `MessageMetadata.payload`; every producer defines
   * its own shape in code and every reader treats it as untrusted.
   */
  payload?: Record<string, unknown>;
}

// ── Resumed-turn consumption claim ──────────────────────────────

/**
 * Guard hook for a turn that resumes previously-recorded work — today, an
 * approval whose tool result is already sitting in the transcript.
 *
 * The lease-held turn core calls it ONCE, at the moment it actually begins
 * consuming that result: after the transcript is loaded and immediately before
 * the model call. Returning `false` means an EARLIER attempt already carried
 * this resume through to completion, and the core must abandon the turn without
 * calling the model.
 *
 * It is a read, not a claim, and the core writes nothing when it returns
 * `true`. The durable marker is written by the caller AFTER the core returns,
 * because "a resume started" and "a resume finished" are different facts:
 * ending eligibility at the start makes a crash anywhere in the rest of the
 * turn permanent, and concurrent resumes are already impossible — the caller
 * holds the session/run runner lease across the whole call.
 */
export type ResumedTurnClaim = () => Promise<boolean>;
