/**
 * Tool system types — shared between internal tools and protocol tools.
 *
 * This module defines what a tool looks like to the LLM (ToolDef),
 * what a tool call looks like from the engine (ToolCallRequest),
 * and what a tool returns (ToolResult).
 */

import type { ActionKind } from "./taxonomy.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import type { LendBorrowRiskPreview } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/risk-preview-types.js";

// ── Tool definition (what LLM sees) ─────────────────────────────

/**
 * Session-aware visibility rules for a tool. Orthogonal to `requiresEnv`
 * and `proactive` (those stay as-is). When omitted, the tool
 * is visible under the existing filter chain only — no session-context gating.
 *
 * Evaluated inside `getOpenAITools` against a `ToolVisibilityContext`. Handler
 * code SHOULD still defense-in-depth its own preconditions in `InternalToolContext`
 * (PR-3 extended that too with `sessionKind` + `contextUsageBand`) — the
 * visibility filter only controls what the LLM sees, not what it can be made
 * to attempt.
 */
export interface ToolVisibility {
  /**
   * Minimum context-usage band at which the tool becomes visible.
   * `"warning"` → visible when band is `warning`, `barrier`, or `critical`.
   * `"barrier"` → visible only when band is `barrier` or `critical` (PR2).
   * `"critical"` → visible only when band is `critical`.
   * Undefined → visible in all bands.
   */
  band?: "warning" | "barrier" | "critical";
  /**
   * True → require an active mission run (`missionRunActive === true`).
   * Used by autonomy primitives like `loop_defer` — agent mode never loops.
   */
  requiresMissionActiveRun?: boolean;
  /** True → require an active mission run specifically (same as above today). */
  requiresMissionRun?: boolean;
  /** True → require mission setup/edit (`sessionKind === "mission"` and no active run). */
  requiresMissionSetup?: boolean;
  /** True → hide in `sessionKind === "agent"` sessions. */
  hiddenInAgent?: boolean;
  /** True → hide during mission setup (`sessionKind === "mission"` and no active run). */
  hiddenInMissionSetup?: boolean;
  /**
   * True → hide unless the session has active narrative memory chunks
   * (`ToolVisibilityContext.hasSessionMemory === true`). Used by
   * `session_memory_search` / `session_memory_resolve_item` so they never appear in a
   * fresh session with nothing to recall (chunks are produced by Track-2
   * compaction). The handler still short-circuits as defense-in-depth — this
   * gate only controls what the LLM sees, not what it can be made to attempt.
   */
  requiresSessionMemory?: boolean;
  /**
   * True → show only when session-scoped plan-mode is enabled
   * (`ToolVisibilityContext.planMode === true`). Used by `plan_write` so the
   * plan-authoring tool appears only when the user opted into plan-mode.
   * Combined with `hiddenInMissionSetup` it yields: visible in agent sessions
   * and active mission runs (plan-mode on), hidden during mission setup and
   * whenever plan-mode is off. The handler also re-checks DB state as
   * defense-in-depth — this gate only controls what the LLM sees.
   */
  requiresPlanMode?: boolean;
  /**
   * True → hide unless the session has an active Uniswap fallback reveal
   * (`ToolVisibilityContext.sessionId` checked against
   * `registry/uniswap-reveal.js`'s `isUniswapPairRevealed`). Used by the
   * hidden `swap_quote_uniswap` / `swap_execute_uniswap` pair (plan §11.2):
   * absent from the default tool list until an eligible KyberSwap
   * route-not-found failure reveals it for that session. The dispatcher
   * ALSO hard-rejects a direct dispatch attempt independent of this gate —
   * this flag only controls what the LLM sees.
   */
  requiresUniswapReveal?: boolean;
  /**
   * True → show only when the session has a VALIDATED prepared compaction
   * summary (`ToolVisibilityContext.hasCompactionSummaryReady === true`).
   * Used by `compact_apply`, whose whole precondition is readiness rather
   * than a pressure band: preparation routinely completes while the session
   * is still in the warning band, and hiding the tool until barrier would
   * withhold the cheapest moment to take it.
   *
   * Deliberately NOT a band gate: that would key the tool off pressure,
   * which is the wrong axis here.
   */
  requiresSummaryReady?: boolean;
}

