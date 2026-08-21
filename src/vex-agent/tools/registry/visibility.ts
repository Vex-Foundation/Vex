/**
 * Tool registry visibility — session-aware projection of the master TOOLS
 * array down to the surface a given session/pressure context may see.
 *
 * Owns the visibility context types, the per-context filter chain
 * (`getVisibleToolDefs`), and the private gate helpers
 * (`passesVisibility` / `passesPressureSafety`).
 *
 * Consumes the master array + by-name lookup from `./lookup.js` — it must
 * never import the `registry.js` façade (cycle).
 */

import type { ToolDef, ToolVisibility } from "../types.js";
import type { Permission, SessionKind } from "@vex-agent/engine/types.js";
import type { ContextUsageBand } from "@vex-agent/engine/core/context-band.js";

import { TOOLS } from "./lookup.js";

/**
 * Session-aware context for tool surface projection. Built by engine runners
 * before every provider call so `getOpenAITools` can gate session-scoped
 * tools (LoopDefer, CompactApply).
 *
 * `permission` and `sessionKind` are immutable per session; the former
 * controls approval bypass on mutating tools, the latter controls
 * mode-only visibility (e.g. `LoopDefer` is mission-only).
 *
 * `contextUsageBand` is derived from `sessions.token_count` via
 * `computeBand()` — it lags by one turn (previous prompt size) and callers
 * are expected to recompute per turn rather than cache.
 */
export interface ToolVisibilityContext {
  /**
   * Active session identity for session-scoped gates. NO GATE READS IT TODAY:
   * owner decision D4 retired the Uniswap and Relay reveals, and D2 retired the
   * describe-tools reveal along with the tool it hid. It stays on the context
   * because the injected-protocol projection keys the session working set on it
   * (`buildInjectedProtocolTools`), and because a future session-scoped gate
   * would otherwise have to re-thread it through every caller.
   */
  sessionId?: string;
  permission: Permission;
  sessionKind: SessionKind;
  /** True iff `missionRunId !== null`. Mission setup is `false` even when sessionKind="mission". */
  missionRunActive: boolean;
  /**
   * True iff session-scoped plan-mode is enabled (turn-start snapshot from
   * `EngineContext.planMode`). A STATIC axis (part of `ToolVisibilityBase`) —
   * gates `PlanWrite` via `ToolVisibility.requiresPlanMode`. The dispatcher's
   * hard execution gate uses a live DB read instead (acceptance can change
   * mid-batch); this flag only controls what the LLM sees.
   */
  planMode: boolean;
  contextUsageBand: ContextUsageBand;
  /**
   * True iff the session has at least one active narrative memory chunk
   * (Track-2 compaction output). Gates `SessionMemorySearch` /
   * `SessionMemoryResolve` via `ToolVisibility.requiresSessionMemory` so a
   * fresh session is never shown no-op memory tools. Recomputed per turn —
   * chunks first appear after a compact, possibly mid-session.
   */
  hasSessionMemory: boolean;
  /**
   * True iff a compaction preparation is live enough to relieve the pressure
   * on its own (contract C8) — a validated summary is ready, or branch A still
   * holds its lease with attempts remaining. While true, the `barrier` band
   * stops stripping `mutating` tools, because the thing the barrier exists to
   * force is already under way.
   *
   * SECURITY-RELEVANT. This lets fund-moving tools run at ≥88% context, so it
   * must be a POSITIVE observation, never a default. It is derived by
   * `barrierBypassAllowed` from the per-turn preparation read, which fails
   * closed on an unreadable state; absent here ⇒ false ⇒ today's barrier.
   *
   * Scope is `barrier` only. `critical` keeps stripping — forced apply owns
   * that band, and a session that deep needs the runtime to act, not the agent.
   */
  preparationBypassesBarrier: boolean;
  /**
   * True iff a VALIDATED prepared summary exists for this session. Gates
   * `CompactApply` via `ToolVisibility.requiresSummaryReady`.
   *
   * Comes from the SAME per-turn preparation read as
   * `preparationBypassesBarrier` (`hasCompactionSummaryReady` on the resolved
   * state), so the tool cannot be offered on one axis while the other believes
   * nothing is prepared.
   */
  hasCompactionSummaryReady: boolean;
}

