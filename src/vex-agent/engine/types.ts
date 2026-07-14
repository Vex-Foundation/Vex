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
  | "waiting_for_parent"
  | "waiting_for_wake"
  | "waiting_for_compact_commit"
  | "compact_unable_at_critical"
  | "system_error"
  /** User requested pause at the next safe checkpoint (puzzle 03). */
  | "user_paused"
  /** Plan-mode: agent wrote/changed a plan that needs user acceptance before
   *  execution can resume. Resumed only by the `plan.accept` IPC. */
  | "plan_acceptance_required";

export type StopReason = BusinessStopReason | RuntimeStopReason;

// ── Message taxonomy ────────────────────────────────────────────

export type MessageSource =
  | "user"
  | "assistant"
  | "engine"
  | "tool"
  | "subagent"
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
  | "subagent_relay"
  | "tool_result";

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
  /** Optional, host-accepted Hyperliquid envelope for an autonomous mission. */
  hyperliquidRisk?: import("../../lib/hyperliquid-policy.js").HyperliquidMissionRisk | null;
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
 * enforced at wallet resolution. NOT gated on `sessionKind` — a subagent with
 * `sessionKind: "agent"` still inherits the parent's mission policy.
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
   * gate (`tools/protocols/runtime.ts`, `tools/internal/wallet/send.ts`, and
   * any subagent-spawn check) reads this single value rather than re-querying
   * the DB or threading a stale `loopMode` through.
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
  isSubagent: boolean;
  /** Per-session selected wallets (id + address), hydrated from the session row. */
  selectedEvmWallet: { id: string; address: string } | null;
  selectedSolanaWallet: { id: string; address: string } | null;
  /** Mission wallet policy (snapshot-derived); enforced at wallet resolution. */
  walletPolicy: WalletPolicy;
  loadedDocuments: Map<string, string>;
  /**
   * Agent display/identity name from the user persona file. Set by hydration;
   * optional so non-hydrated/test contexts fall back to the default ("Vex") in
   * `buildIdentityPrompt`. Local-first user config — never widens permissions
   * (style/name only).
   */
  personaName?: string;
  /**
   * Free-form persona/tone block from the user persona file, or null when
   * unconfigured. Optional for the same reason as `personaName`. Rendered as
   * subordinate style guidance in the prompt (after the authoritative
   * safety/permission layers).
   */
  personaBlock?: string | null;
  /**
   * True when the user configured a persona (custom name OR block). Set by
   * hydration. Gates the one-time persona-setup offer so a name-only persona is
   * not treated as "unconfigured". Optional → `undefined` is treated as false.
   */
  personaConfigured?: boolean;
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
  subagentId?: string;
}
