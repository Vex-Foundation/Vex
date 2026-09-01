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
   * Used by autonomy primitives that only a mission run can act on.
   */
  requiresMissionActiveRun?: boolean;
  /**
   * True → require a session that can act on its own between user messages:
   * an active mission run, OR an agent session with `permission: "full"`.
   *
   * Owner decree 2026-08-03, from the live "unlimited thoughts" incident. The
   * only tool wearing this gate is `LoopDefer`, and the incident was exactly
   * its absence: a Full-Autonomous agent session waiting for a bridge to fill
   * had no way to sleep, so it burned iterations re-reading state that could
   * not have changed yet. The substrate always supported the shape — the wake
   * row's `mission_run_id` is nullable and the executor has an agent-session
   * branch — only the agent-facing tool was withheld.
   *
   * RESTRICTED agent sessions stay excluded on purpose: a human is in the loop
   * there, so parking removes the user's turn and buys no autonomy.
   */
  requiresAutonomousLoop?: boolean;
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
   * `SessionMemorySearch` / `SessionMemoryResolve` so they never appear in a
   * fresh session with nothing to recall (chunks are produced by Track-2
   * compaction). The handler still short-circuits as defense-in-depth — this
   * gate only controls what the LLM sees, not what it can be made to attempt.
   */
  requiresSessionMemory?: boolean;
  /**
   * True → show only when session-scoped plan-mode is enabled
   * (`ToolVisibilityContext.planMode === true`). Used by `PlanWrite` so the
   * plan-authoring tool appears only when the user opted into plan-mode.
   * Combined with `hiddenInMissionSetup` it yields: visible in agent sessions
   * and active mission runs (plan-mode on), hidden during mission setup and
   * whenever plan-mode is off. The handler also re-checks DB state as
   * defense-in-depth — this gate only controls what the LLM sees.
   */
  requiresPlanMode?: boolean;
  /**
   * True → show only when the session has a VALIDATED prepared compaction
   * summary (`ToolVisibilityContext.hasCompactionSummaryReady === true`).
   * Used by `CompactApply`, whose whole precondition is readiness rather
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
  /**
   * VALUE BOUNDS, all optional and all unset by the provider-facing compiler
   * (`registry/khalani.ts::paramsToJsonSchema`) - nothing that reaches a model
   * provider emits them today, so adding them changes no existing schema byte.
   *
   * They exist for the STRICT MCP projection
   * (`mcp/inventory/strict-schema.ts`), whose contract is that anything its
   * schema admits, `validateProtocolParams` also admits. Expressing the
   * runtime's own bounds is the only way that can be true: a basis-point param
   * the runtime requires to be a whole non-negative number cannot be advertised
   * as a bare `number`, and a `minItems`-less array advertises an empty list the
   * runtime rejects.
   */
  minimum?: number;
  multipleOf?: number;
  minItems?: number;
  minLength?: number;
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

/**
 * A refusal cause a caller can act on programmatically. Closed union: a new
 * variant is a deliberate contract change with its own producer and consumers.
 */
export type ToolFailure = {
  readonly kind: "configuration_unavailable";
  /** Env variable NAMES that must be set. Never values. */
  readonly env: readonly string[];
};

/**
 * The quote-time spendability facts, as the tool vocabulary states them.
 *
 * Typed structurally rather than by importing the protocol module: `types.ts`
 * is the tool vocabulary and must not depend on one protocol family's
 * implementation. The producing module's `SpendabilityPreview`
 * (`protocols/quote-authority/spendability-contract.ts`) is assignable to this,
 * and the compiler checks that at the assignment - so the two cannot drift
 * without a build failure.
 *
 * QUOTE-TIME ONLY. It states what a chain read said when the quote was taken;
 * the authoritative debit check belongs to the pre-sign window, and the
 * rendered card line says so in words.
 */
export interface ToolSpendabilityPreview {
  readonly cardVersion: string;
  readonly source: ToolSpendabilityLeg;
  readonly native: ToolSpendabilityLeg;
  /**
   * The transactions the quote's binding will ENFORCE, when the venue sealed a
   * plan (WP2-B). Structural for the same reason as the rest of this shape, and
   * OPTIONAL because a venue with no EVM leg plan (Solana) seals none.
   */
  readonly debitPlan?: ToolDebitPlan;
}