/**
 * The static visibility axes a runner knows up-front. The per-turn layer
 * (`buildTurnPromptStack`) augments this with `contextUsageBand`,
 * `hasSessionMemory` and the two compaction-preparation axes to form the single
 * `ToolVisibilityContext` used for BOTH the OpenAI tools array AND the
 * system-prompt Tool Map — so the two can never drift.
 */
export type ToolVisibilityBase = Omit<
  ToolVisibilityContext,
  | "contextUsageBand"
  | "hasSessionMemory"
  | "preparationBypassesBarrier"
  | "hasCompactionSummaryReady"
>;

/**
 * Convenience constructor for `ToolVisibilityContext` — agent-session
 * defaults with optional overrides. Primarily used by tests to avoid
 * inlining a 5-field object at every call site.
 */
export function defaultVisibilityContext(
  overrides: Partial<ToolVisibilityContext> = {},
): ToolVisibilityContext {
  return {
    permission: "restricted",
    sessionKind: "agent",
    missionRunActive: false,
    planMode: false,
    contextUsageBand: "normal",
    hasSessionMemory: false,
    // Both compaction axes default to the SAFE answer: no bypass, nothing
    // ready. A caller that forgets them gets today's barrier, not a hole in it.
    preparationBypassesBarrier: false,
    hasCompactionSummaryReady: false,
    ...overrides,
  };
}

/**
 * Filter the master TOOLS array for a given session context, returning
 * `ToolDef` rows (not the OpenAI projection). Shared upstream of
 * `getOpenAITools` AND of `buildToolCatalogPrompt` so the LLM-visible
 * catalog and the system-prompt Tool Map never drift — both layers
 * consume the same filter output for the same `ToolVisibilityContext`.
 *
 * Filter chain (order matters):
 *   1. `requiresEnv` / `showOnlyWhenEnvMissing` — env-var gates.
 *   2. `proactive` — hidden when `sessionKind === "agent"`.
 *   3. `passesVisibility` — band gate + mission-setup/run / agent-hidden /
 *      mission-setup-hidden / requiresMissionActiveRun gates.
 *   4. `passesPressureSafety` — PR2 cutover catalog-level filter
 *      (drops `mutating` at barrier+, unless a live preparation bypasses it).
 */
/**
 * NO WITHHELD-NAME FILTER. `execute_tool` used to be filtered out here while its
 * `ToolDef` still existed; the ToolDef is now DELETED
 * (`./protocol.ts`), so there is nothing to withhold and a filter over an empty
 * set would be a gate with no subject. The envelope's dispatch route survives
 * for approval resume, and `dispatchTool` refuses the name outright when the
 * call is `modelOriginated` — that refusal, not a catalog filter, is what keeps
 * it closed to the model.
 */
export function getVisibleToolDefs(ctx: ToolVisibilityContext): readonly ToolDef[] {
  return TOOLS
    .filter(t => !t.requiresEnv || Boolean(process.env[t.requiresEnv]?.trim()))
    .filter(t => !t.showOnlyWhenEnvMissing || !process.env[t.showOnlyWhenEnvMissing]?.trim())
    .filter(t => ctx.sessionKind === "agent" ? !t.proactive : true)
    .filter(t => passesVisibility(t.visibility, ctx))
    .filter(t => passesPressureSafety(t, ctx.contextUsageBand, ctx.preparationBypassesBarrier));
}

