/**
 * Inference layer types — shared contract for all providers.
 *
 * Provider-agnostic: no DB, no engine, no transport details.
 * Every provider maps to these types.
 */

import type { JsonSchema } from "../tools/types.js";

// ── Provider config (loaded once at startup) ─────────────────────

/**
 * Reasoning effort exposed to operators (S6/D2). Mirrors the transport enum
 * in `vex-app/src/shared/schemas/reasoning.ts` (an independent literal
 * union — this package does not depend on vex-app). The FULL OpenRouter
 * effort range plus "max", which the installed `@openrouter/sdk` (0.12.79)
 * does not type yet — OpenRouter's live API added it ahead of the pinned
 * SDK; `buildOpenRouterParams`/`toChatRequestEffort` (openrouter/params.ts)
 * map "max" through the SDK's public `unrecognized()` OpenEnum escape hatch.
 */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface InferenceConfig {
  /** Provider identifier, e.g. "openrouter". */
  provider: string;
  /** Model ID, e.g. "anthropic/claude-sonnet-4" */
  model: string;
  /** Context window size in tokens — from AGENT_CONTEXT_LIMIT env */
  contextLimit: number;
  /**
   * Pinned OpenRouter endpoint `tag` from `OPENROUTER_ENDPOINT_TAG` (the
   * wizard's provider select). Undefined ⇒ "Auto": no `provider.order`, so
   * OpenRouter's own routing (and its sticky `session_id`) applies. Set,
   * it becomes `order: [tag] + allowFallbacks: false` — see
   * `openrouter/provider-prefs.ts` for why the trade-off is not additive.
   */
  endpointTag?: string;
  /** Sampling temperature. */
  temperature?: number;
  /** Max output tokens per response — from AGENT_MAX_OUTPUT_TOKENS env */
  maxOutputTokens: number;
  /** Price per 1M input tokens. */
  inputPricePerM: number;
  /** Price per 1M output tokens. */
  outputPricePerM: number;
  /** Pricing currency */
  priceCurrency: PriceCurrency;
  /** Price per 1M cached input tokens, when reported by the provider. */
  cachePricePerM: number | null;
  /**
   * Price per 1M cache-WRITE tokens (explicit-cache models only, e.g.
   * Anthropic 1.25×/2× input price). `null` when the provider catalog does
   * not report a write price — auto-prefix-cache providers (OpenAI,
   * DeepSeek, Gemini) charge nothing extra for writes.
   */
  cacheWritePricePerM: number | null;
  /** Price per 1M reasoning tokens, when reported by the provider. Pricing
   * only (D6) — does NOT gate whether a `reasoning` param is sent; see
   * `supportsReasoningEffort` below. */
  reasoningPricePerM: number | null;
  /**
   * Whether the configured model advertises the OpenRouter `reasoning_effort`
   * request parameter (from the `/models` catalog's `supported_parameters`,
   * derived once per `loadConfig()` fetch — see `openrouter.ts`). This is
   * the SOLE gate for whether `buildOpenRouterParams` may attach a
   * `reasoning.effort` value at all; independent of `reasoningPricePerM`.
   */
  supportsReasoningEffort: boolean;
  /**
   * Per-TURN reasoning effort requested by the operator (S6/D6). NEVER set
   * by `loadConfig()` — the engine entry point stamps it onto its
   * caller-owned config copy for that turn only. `buildOpenRouterParams`
   * sends it verbatim ONLY when BOTH an explicit value is present here AND
   * `supportsReasoningEffort` is true; no explicit effort → NO reasoning
   * param at all (the forced "medium" default is retired — the provider's
   * own model default applies). An explicit `"none"` is sent verbatim, not
   * treated as "omit".
   */
  reasoningEffort?: ReasoningEffort;
}

export type PriceCurrency = "USD";

// ── Per-request usage ────────────────────────────────────────────