/**
 * The bound transaction set of a quote, as the tool vocabulary states it.
 *
 * The producing module's `BoundDebitPlan`
 * (`protocols/quote-authority/debit-plan.ts`) is assignable to this and the
 * compiler checks that at the assignment. Gas UNITS are absent by design: they
 * are an execute-time fact (2.07x measured block-to-block drift), so what is
 * bound is the ROLE set, the per-gas ceilings and the reserve's identity.
 */
export interface ToolDebitPlan {
  readonly legs: readonly {
    readonly role: "allowance_reset" | "allowance" | "swap" | "swap_fee";
    readonly feeCap: ToolLegFeeCap;
    /**
     * How the leg's gas units were reached: `measured` from a live estimate of
     * that exact call, `conservative` from the venue's own quoter plus headroom
     * when the call could not be simulated yet. A leg with NEITHER cannot reach
     * a bound plan - the quote that would have carried one is not executable.
     */
    readonly pricing: "measured" | "conservative";
  }[];
  readonly reserve: {
    readonly kind: "zero_value_self_transfer";
    readonly feeCap: ToolLegFeeCap;
  };
}

/** A per-gas ceiling in exact base-10 wei strings, never a float (rule 90). */
export type ToolLegFeeCap =
  | {
      readonly mode: "eip1559";
      readonly maxFeePerGasWei: string;
      readonly maxPriorityFeePerGasWei: string;
    }
  | { readonly mode: "legacy"; readonly gasPriceWei: string };

/** One asset's side of {@link ToolSpendabilityPreview}. */
export interface ToolSpendabilityLeg {
  readonly asset: {
    readonly chainId: number;
    readonly address: string;
    readonly symbol: string | null;
  };
  readonly wallet: string;
  readonly blockTag: "pending" | "latest";
  readonly observedAt: string;
  readonly required: ToolSpendabilityAmount;
  readonly current: ToolSpendabilityAmount;
}

/** An atomic amount travelling with what is needed to read it (rule 90). */
export interface ToolSpendabilityAmount {
  readonly raw: string;
  readonly human: string | null;
  readonly decimals: number | null;
  readonly symbol: string | null;
}