/**
 * Catalog-level pressure-safety filter — the soft layer that keeps the
 * LLM-visible tool catalog consistent with the dispatcher's hard-deny.
 *
 * At pressure barrier+ (`barrier` or `critical`), the agent's full mutating
 * surface is restricted — only `read_only` and `safe_at_barrier` tools are
 * usable. Showing `mutating` tools in the catalog at those bands would invite
 * the model to emit calls the dispatcher then rejects with the deny error,
 * wasting a turn and confusing the model.
 *
 * THE BYPASS (contract C8). The barrier exists to force compaction. When a
 * compaction is already being prepared in the background, forcing it a second
 * time by amputating the agent's tools buys nothing and costs the session its
 * ability to finish what it started. So while `bypass` is true the `mutating`
 * drop is suppressed — but ONLY at `barrier`, and ONLY for that drop:
 *
 *   - `critical` still strips. That band belongs to the runtime's forced apply,
 *     and an agent at 92% should not be starting new fund-moving work.
 *
 * `bypass` mirrors `checkPressureDeny`'s parameter exactly. The two are a
 * matched pair: if the catalog offers a tool the dispatcher denies, the model
 * wastes turns; if the dispatcher allows one the catalog hid, the barrier is
 * hollow. They must change together, in one edit, forever.
 *
 * Tools without `pressureSafety` declared default to "mutating" via the
 * required-field invariant in `ToolDef`, so undefined cases cannot reach
 * here — the compiler enforced classification at registration time.
 */
function passesPressureSafety(
  tool: ToolDef,
  band: ContextUsageBand,
  bypass: boolean,
): boolean {
  const safety = tool.pressureSafety;
  const atBarrier = band === "barrier" || band === "critical";
  const mutatingDropSuppressed = bypass && band === "barrier";
  if (atBarrier && safety === "mutating" && !mutatingDropSuppressed) return false;
  return true;
}

function passesVisibility(
  v: ToolVisibility | undefined,
  ctx: ToolVisibilityContext,
): boolean {
  if (!v) return true;

  // Band gate (PR2: 4 bands).
  // `band: "warning"`  = visible at warning OR barrier OR critical.
  // `band: "barrier"`  = visible at barrier OR critical.
  // `band: "critical"` = visible only at critical.
  if (v.band === "warning" && ctx.contextUsageBand === "normal") return false;
  if (v.band === "barrier"
      && (ctx.contextUsageBand === "normal" || ctx.contextUsageBand === "warning")) {
    return false;
  }
  if (v.band === "critical" && ctx.contextUsageBand !== "critical") return false;

  // Mission active run gate — only mission sessions with an active run
  // see autonomy primitives like `LoopDefer`. Agent mode never loops.
  if (v.requiresMissionActiveRun && !ctx.missionRunActive) {
    return false;
  }

  // Autonomous-loop gate — a session that can act between user messages. See
  // `ToolVisibility.requiresAutonomousLoop` for the owner decree behind it.
  if (v.requiresAutonomousLoop
      && !ctx.missionRunActive
      && !(ctx.sessionKind === "agent" && ctx.permission === "full")) {
    return false;
  }

  if (v.requiresMissionRun
      && (ctx.sessionKind !== "mission" || !ctx.missionRunActive)) {
    return false;
  }

  if (v.requiresMissionSetup
      && (ctx.sessionKind !== "mission" || ctx.missionRunActive)) {
    return false;
  }

  if (v.hiddenInAgent && ctx.sessionKind === "agent") return false;
  if (v.hiddenInMissionSetup
      && ctx.sessionKind === "mission"
      && !ctx.missionRunActive) {
    return false;
  }

  // Session-memory gate — hide memory tools until Track-2 chunks exist for the
  // session (a fresh session has nothing to recall). Recomputed per turn.
  if (v.requiresSessionMemory && !ctx.hasSessionMemory) return false;

  // Plan-mode gate — hide `PlanWrite` unless the user enabled plan-mode for
  // this session. Combined with `hiddenInMissionSetup` on the tool def this
  // yields: visible in agent + active mission runs (plan-mode on), hidden in
  // mission setup and whenever plan-mode is off.
  if (v.requiresPlanMode && !ctx.planMode) return false;

  // Prepared-compaction readiness gate — `CompactApply` exists only while
  // there is something prepared to apply. Fails closed: an unreadable
  // preparation state resolves to "not ready" upstream, so the tool simply is
  // not offered rather than being offered and then refusing.
  if (v.requiresSummaryReady && !ctx.hasCompactionSummaryReady) return false;

  return true;
}
