/**
 * Tool registry visibility — session-aware projection of the master TOOLS
 * array down to the surface a given session/role/pressure context may see.
 *
 * Owns the visibility context types, the per-context filter chain
 * (`getVisibleToolDefs`), the role-block hard gate (`isToolBlockedForRole`),
 * and the private gate helpers (`passesVisibility` / `passesPressureSafety`).
 *
 * Consumes the master array + by-name lookup from `./lookup.js` — it must
 * never import the `registry.js` façade (cycle).
 */

import type { ToolDef, ToolVisibility } from "../types.js";
import type { Permission, SessionKind } from "@vex-agent/engine/types.js";
import type { ContextUsageBand } from "@vex-agent/engine/core/context-band.js";

import { TOOLS, getToolDef } from "./lookup.js";
import { getVisibleHypervexingAliasTools } from "../hypervexing-aliases.js";

/**
 * Session-aware context for tool surface projection. Built by engine runners
 * before every provider call so `getOpenAITools` can gate session-scoped
 * tools (loop_defer, tool_output_read, compact_now).
 *
 * `permission` and `sessionKind` are immutable per session; the former
 * controls approval bypass on mutating tools, the latter controls
 * mode-only visibility (e.g. `loop_defer` is mission-only).
 *
 * `contextUsageBand` is derived from `sessions.token_count` via
 * `computeBand()` — it lags by one turn (previous prompt size) and callers
 * are expected to recompute per turn rather than cache.
 */
export interface ToolVisibilityContext {
  /**
   * Active session identity for transient main-owned visibility such as the
   * Hypervexing hot set. Omitted contexts fail closed to the normal tool menu.
   */
  sessionId?: string;
  permission: Permission;
  role: "parent" | "subagent";
  sessionKind: SessionKind;
  /** True iff `missionRunId !== null`. Mission setup is `false` even when sessionKind="mission". */
  missionRunActive: boolean;
  /**
   * True iff session-scoped plan-mode is enabled (turn-start snapshot from
   * `EngineContext.planMode`). A STATIC axis (part of `ToolVisibilityBase`) —
   * gates `plan_write` via `ToolVisibility.requiresPlanMode`. The dispatcher's
   * hard execution gate uses a live DB read instead (acceptance can change
   * mid-batch); this flag only controls what the LLM sees.
   */
  planMode: boolean;
  contextUsageBand: ContextUsageBand;
  /**
   * True iff the session has at least one active narrative memory chunk
   * (Track-2 compaction output). Gates `session_memory_search` /
   * `session_memory_resolve_item` via `ToolVisibility.requiresSessionMemory` so a
   * fresh session is never shown no-op memory tools. Recomputed per turn —
   * chunks first appear after a compact, possibly mid-session.
   */
  hasSessionMemory: boolean;
}

/**
 * The static visibility axes a runner knows up-front. The per-turn layer
 * (`buildTurnPromptStack`) augments this with `contextUsageBand` +
 * `hasSessionMemory` to form the single `ToolVisibilityContext` used for BOTH
 * the OpenAI tools array AND the system-prompt Tool Map — so the two can never
 * drift.
 */
export type ToolVisibilityBase = Omit<
  ToolVisibilityContext,
  "contextUsageBand" | "hasSessionMemory"
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
    role: "parent",
    sessionKind: "agent",
    missionRunActive: false,
    planMode: false,
    contextUsageBand: "normal",
    hasSessionMemory: false,
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
 *   3. `excludeRoles` — hard role gate.
 *   4. `passesVisibility` — band gate + mission-setup/run / agent-hidden /
 *      mission-setup-hidden / requiresMissionActiveRun gates.
 *   5. `passesPressureSafety` — PR2 cutover catalog-level filter
 *      (drops `mutating` at barrier+, drops `compact_only` below barrier).
 */
export function getVisibleToolDefs(ctx: ToolVisibilityContext): readonly ToolDef[] {
  const staticTools = TOOLS
    .filter(t => !t.requiresEnv || Boolean(process.env[t.requiresEnv]?.trim()))
    .filter(t => !t.showOnlyWhenEnvMissing || !process.env[t.showOnlyWhenEnvMissing]?.trim())
    .filter(t => ctx.sessionKind === "agent" ? !t.proactive : true)
    .filter(t => !t.excludeRoles?.includes(ctx.role))
    .filter(t => passesVisibility(t.visibility, ctx))
    .filter(t => passesPressureSafety(t, ctx.contextUsageBand));
  // Hypervexing aliases are a session-mode projection, not permanent ToolDefs.
  // The alias projection receives this same band so it shares the catalog's
  // release, policy, and pressure visibility rather than re-implementing it.
  const hotSet = getVisibleHypervexingAliasTools(ctx.sessionId, ctx.contextUsageBand);
  return [...staticTools, ...hotSet];
}

/**
 * Catalog-level pressure-safety filter — the soft layer that keeps the
 * LLM-visible tool catalog consistent with the dispatcher's hard-deny.
 *
 * At pressure barrier+ (`barrier` or `critical`), the agent's full mutating
 * surface is restricted — only `read_only`, `safe_at_barrier`, and
 * `compact_only` tools are usable. Showing `mutating` tools in the catalog
 * at those bands would invite the model to emit calls the dispatcher then
 * rejects with the deny error, wasting a turn and confusing the model. The
 * inverse also holds: `compact_only` tools (currently only `compact_now`)
 * are NOT useful below barrier, where there is no compactable pressure.
 *
 * Tools without `pressureSafety` declared default to "mutating" via the
 * required-field invariant in `ToolDef`, so undefined cases cannot reach
 * here — the compiler enforced classification at registration time.
 */
function passesPressureSafety(tool: ToolDef, band: ContextUsageBand): boolean {
  const safety = tool.pressureSafety;
  const atBarrier = band === "barrier" || band === "critical";
  if (atBarrier && safety === "mutating") return false;
  if (!atBarrier && safety === "compact_only") return false;
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
  // see autonomy primitives like `loop_defer`. Agent mode never loops.
  if (v.requiresMissionActiveRun && !ctx.missionRunActive) {
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

  // Plan-mode gate — hide `plan_write` unless the user enabled plan-mode for
  // this session. Combined with `hiddenInMissionSetup` on the tool def this
  // yields: visible in agent + active mission runs (plan-mode on), hidden in
  // mission setup and whenever plan-mode is off.
  if (v.requiresPlanMode && !ctx.planMode) return false;

  return true;
}

/** Check if a tool is blocked for a given role. Hard enforcement at dispatch time. */
export function isToolBlockedForRole(name: string, role: "parent" | "subagent"): boolean {
  const def = getToolDef(name);
  if (!def) return false;
  return def.excludeRoles?.includes(role) ?? false;
}
