/**
 * Internal tool handler types.
 *
 * Each internal tool handler is an async function that takes params
 * and returns an InternalToolResult. Handlers do NOT know about
 * sessions, SSE events, or the inference loop — they are pure
 * param-in → result-out functions.
 *
 * Session context (loadedDocuments, messages) is passed explicitly
 * where needed — not as a god-object dependency.
 */

import type { ToolResult } from "../types.js";
import type { Permission, SessionKind, WalletPolicy } from "@vex-agent/engine/types.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";

/** Result from an internal tool handler */
export type InternalToolResult = ToolResult;

/** Context passed to internal tools that need session awareness */
export interface InternalToolContext {
  /** Session ID — for DB operations */
  sessionId: string;
  /** Loaded content injected into the system prompt (e.g. long_memory_get → key `long_memory:{id}`). */
  loadedDocuments: Map<string, string>;
  /**
   * Session permission, hydrated once at engine entry from `sessions.permission`.
   * Immutable for the call. Approval gates (runtime + wallet_send_confirm)
   * branch on this single value.
   */
  sessionPermission: Permission;
  /** Whether this call was pre-approved */
  approved: boolean;
  /** Active mission run ID — for mission_stop guard */
  missionRunId: string | null;
  /**
   * Session-scoped plan-mode flag (turn-start snapshot from EngineContext).
   * Gates the dispatcher's plan-acceptance check: when false (the default /
   * common case) the gate skips its live `session_plans` read entirely — so a
   * non-plan-mode dispatch costs no extra DB query. Plan-mode cannot toggle
   * mid-turn (the IPC toggle is out-of-band), so the snapshot is accurate for
   * the gate-activation decision; the live read inside the gate then resolves
   * the (mid-turn-mutable) acceptance state.
   */
  planMode: boolean;
  /** Mission ID when the session is in mission setup or an active mission run. */
  missionId: string | null;
  /**
   * Session kind — propagated from EngineContext. Lets handlers defense-in-depth
   * their own preconditions without relying solely on the registry visibility
   * filter (e.g. `loop_defer` handler rejects non-mission calls even if the
   * model somehow emits the tool name).
   */
  sessionKind: SessionKind;
  /**
   * Context-usage band at dispatch time — derived from the previous prompt's
   * token count. Used by band-scoped handlers for defense-in-depth against
   * calls outside their intended band.
   */
  contextUsageBand: "normal" | "warning" | "barrier" | "critical";
  /**
   * True iff a live compaction preparation suppresses the `barrier` mutating
   * block for this turn (contract C8). ABSENT ⇒ FALSE ⇒ today's barrier — the
   * fail-closed default that every context builder except the live tool-batch
   * path deliberately relies on.
   *
   * Producers that intentionally leave it unset, so a future reader knows the
   * omission is a decision and not an oversight: `run-tool.ts`,
   * `approval-runtime/post-tx/dispatch-approved/resumed-tool-context.ts`,
   * `approval-intent-preview.ts`, `runner/setup-turn.ts`, `runner/agent.ts`,
   * `runner/mission-run.ts`. None of them is the turn's live batch, so none of
   * them has a per-turn preparation read to derive it from.
   */
  preparationBypassesBarrier?: boolean;
  /**
   * Origin of the call. Used for knowledge provenance (knowledge_entries.source_surface).
   * - undefined / "vex_agent": Vex Agent (mission loop, chat, scripts) — default
   * - "mcp_local": legacy import/export provenance value retained for backups
   *
   * Defaulting to undefined means existing call sites stay unchanged; the knowledge
   * write path interprets undefined as "vex_agent".
   */
  sourceSurface?: "vex_agent" | "mcp_local";
  /**
   * Session id of the writer surface. Vex Agent typically leaves this
   * undefined and relies on `sessionId` for its own session tracking.
   */
  sourceSession?: string;
  /**
   * Per-session wallet resolution. Engine sessions use source:"session"
   * (selected wallet, or fail-closed when unselected); trusted maintenance
   * paths without session scope use source:"default" (primary wallet).
   * Consumed by the wallet resolvers.
   */
  walletResolution: WalletResolution;
  /** Mission wallet policy — enforced alongside the resolution by the resolvers. */
  walletPolicy: WalletPolicy;
}

// ── Param accessors ─────────────────────────────────────────────

/** Safe string accessor for tool params */
export function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v : "";
}

/** Safe number accessor for tool params */
export function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" ? v : undefined;
}

/** Safe boolean accessor for tool params */
export function bool(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

/**
 * Safe enum accessor for tool params — returns the value only if it matches
 * one of the allowed literals, otherwise undefined. Handlers resolve their
 * own default (usually server-side, because LLMs frequently omit defaults
 * even when the schema declares one).
 */
export function enumField<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = params[key];
  if (typeof v !== "string") return undefined;
  return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

// ── Result helpers ──────────────────────────────────────────────

/** Success result with JSON-serialized data. */
export function ok(data: unknown): ToolResult {
  return { success: true, output: JSON.stringify(data), data: data as Record<string, unknown> };
}

/** Failure result with message. */
export function fail(msg: string): ToolResult {
  return { success: false, output: msg };
}
