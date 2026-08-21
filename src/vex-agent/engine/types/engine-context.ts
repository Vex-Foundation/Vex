/**
 * Engine context — the wallet policy, the context passed through the engine,
 * the turn result, and the resumed-turn claim hook.
 *
 * Implementation detail of `engine/types.ts`; import from there.
 */

import type { MissionBaseline } from "../mission/baseline.js";
import type { MissionStatus } from "./mission-lifecycle.js";
import type { Permission, SessionKind } from "./session.js";
import type { StopReason } from "./stop-reasons.js";

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
   * from here — it does a live per-call repo read, because a `PlanWrite` can
   * invalidate acceptance mid-batch (esp. in agent mode, which does not pause).
   * These fields are the model-facing snapshot only.
   */
  planMode?: boolean;
  /** Active plan markdown for this session, or null when none/disabled. */
  planMd?: string | null;
  /** True when the current `planMd` has been user-accepted (snapshot). */
  planAccepted?: boolean;
  /**
   * The active run's frozen start-of-run capital baseline, parsed at hydration
   * from the run row that was already loaded (no extra query). `null` means the
   * run has no readable baseline - a pre-migration run, or a blob that failed
   * its schema - and consumers must say the start value is unknown rather than
   * assume one. Optional so non-hydrated/test contexts render without it.
   *
   * TYPE-ONLY import of a `engine/mission` type: the baseline schema owns its
   * own shape and must not be restated here, and an erased import creates no
   * runtime edge out of `engine/types/`.
   */
  missionBaseline?: MissionBaseline | null;
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