/**
 * Pressure-safety classification — orthogonal to `mutating`.
 *
 * `mutating` is permission-gated (restricted vs full session permission)
 * and tells the approval queue whether the call needs explicit user
 * approval. `pressureSafety` is band-gated (PR2) and tells the dispatcher
 * whether the call is allowed when context pressure forces a compaction
 * before further work.
 *
 * Bands `barrier` and `critical` block calls where `pressureSafety ===
 * "mutating"`. `read_only` and `safe_at_barrier` pass through.
 */
export type PressureSafety =
  | "safe_at_barrier"
  | "read_only"
  | "mutating";

export interface ToolDef {
  /** Unique tool name — used by LLM in tool_calls */
  name: string;
  /** Human-readable description for LLM context */
  description: string;
  /** JSON Schema for parameters */
  parameters: JsonSchema;
  /** Internal = handled in-process, protocol = via discover+execute */
  kind: "internal" | "protocol";
  /** Whether this tool modifies state (trades, transfers, posts). Permission-gated. */
  mutating: boolean;
  /**
   * Pressure-safety classification. REQUIRED — every tool MUST be deliberately
   * classified so the dispatcher knows whether to block at barrier/critical.
   */
  pressureSafety: PressureSafety;
  /**
   * Action taxonomy — explicit side-effect classification (see `./taxonomy.ts`).
   * REQUIRED — every tool MUST be deliberately classified so puzzle 5 phase 2+
   * (approval intents, wallet intents, audit) can make policy decisions
   * without re-deriving from the loose `mutating` boolean. Mirrors the
   * `pressureSafety` invariant: the compiler enforces classification at
   * registration time.
   */
  actionKind: ActionKind;
  /** If true, tool is only available in restricted/full modes */
  proactive?: boolean;
  /** ENV var required for this tool. If set and ENV is empty, tool is hidden. */
  requiresEnv?: string;
  /** Show tool ONLY when this env var is NOT set. Inverse of requiresEnv. For setup/config tools. */
  showOnlyWhenEnvMissing?: string;
  /**
   * Session-aware visibility rules. When omitted, the tool is subject only
   * to the existing filter chain (requiresEnv, proactive).
   * See `ToolVisibility` for the individual gates.
   */
  visibility?: ToolVisibility;
}

/**
 * Property value within a JsonSchema. Recursive — supports nested objects
 * (`properties`/`required`/`additionalProperties`) and arrays (`items`).
 *
 * Phase 0 widened this from the original 3-field shape (`{type, description?, enum?}`)
 * to support strict-mode requirements from OpenAI/Azure: `items` on arrays is
 * mandatory, `additionalProperties: false` must be settable on nested objects.
 * The full per-provider projection layer (Phase 1 of the long-term plan) builds
 * on this baseline shape.
 */
interface JsonSchemaPropertyShape {
  description?: string;
  enum?: string[];
  /** Schema of array elements. Required by OpenAI strict + Azure when type === "array". */
  items?: JsonSchemaProperty;
  /** Nested-object property map. */
  properties?: Record<string, JsonSchemaProperty>;
  /** Required keys of a nested object. */
  required?: string[];
  /** When false on an object, rejects extra keys (OpenAI strict requirement). */
  additionalProperties?: boolean;
}

/** The ordinary single-`type` property — what almost every param compiles to. */
export interface JsonSchemaTypedProperty extends JsonSchemaPropertyShape {
  type: string;
  anyOf?: never;
}

/**
 * A property that accepts one of several shapes, e.g. a param declared
 * `acceptsStringArray` compiling to string | string[].
 *
 * `type` is ABSENT here by construction. JSON Schema conjoins sibling keywords,
 * so emitting `type: "string"` beside an `anyOf` carrying an array branch makes
 * the array branch unsatisfiable — the model would be shown a union it can never
 * validly fill. The two variants are split so that mistake cannot be typed.
 */
export interface JsonSchemaUnionProperty extends JsonSchemaPropertyShape {
  type?: never;
  anyOf: JsonSchemaProperty[];
}

