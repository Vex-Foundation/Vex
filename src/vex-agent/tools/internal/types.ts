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
import type { ApprovedQuoteAuthority } from "../protocols/quote-authority/approved-authority.js";

/** Result from an internal tool handler */
export type InternalToolResult = ToolResult;

/** Context passed to internal tools that need session awareness */
export interface InternalToolContext {
  /** Session ID — for DB operations */
  sessionId: string;
  /** Loaded content injected into the system prompt (e.g. MemoryGet → key `long_memory:{id}`). */
  loadedDocuments: Map<string, string>;
  /**
   * Session permission, hydrated once at engine entry from `sessions.permission`.
   * Immutable for the call. Approval gates (runtime + WalletSendConfirm)
   * branch on this single value.
   */
  sessionPermission: Permission;
  /** Whether this call was pre-approved */
  approved: boolean;
  /** Active mission run ID — for MissionStop guard */
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
   * Approval id when this dispatch is the COLD RESUME of an approval the user
   * resolved, and `undefined`/`null` on every live turn (there is no approval
   * to name). Host-side evidence only — it is never derived from model input.
   *
   * Threaded to `ProtocolExecutionContext.approvalId` so an authorization
   * record can bind WHICH approval authorized an irreversible spend (C0's
   * `approval_card` variant). Optional because every non-resume context
   * builder legitimately has none.
   */
  approvalId?: string | null;
  /**
   * WHICH QUOTE the approval being resumed authorized, when the stored envelope
   * recorded one. Host-side evidence exactly like `approvalId`: it is read from
   * `approval_queue.tool_call`, which the request digest covers, and never from
   * tool arguments or model output.
   *
   * ABSENT on every live turn and on every historical approval, which is why the
   * claim treats it as "bind to this row when present" rather than as a required
   * field - see `protocols/prequote/claim.ts`.
   */
  approvedQuoteAuthority?: ApprovedQuoteAuthority | null;
  /**
   * True ONLY for a call the model emitted in a live turn. Set in exactly one
   * place — `engine/core/turn-loop-tool-batch/execute.ts`'s `buildToolContext`
   * — and never derived from tool arguments, so the model cannot set, clear or
   * forge it.
   *
   * It exists to keep `execute_tool` closed to the model (discovered tools are
   * injected as real functions and called by name) while leaving its dispatch
   * route open to the ONE non-model caller that needs it: the cold approval
   * resume, whose stored envelope is canonicalized to `execute_tool` precisely
   * so it survives a process restart (`approval-runtime/tool-call-envelope.ts`).
   * ABSENT ⇒ NOT model-originated, which is correct for every host-built
   * context (resume, run-tool, sync jobs) and is the conservative default for
   * a gate that only ever REFUSES.
   */
  modelOriginated?: true;
  /**
   * Session kind — propagated from EngineContext. Lets handlers defense-in-depth
   * their own preconditions without relying solely on the registry visibility
   * filter (e.g. `LoopDefer` handler rejects non-mission calls even if the
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
  /**
   * Operator Stop for the turn that owns this dispatch.
   *
   * PUSH cancellation for everything a handler does that is a READ, a POLL, a
   * SLEEP, or a QUOTA WAIT. Handlers pass it to `delay`, `pollUntil`,
   * `composeDeadline` (`@utils/cancellation.js`) and `fetchWithTimeout`, and
   * MUST NOT construct their own.
   *
   * MUST NOT be observed inside a sign→broadcast→persist window. See
   * `@tools/evm-chains/staged-broadcast.ts` and
   * `turn-loop-tool-batch.ts:165-170`: a leg that may already have moved funds
   * runs to completion, always. That exemption is enforced structurally — the
   * never-interrupt modules take no signal parameter at all, and
   * `src/__tests__/vex-agent/tools/never-interrupt-no-abort-signal.test.ts`
   * fails the build if the identifier appears in any of them.
   *
   * OPTIONAL because non-turn producers have no turn signal to hand over.
   * ABSENT means "no cancellation", never "cancelled". The producers that
   * deliberately leave it unset, so a future reader knows each omission is a
   * decision and not an oversight:
   *  - `engine/core/run-tool.ts` — operator direct invoke; there is no turn.
   *  - `approval-runtime/post-tx/dispatch-approved` — cold approval resume;
   *    the turn that requested the approval is long gone.
   */
  abortSignal?: AbortSignal;
}

// ── Param accessors ─────────────────────────────────────────────

/**
 * Safe string accessor for tool params.
 *
 * A wrong TYPE collapses to `""`, the same value an ABSENT key gives — so a
 * caller that reports `!value` as "Missing required: x" tells the model a
 * supplied field was never sent, and the model resends it identically. Use
 * {@link missingOrWrongTypeMessage} to phrase the rejection.
 */
export function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v : "";
}

/** Safe number accessor for tool params. Same false-missing caveat as {@link str}. */
export function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * Why a `str()`/`num()` read came back empty — absent, or present with the
 * wrong type — phrased for the model.
 *
 * The distinction is the whole point. `ChainRead {chain: 8453}` is a NUMBER
 * where the tool wants the string spelling; answering "Missing required:
 * chain" is factually false (`TokenFind` returns the chain id as a number, so
 * this is the form the agent normally holds) and the only repair it suggests is
 * the one that cannot work. Values are never echoed — only the shape.
 */
export function missingOrWrongTypeMessage(
  params: Record<string, unknown>,
  key: string,
  expected: string,
): string {
  const value = params[key];
  if (value === undefined || value === null) return `Missing required: ${key} (${expected})`;
  if (typeof value === "string" && value.trim() === "") {
    return `${key} arrived empty — supply ${expected}, or omit the field entirely`;
  }
  const received = Array.isArray(value) ? "array" : typeof value;
  return `${key} must be ${expected} — it arrived as a ${received}. Resend it with that type.`;
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