export interface InferenceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cached input tokens (OpenRouter) — reduces prompt cost */
  cachedTokens?: number;
  /**
   * Tokens written to the prompt cache this request. OpenRouter returns
   * this ONLY for explicit-cache models with cache-write pricing
   * (`promptTokensDetails.cacheWriteTokens`); absent ⇒ treat as 0.
   */
  cacheWriteTokens?: number;
  /** Reasoning tokens (OpenRouter extended thinking) — separate pricing */
  reasoningTokens?: number;
  /**
   * Authoritative per-request cost reported by the provider (OpenRouter
   * `usage.cost`, USD). Present on every response now that usage accounting
   * is always-on; `null`/`undefined` when the provider did not report it, in
   * which case cost falls back to the local price-table estimate. Never
   * forwarded to the renderer stream preview (stripped at the stream bridge).
   */
  cost?: number | null;
}

// ── Tool calling ─────────────────────────────────────────────────

export interface ParsedToolCall {
  /** Tool call ID — must be preserved for round-trip with provider */
  id: string;
  /** Function name */
  name: string;
  /** Parsed arguments object */
  arguments: Record<string, unknown>;
}

// ── Inference response (non-streaming) ───────────────────────────

export interface InferenceResponse {
  /** Text content — null when tool calls returned */
  content: string | null;
  /** Tool calls — null when text returned */
  toolCalls: ParsedToolCall[] | null;
  /** Token usage from this request */
  usage: InferenceUsage;
  /** Reasoning output (OpenRouter extended thinking) */
  reasoning?: string | null;
}

// ── Streaming chunk ──────────────────────────────────────────────

export type StreamChunkType =
  | "content"
  | "tool_call_delta"
  | "reasoning"
  | "usage"
  | "error"
  | "done";

export interface StreamChunk {
  type: StreamChunkType;

  // content
  text?: string;

  // tool_call_delta — streamed incrementally by index
  toolCallIndex?: number;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArgsDelta?: string;

  // reasoning
  reasoningText?: string;

  // usage (final chunk)
  usage?: InferenceUsage;

  // error
  errorMessage?: string;
  errorCode?: number;
}

// ── Provider balance ─────────────────────────────────────────────

export interface ProviderBalance {
  /** Available balance for inference */
  available: number;
  /** Balance currency */
  currency: PriceCurrency;
  /** Whether below alert threshold */
  isLow: boolean;
  /** Human-readable display string, e.g. "$12.50 USD". */
  displayText: string;
  /** Total balance (credits purchased or ledger total) */
  total?: number;
  /** Daily usage — OpenRouter only */
  usageDaily?: number;
  /** Monthly usage — OpenRouter only */
  usageMonthly?: number;
}

// ── Request cost breakdown ───────────────────────────────────────

export interface RequestCost {
  /** Total cost for this request */
  totalCost: number;
  /** Cost currency */
  currency: PriceCurrency;
  /** Detailed breakdown */
  breakdown: {
    /** Cost for prompt tokens (standard rate) */
    promptCost: number;
    /** Cost for completion tokens (standard rate) */
    completionCost: number;
    /** Amount saved due to cached tokens (positive = savings) */
    cachedSavings: number;
    /** Additional cost for reasoning tokens above standard completion rate */
    reasoningCost: number;
  };
}

// ── Messages (provider-agnostic) ─────────────────────────────────

export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Cache-segment marker set by the ENGINE (`buildProviderMessages` knows the
 * segment boundaries — mid-tape system rows and the summary are not
 * distinguishable by role alone). The inference layer is purely mechanical:
 * it places provider cache breakpoints ONLY where a hint says so, never by
 * positional heuristics.
 *
 * - `static_prefix`: the stable system prefix (breakpoint A candidate).
 * - `summary`: post-compact rolling summary — never gets a breakpoint.
 * - `history_tail`: LAST non-empty history message (breakpoint B candidate),
 *   marked AFTER `repairOrphanedToolCalls` so it sits on the final tape.
 * - `turn_state`: trailing per-call state — never gets a breakpoint.
 */
export type ProviderMessageCacheHint =
  | "static_prefix"
  | "summary"
  | "history_tail"
  | "turn_state";

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
  /** For tool result messages: links back to the tool call */
  toolCallId?: string;
  /** For assistant messages: tool calls made in this turn */
  toolCalls?: ProviderToolCallRef[];
  /** Cache-segment marker — see {@link ProviderMessageCacheHint}. */
  cacheHint?: ProviderMessageCacheHint;
}