export type JsonSchemaProperty = JsonSchemaTypedProperty | JsonSchemaUnionProperty;

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  /** Top-level strictness flag. Per-provider projection sets this defensively. */
  additionalProperties?: boolean;
}

// ── Tool call (from engine to dispatcher) ────────────────────────

export interface ToolCallRequest {
  /** Tool name — matches ToolDef.name */
  name: string;
  /** Parsed arguments from LLM */
  args: Record<string, unknown>;
  /** Tool call ID from provider — must be preserved for round-trip */
  toolCallId: string;
}

// ── Tool result (from handler back to engine) ────────────────────

export interface ToolResult {
  /** Whether the tool executed successfully */
  success: boolean;
  /** Output text to show to LLM */
  output: string;
  /** Structured data (optional — for trade capture, UI enrichment) */
  data?: Record<string, unknown>;
  /** If true, tool queued for approval instead of executing */
  pendingApproval?: boolean;
  /** Engine signal — structured command from tool to engine (e.g. stop_mission) */
  engineSignal?: EngineSignal;
  /**
   * Action taxonomy stamp — what kind of action this dispatch actually performed
   * (see `./taxonomy.ts`). Stamped by:
   *  - `dispatchTool` as a fallback from `getActionKind(toolName)` for internal
   *    tools when the handler did not set it,
   *  - `executeProtocolTool` from the TARGET protocol manifest (NOT from the
   *    `execute_tool` wrapper's own classification), on every known-manifest
   *    return path (approval-pending, pressure-denied, param-invalid, success,
   *    handler-thrown failure). Unknown protocol tool returns omit the field.
   *
   * Policy / approval / audit layers (puzzle 5 phase 2+) consume this field
   * to classify what actually happened, regardless of which wrapper was called.
   * Kept top-level rather than nested under `data` because `data` is handler
   * payload (trade capture, UI enrichment) and should not be polluted with
   * policy metadata (Codex review, puzzle 5/1A, 2026-05-23).
   */
  actionKind?: ActionKind;
  /**
   * Stage-7 prequote-gate binding. Set ONLY by `executeProtocolTool` when the
   * execute-time prequote gate ALLOWS a swap execute and the call still needs
   * restricted-mode approval — it carries the matched prequote's safety
   * `verdict` (`pass` or `unknown`; a `fail` blocks at the gate and never
   * reaches here) onto the `pendingApproval` result. The turn-loop passes this
   * TYPED field into `buildIntentPreview` so the human sees the safety verdict
   * (especially `unknown` → "UNVERIFIED") in the approval preview before
   * approving. It is NOT sourced from raw tool args, so the renderer preview's
   * allow-listed `criticalArgs` can never be spoofed by the LLM (Stage 7 R5,
   * Codex guardrail #3).
   *
   * `fotTax` (Stage 9 safety doctrine) carries the MAX fee-on-transfer tax
   * (percent) across the matched prequote's EVM legs when any leg is a
   * fee-on-transfer token. Because FoT is no longer a verdict `fail` (only a
   * CONFIRMED honeypot blocks), a restricted human would otherwise see "safety:
   * pass" and miss a high tax — so the gate threads this through the same TYPED
   * channel (never raw args) for the preview to disclose. Bounded number,
   * EVM-only, omitted when there is no fee-on-transfer leg.
   */
  prequote?: {
    /**
     * REQUIRED (reverted in card B3 — Codex batch-5 blocker on B1's
     * required→optional widening): every caller that sets `prequote` has a
     * matched swap/bridge safety verdict. `solana.lend.borrowOperate` has NO
     * matched swap/bridge prequote at all (it is not a swap-gated tool), so
     * its LTV/health disclosure rides its OWN top-level `riskPreview` sibling
     * field below instead of living inside `prequote` — see `runtime/gates.ts`'s
     * `evaluateRiskPreview`.
     */
    readonly verdict: SafetyVerdict;
    readonly fotTax?: number;
    /**
     * Pendle term-lock (Wave 5) — the maturity date of a PT being bought. Sourced
     * from the matched prequote's persisted `safetyDetail` (NOT raw args), it
     * rides this typed channel into `buildIntentPreview`, which renders the FIXED
     * "funds locked until <date>" warning so a restricted human sees the lock
     * before approving. Unspoofable by construction (never read from args).
     */
    readonly termLock?: { readonly maturityIso: string };
    /**
     * Jupiter fee-bearing swap disclosure (W5 design §6 R4) — the 25bps fee,
     * fee mint + treasury ATA, ATA rent (if the account does not yet exist),
     * tip, and priority-fee strategy for a `solana.swap.execute`. Sourced from
     * the matched prequote's persisted `safetyDetail` (NOT raw args), it rides
     * this typed channel into `buildIntentPreview` so a restricted human sees
     * the full economic disclosure before approving.
     */
    readonly feePreview?: JupiterFeePreview;
  };
  /**
   * Jupiter Lend Borrow LTV/health disclosure (Agent Scan Phase 3 Batch 5,
   * card B1 owner decision: "Approval preview MUST show LTV/health risk
   * semantics before approval") for a `solana.lend.borrowOperate` call. A
   * SIBLING of `prequote` (card B3 — `solana.lend.borrowOperate` has no
   * matched swap/bridge verdict, so `prequote.verdict` stays required for
   * every OTHER caller instead of being widened to accommodate this one).
   * Computed fresh (never persisted) by `runtime/gates.ts`'s
   * `evaluateRiskPreview`, sourced from a live vault/position/price read —
   * NOT from raw args — so it rides this unspoofable typed channel into
   * `buildIntentPreview`.
   */
  riskPreview?: LendBorrowRiskPreview;
  /**
   * Trusted one-step handoff from a successful non-mutating prepare tool to
   * its mutating execution tool. The turn loop validates the source→target
   * pair and canonicalizes the args through the registry before dispatch.
   * This is handler-authored data; it is never populated from model output.
   */
  preparedActionFollowUp?: PreparedActionFollowUp;
}