export interface ToolResult {
  /** Whether the tool executed successfully */
  success: boolean;
  /** Output text to show to LLM */
  output: string;
  /** Structured data (optional — for trade capture, UI enrichment) */
  data?: Record<string, unknown>;
  /** If true, tool queued for approval instead of executing */
  pendingApproval?: boolean;
  /**
   * TYPED reason a refusal happened, when the refusal has a machine-readable
   * remedy. Additive and OPTIONAL: `output` stays the authority for a human and
   * for the model, and every existing consumer that reads only `success` /
   * `output` is unaffected.
   *
   * `configuration_unavailable` is set at the ONE place the protocol runtime
   * already refuses a call because a REQUIRED env variable is unset
   * (`protocols/runtime.ts`, the `manifest.requiresEnv` gate). `env` carries the
   * variable NAMES only - a name is configuration, a value is a secret (rule
   * 07). It is never set for an OPTIONAL provider key (a Relay call with no key
   * still runs), and never for a handler-level provider error: those keep their
   * own cause.
   *
   * It exists because a dynamic internal alias can route to a manifest the
   * CALLER could not resolve statically - `SwapQuote` on Solana routes to a
   * Jupiter manifest that requires `JUPITER_API_KEY`, while the alias itself
   * declares no `requiresEnv`. The Studio MCP executor normalizes its own
   * pre-dispatch hint layer and this runtime field into one typed outcome.
   */
  failure?: ToolFailure;
  /**
   * Set by a handler that PARKED the turn on a human form instead of producing
   * an answer (§C3b — `trench.launch_request_form`). Sibling of
   * `pendingApproval` and handled the same way by the tool batch: the call is
   * recorded WITHOUT a result, the rest of the batch is not dispatched, and the
   * ONE result is appended later by the resume that observes the human's answer.
   *
   * A handler that sets this MUST have made the wait durable first (the
   * `awaiting_user_form` intent row), because the transcript deliberately does
   * not carry "waiting" as a state. `intentId` names the row the resume answers.
   */
  pendingUserForm?: { readonly intentId: string };
  /**
   * What an approval for this call would be BOUND TO, rebuilt from the durable
   * intent row by the handler that is asking for it (stage A4b, spec item 2).
   *
   * Set ONLY by the generic signing confirm handlers, ONLY on a
   * `pendingApproval` return, and ONLY from the strictly parsed durable row -
   * never from a caller parameter and never from an in-memory prepare result,
   * which a manual agent call or an MCP client would not have. Both enqueue
   * paths fold it into the canonical approval request digest, so the approval is
   * bound to the exact proposal a human read rather than to a pair of
   * identifiers, and the card carries the decoded preview and the INTENT's own
   * expiry instead of the enqueue path's default TTL.
   *
   * Typed structurally rather than by importing the wallet module's interface:
   * `types.ts` is the tool vocabulary and must not depend on one tool family's
   * implementation. The producing module's `PreparedApprovalBinding` is
   * assignable to it, and the compiler checks that at the assignment.
   */
  preparedApprovalBinding?: {
    readonly preview: {
      readonly label: string;
      /** The approval card's scalar vocabulary, identical to `WalletIntentPreview`'s. */
      readonly criticalArgs: Record<string, string | number | boolean | null>;
    };
    readonly intentExpiresAt: string;
    readonly proposalDigest: string;
    readonly proposalDigestVersion: string;
    readonly resource: { readonly table: string; readonly intentId: string };
  };
  /**
   * PRIVATE handoff from a swap QUOTE handler to the prequote recorder: the
   * execution snapshot the recorder persists and the eligibility that decides
   * whether the resulting prequote may authorize an execute at all.
   *
   * Deliberately NOT `data`: `ok()` serializes `data` into `output`, so a
   * snapshot placed there would enter model context, where it is both useless
   * to the model and forgeable back into a later call. This channel is written
   * by the handler, read by `recordPrequoteFromQuote`, and read by nothing
   * else.
   *
   * Set on FAILURE results too. A quote that refuses on provider shape must
   * still write a superseding ineligible row, or an older priced quote for the
   * same identity stays claimable - which is the exact hole a success-only
   * recorder leaves. `ineligibleIdentity` carries what the recorder needs when
   * there is no successful quote payload to extract from.
   *
   * Typed structurally rather than by importing the protocol module:
   * `types.ts` is the tool vocabulary and must not depend on one protocol
   * family's implementation. The producing module's typed value is assignable,
   * and the compiler checks that at the assignment.
   */
  quoteAuthority?: {
    readonly eligibilityKind: string;
    /** The stored route snapshot, or `null` when this quote authorizes nothing. */
    readonly routeSnapshot: Record<string, unknown> | null;
    readonly ineligibleIdentity?: {
      readonly chainId: number;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly amount: string;
      readonly slippageBps: number | null;
      readonly safetyVerdict: "pass" | "fail" | "unknown";
      readonly safetyDetail: Record<string, unknown>;
    };
    /**
     * The quote-time spendability facts, when the venue measured them: what the
     * swap debits from the source asset and from native, against what the
     * wallet actually held. The recorder validates this and persists it in the
     * row's bounded `safety_detail`, from which the execute-time gate restores
     * it for the approval card.
     *
     * Present only on an `executable` quote: an ineligible one carries its
     * facts inside its own eligibility member and has no card to render.
     */
    readonly spendability?: ToolSpendabilityPreview;
  };
  /** Engine signal — structured command from tool to engine (e.g. stop_mission) */
  engineSignal?: EngineSignal;
  /**
   * Wall-clock milliseconds the dispatch took, stamped by `dispatchTool` on
   * both the success and the handler-thrown return path. Covers routing plus
   * handler execution INCLUDING any retries the handler performs internally.
   *
   * ABSENT (never `0`) whenever nothing executed: the pressure-band and
   * plan-acceptance early denies, and every synthetic result the engine
   * fabricates itself (compact-drained batch entries, auto-rejected
   * approvals, calls that were never dispatched). A `0` would be rendered by
   * the app as "took 0 ms", which would be a lie.
   *
   * An approval-resumed dispatch measures the POST-approval run only — the
   * clock lives inside `dispatchTool`, so the time an intent spent waiting on
   * the user is deliberately not counted.
   */
  durationMs?: number;
  /**
   * Action taxonomy stamp — what kind of action this dispatch actually performed
   * (see `./taxonomy.ts`). Stamped by:
   *  - `dispatchTool` as a fallback from `getActionKind(toolName)` for internal
   *    tools when the handler did not set it,
   *  - `executeProtocolTool` from the TARGET protocol manifest (NOT from the
   *    `execute_tool` envelope's own classification), on every known-manifest
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
     * The APPROVED QUOTE this proposal is bound to, for the approval card: the
     * quoted output and the floor the fill may not go below (both in the output
     * token's human units), the tolerance, the snapshot digest and the row's
     * expiry. Read from the matched prequote's stored snapshot, never from raw
     * args, so a card cannot state a floor the store does not hold.
     *
     * Typed structurally: `types.ts` is the tool vocabulary and must not depend
     * on one protocol family's implementation. The producing module's
     * `QuoteBindingPreview` is assignable, and the compiler checks that at the
     * assignment.
     */
    readonly quoteBinding?: {
      /** The venue's own card-line version tag, rendered first on the line. */
      readonly cardVersion: string;
      readonly snapshotId: string;
      readonly digest: string;
      readonly approvedAmountOutHuman: string;
      readonly approvedMinOutHuman: string;
      readonly approvedMinOutRaw: string;
      readonly tokenOutSymbol: string;
      readonly effectiveSlippageBps: number;
      readonly expiresAt: string;
    };
    /**
     * Jupiter fee-bearing swap disclosure (W5 design §6 R4) — the 25bps fee,
     * fee mint + treasury ATA, ATA rent (if the account does not yet exist),
     * tip, and priority-fee strategy for a `solana.swap.execute`. Sourced from
     * the matched prequote's persisted `safetyDetail` (NOT raw args), it rides
     * this typed channel into `buildIntentPreview` so a restricted human sees
     * the full economic disclosure before approving.
     */
    readonly feePreview?: JupiterFeePreview;
    /**
     * Bridge asset facts read at the pre-approval gate. EVM ERC-20 symbol and
     * decimals come from the contract; native identity comes from the chain
     * registry. Solana is explicitly marked as outside the EVM contract-read
     * lane rather than guessed.
     */
    readonly bridgeTokenPreview?: {
      readonly source: {
        readonly family: "eip155" | "solana";
        readonly kind: "erc20" | "native" | "solana" | "metadata_unavailable";
        readonly chainId: number;
        readonly tokenAddress: string;
        readonly symbol: string | null;
        readonly decimals: number | null;
        readonly metadataSource: string;
        readonly symbolSanitized: boolean;
        readonly metadataErrorCode?: "contract_metadata_unavailable" | "native_registry_metadata_unavailable";
        readonly metadataErrorMessage?: string;
      };
      readonly destination: {
        readonly family: "eip155" | "solana";
        readonly kind: "erc20" | "native" | "solana" | "metadata_unavailable";
        readonly chainId: number;
        readonly tokenAddress: string;
        readonly symbol: string | null;
        readonly decimals: number | null;
        readonly metadataSource: string;
        readonly symbolSanitized: boolean;
        readonly metadataErrorCode?: "contract_metadata_unavailable" | "native_registry_metadata_unavailable";
        readonly metadataErrorMessage?: string;
      };
      readonly amountRaw: string;
      readonly amountHuman: string | null;
    };
    /**
     * What the wallet could pay when the matched quote was taken: the source
     * principal and the total native debit against the balances read at that
     * moment. Restored from the matched prequote's persisted `safetyDetail`
     * (NEVER from raw args), so the Required / Current figures on the card are
     * the store's figures and the model cannot state different ones.
     *
     * The rendered line labels itself as a quote-time observation. Sign-time
     * code must never treat it as authority - the authoritative read lives in
     * the pre-sign window.
     */
    readonly spendability?: ToolSpendabilityPreview;
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
 * - defer_until: the agent wants to sleep until a wake time (LoopDefer)
 * - compact_committed: a compaction archived the conversation prefix, updated
 *   the rolling summary, and enqueued a Track 2 chunking job (PR2). Turn-loop
 *   drains remaining tool calls in the batch with `batch_aborted_by_compact`,
 *   reloads live messages, merges operator interrupts, updates
 *   `mission_runs.last_checkpoint_at`, and injects a deterministic resume
 *   packet for `POST_COMPACT_BRIDGE_CYCLES` subsequent turns.
 * - plan_pause: a `PlanWrite` in an ACTIVE mission run created/changed a plan
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