export interface ProviderToolCallRef {
  id: string;
  command: string;
  args: Record<string, unknown>;
}

// ── Tool definition (OpenAI-compatible) ──────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /**
     * OpenAI-compatible JSON Schema. Strictly typed via `JsonSchema` rather
     * than `Record<string, unknown>` so engine-side `toToolDefinitions`
     * doesn't need `as unknown as Record<...>` casts.
     * Providers pass this through to the upstream API unchanged.
     */
    parameters: JsonSchema;
  };
}

// ── Request context (sticky provider routing) ────────────────────

/**
 * Identity of the conversation/mission a request belongs to.
 *
 * OpenRouter groups requests that share a sticky routing key onto the SAME
 * upstream provider, which keeps the prompt cache warm across a multi-turn
 * agent loop. Left to itself it DERIVES that key by hashing the opening
 * messages — which is exactly what Vex's tape cannot guarantee, because
 * compaction inserts a summary system message and shifts the history mid-run.
 * Passing an explicit id instead makes the grouping stable across that drift.
 *
 * Threaded ONLY through the core conversational/tool turns (streaming plus its
 * buffered fallback). Background work — the memory judge, entity extraction,
 * regime worker and compaction chunker — deliberately stays ungrouped: those
 * are one-shot calls that share no prefix with the conversation, so grouping
 * them would pin an unrelated provider without any cache benefit.
 */
export interface InferenceRequestContext {
  /** Conversation this request belongs to. */
  readonly sessionId: string;
  /** Mission run this request belongs to, when the turn is part of one. */
  readonly missionRunId: string | null;
}

// ── Provider interface ───────────────────────────────────────────

export interface InferenceProvider {
  readonly id: string;
  readonly displayName: string;

  /**
   * Load inference configuration (model, pricing, context limit).
   *
   * Called per turn but expected to cache: a successful fetch is reused for a
   * provider-defined TTL, refreshed on demand after the TTL, and may be served
   * stale on a transient metadata failure. Returns null when the model is absent from
   * the provider catalog (misconfig/delisting) or when the very first fetch
   * fails (no last-good to fall back on). The returned object is owned by the
   * caller — implementations must not hand out a shared mutable reference.
   */
  loadConfig(): Promise<InferenceConfig | null>;

  /**
   * Non-streaming chat completion with tool calling.
   * Used by: inference loop (tool calling round-trip).
   *
   * `context` groups the request for sticky provider routing. It is optional so
   * existing callers and test doubles stay valid; the buffered fallback in
   * `runStreamingInference` passes the SAME context as the streaming attempt it
   * replaces, so a fallback cannot silently land on a different provider.
   */
  chatCompletion(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    config: InferenceConfig,
    context?: InferenceRequestContext,
  ): Promise<InferenceResponse>;

  /**
   * Simple non-streaming completion without tools.
   * Used by: compaction, session summary, Vex Papa.
   */
  chatCompletionSimple(
    messages: ProviderMessage[],
    config: InferenceConfig,
  ): Promise<{ content: string; usage: InferenceUsage }>;

  /**
   * Streaming chat completion with tool calling.
   * Used by: UI chat (text deltas + tool call deltas).
   *
   * `signal` (Stage 9-5a) cancels the in-flight HTTP stream for chat-turn
   * "stop generating". When omitted, the stream runs to completion as before.
   *
   * `context` groups the request for sticky provider routing (see
   * `InferenceRequestContext`).
   */
  chatCompletionStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    config: InferenceConfig,
    signal?: AbortSignal,
    context?: InferenceRequestContext,
  ): AsyncGenerator<StreamChunk>;

  /**
   * Get current provider balance/credit state.
   * Returns null if provider doesn't expose balance.
   */
  getBalance(): Promise<ProviderBalance | null>;

  /**
   * Calculate cost for a single request using provider-specific pricing.
   * Accounts for provider-specific cache and reasoning pricing.
   */
  calculateCost(usage: InferenceUsage, config: InferenceConfig): RequestCost;
}