export type ApprovalPreviewScalar = string | number | boolean | null;

export interface PreparedActionFollowUp {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Earliest expiry of the prepared action, carried into approval TTL. */
  readonly expiresAt: string;
  /** Trusted, renderer-safe preview sourced from validated prepared state. */
  readonly approvalPreview: {
    readonly toolName: string;
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

/**
 * Structured signal from an internal tool to the engine runtime.
 *
 * - stop_mission: parent mission stop (business stop reason)
 * - defer_until: the agent wants to sleep until a wake time (loop_defer)
 * - compact_committed: a compaction archived the conversation prefix, updated
 *   the rolling summary, and enqueued a Track 2 chunking job (PR2). Turn-loop
 *   drains remaining tool calls in the batch with `batch_aborted_by_compact`,
 *   reloads live messages, merges operator interrupts, updates
 *   `mission_runs.last_checkpoint_at`, and injects a deterministic resume
 *   packet for `POST_COMPACT_BRIDGE_CYCLES` subsequent turns.
 * - plan_pause: a `plan_write` in an ACTIVE mission run created/changed a plan
 *   that is not user-accepted. Turn-loop maps it to a `plan_acceptance_pause`
 *   tool-batch outcome → flips the run to `paused_plan_acceptance` (stop reason
 *   `plan_acceptance_required`); once accepted the run resumes via `plan.accept`
 *   or any control resume path, never a user chat message. Uses the existing
 *   `reason`/`summary`; the run is identified by session/missionRunId so no
 *   extra payload is needed.
 */
export interface EngineSignal {
  type:
    | "stop_mission"
    | "defer_until"
    | "compact_committed"
    | "plan_pause";
  reason: string;
  summary: string;
  evidence?: Record<string, unknown>;
  /** For defer_until: ISO8601 timestamp when the wake executor should resume the session. */
  dueAt?: string;
  /** For compact_committed: the freshly-bumped sessions.checkpoint_generation value. */
  generation?: number;
  /** For compact_committed: the compact_job id enqueued for Track 2 chunking, or null on cooldown noop. */
  jobId?: number | null;
}

// ── OpenAI-compatible tool format (for inference providers) ──────

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

/** Convert ToolDef[] to OpenAI tools format for inference API */
export function toOpenAITools(tools: readonly ToolDef[]): OpenAITool[] {
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
