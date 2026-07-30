/**
 * OpenRouter message mapping, response parsing, and streaming accumulation.
 */

import type { ChatResult } from "@openrouter/sdk/models/chatresult.js";
import type { ChatRequest } from "@openrouter/sdk/models/chatrequest.js";
import type { ChatToolCall } from "@openrouter/sdk/models/chattoolcall.js";
import type { ChatStreamToolCall } from "@openrouter/sdk/models/chatstreamtoolcall.js";
import type { ChatContentText } from "@openrouter/sdk/models/chatcontenttext.js";
import type { ChatContentItems } from "@openrouter/sdk/models/chatcontentitems.js";

import type {
  InferenceResponse,
  InferenceUsage,
  ParsedToolCall,
  StreamChunk,
  ProviderMessage,
} from "../types.js";

import logger from "@utils/logger.js";

import { boundedFinishReason, boundedGenerationId } from "./provider-signals.js";

// ── Message mapping ──────────────────────────────────────────────

const TOOL_RESULT_PLACEHOLDER_CONTENT =
  "[Engine: tool execution did not complete — placeholder]";

/**
 * Cache-breakpoint application options. Purely mechanical — the mapper
 * places `cacheControl` ONLY on messages the engine hinted (`static_prefix`
 * → breakpoint A, `history_tail` → breakpoint B). `summary` / `turn_state`
 * hints NEVER receive a breakpoint. With `applyBreakpoints: false` (the
 * default / auto-prefix-cache providers / models without cache pricing) the
 * request shape is byte-identical to the pre-cache wiring: plain string
 * contents, zero markup.
 */
export interface CacheBreakpointOptions {
  /** Place breakpoints A/B per engine cacheHints. */
  readonly applyBreakpoints: boolean;
  /**
   * Fallback shape (D-LIVETEST F3 fallback — currently UNUSED, activated by
   * `MERGE_TURN_STATE_FALLBACK_ENABLED` in params.ts): merge the trailing
   * turn-state system message INTO the static system message as a second
   * text part `[static(+cacheControl), turn-state]`, so history ends the
   * messages array. Breakpoint B on `history_tail` is RETAINED.
   */
  readonly mergeTurnStateIntoStaticPrefix: boolean;
}

const EPHEMERAL = { type: "ephemeral" as const };

/** Text part with a cache breakpoint, shaped for system-message content. */
function textPartWithCache(text: string): ChatContentText {
  return { type: "text", text, cacheControl: EPHEMERAL };
}

/**
 * Content parts for user/tool/assistant carriers: cacheControl goes on the
 * LAST text part (single-part for our string contents).
 */
function itemPartsWithCache(text: string): Array<ChatContentItems> {
  return [{ type: "text", text, cacheControl: EPHEMERAL }];
}

export function mapMessages(
  messages: ProviderMessage[],
  cache?: CacheBreakpointOptions,
): ChatRequest["messages"] {
  const applyBreakpoints = cache?.applyBreakpoints === true;

  const mapped: ChatRequest["messages"] = messages.map(m => {
    // Breakpoint B carrier — role-agnostic. The engine marks the LAST
    // non-empty history message; mid-tape system rows (continue-cue,
    // operator-cue) are legitimate carriers.
    const isHistoryTail = applyBreakpoints && m.cacheHint === "history_tail";

    if (m.role === "tool" && m.toolCallId) {
      return {
        role: "tool" as const,
        content: isHistoryTail ? itemPartsWithCache(m.content) : m.content,
        toolCallId: m.toolCallId,
      };
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      // Keep toolCalls intact; convert content to parts only when non-empty.
      return {
        role: "assistant" as const,
        content:
          isHistoryTail && m.content
            ? itemPartsWithCache(m.content)
            : m.content || undefined,
        toolCalls: m.toolCalls.map(tc => ({
          id: tc.id ?? "",
          type: "function" as const,
          function: { name: tc.command, arguments: JSON.stringify(tc.args) },
        })),
      };
    }

    if (m.role === "system") {
      // Breakpoint A: the static prefix system message. `summary` and
      // `turn_state` hints stay plain strings — never a breakpoint.
      if (applyBreakpoints && m.cacheHint === "static_prefix") {
        return { role: "system" as const, content: [textPartWithCache(m.content)] };
      }
      if (isHistoryTail) {
        return { role: "system" as const, content: [textPartWithCache(m.content)] };
      }
      return { role: "system" as const, content: m.content };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant" as const,
        content:
          isHistoryTail && m.content
            ? itemPartsWithCache(m.content)
            : m.content || undefined,
      };
    }
    return {
      role: "user" as const,
      content: isHistoryTail ? itemPartsWithCache(m.content) : m.content,
    };
  });

  if (applyBreakpoints && cache?.mergeTurnStateIntoStaticPrefix === true) {
    mergeTurnStateIntoStatic(messages, mapped);
  }

  return synthesizeMissingToolResults(mapped);
}

/**
 * Fallback-merge (see {@link CacheBreakpointOptions.mergeTurnStateIntoStaticPrefix}):
 * rebuild the static system message as `[static(+cacheControl), turn-state]`
 * and drop the trailing turn-state message, so history ends the array
 * (textbook incremental pattern). Breakpoint B placed during mapping is NOT
 * touched. No-op when either hinted message is missing or not a system row.
 */
function mergeTurnStateIntoStatic(
  source: ProviderMessage[],
  mapped: ChatRequest["messages"],
): void {
  const staticIdx = source.findIndex(m => m.cacheHint === "static_prefix" && m.role === "system");
  const turnIdx = source.findIndex(m => m.cacheHint === "turn_state" && m.role === "system");
  if (staticIdx === -1 || turnIdx === -1) return;

  mapped[staticIdx] = {
    role: "system" as const,
    content: [
      textPartWithCache(source[staticIdx].content),
      // Turn-state part sits AFTER the breakpoint — never cached.
      { type: "text" as const, text: source[turnIdx].content },
    ],
  };
  mapped.splice(turnIdx, 1);
}

type MappedMessage = ChatRequest["messages"][number];

/**
 * Defence-in-depth safety belt that mirrors `repairOrphanedToolCalls` at the
 * SDK boundary. The engine layer already runs the chronological repair on
 * `ProviderMessage`, but any caller that bypasses `executeTurn` (direct SDK
 * use, future tool surfaces, simple completion paths) must not be allowed
 * to send a request that ends with `assistant{tool_calls}` whose ids are not
 * paired with adjacent `tool` rows. Every chat-completions provider rejects
 * that shape; DeepSeek's adapter surfaces it as the
 * "Function call should not be used with prefix" error.
 *
 * Idempotent: if matched tool messages already follow each assistant's
 * tool_calls, the input passes through unchanged. Skips orphans whose id is
 * blank — the request would still fail at validation, but with a clearer
 * upstream error than a server 400.
 */
export function synthesizeMissingToolResults(
  mapped: ChatRequest["messages"],
): ChatRequest["messages"] {
  const result: ChatRequest["messages"] = [];
  let inserted = 0;

  for (let i = 0; i < mapped.length; i++) {
    const msg = mapped[i];
    result.push(msg);

    if (msg.role !== "assistant") continue;
    const calls = msg.toolCalls;
    if (!calls || calls.length === 0) continue;

    const wantedIds: string[] = [];
    for (const c of calls) {
      if (typeof c.id === "string" && c.id.length > 0) wantedIds.push(c.id);
    }
    if (wantedIds.length === 0) continue;

    const matched = new Set<string>();
    let j = i + 1;
    while (j < mapped.length && mapped[j].role === "tool") {
      const next = mapped[j];
      const id = "toolCallId" in next ? next.toolCallId : undefined;
      if (typeof id === "string" && wantedIds.includes(id)) matched.add(id);
      result.push(next);
      j += 1;
    }
    i = j - 1;

    for (const id of wantedIds) {
      if (matched.has(id)) continue;
      const placeholder: MappedMessage = {
        role: "tool" as const,
        content: TOOL_RESULT_PLACEHOLDER_CONTENT,
        toolCallId: id,
      };
      result.push(placeholder);
      inserted += 1;
    }
  }

  if (inserted > 0) {
    logger.warn("inference.openrouter.mapper_repair", { inserted });
  }
  return result;
}

// ── Response parsing ─────────────────────────────────────────────

export function extractUsage(raw: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number | null; completionTokensDetails?: { reasoningTokens?: number | null } | null; promptTokensDetails?: { cachedTokens?: number; cacheWriteTokens?: number } | null } | undefined): InferenceUsage {
  return {
    promptTokens: raw?.promptTokens ?? 0,
    completionTokens: raw?.completionTokens ?? 0,
    totalTokens: raw?.totalTokens ?? 0,
    cachedTokens: raw?.promptTokensDetails?.cachedTokens ?? undefined,
    // Returned ONLY for explicit-cache models with cache-write pricing;
    // absent ⇒ undefined ⇒ 0 downstream (logUsage / cost surcharge).
    cacheWriteTokens: raw?.promptTokensDetails?.cacheWriteTokens ?? undefined,
    reasoningTokens: raw?.completionTokensDetails?.reasoningTokens ?? undefined,
    // OpenRouter returns `usage.cost` (USD) automatically on every response;
    // the engine prefers it over the local price-table estimate. `null` when
    // unreported. (The renderer stream preview never receives this — it is
    // stripped at the stream bridge boundary.)
    cost: raw?.cost ?? undefined,
  };
}

export function parseNonStreamingResponse(response: ChatResult): InferenceResponse {
  const choice = response.choices?.[0];
  const msg = choice?.message;
  const usage = extractUsage(response.usage);
  // Carried on BOTH response paths — the streaming and buffered results are
  // contractually behaviour-equivalent, so a fallback must not silently drop
  // provenance the streamed path would have had. Open enum ⇒ verbatim.
  const finishReason = boundedFinishReason(choice?.finishReason);
  const generationId = boundedGenerationId(response.id);

  // Tool calls
  const sdkToolCalls: ChatToolCall[] | undefined = msg?.toolCalls;
  if (sdkToolCalls?.length) {
    const parsed: ParsedToolCall[] = [];
    for (const tc of sdkToolCalls) {
      try {
        parsed.push({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        });
      } catch {
        // Never log the raw argument JSON — it can carry addresses, amounts,
        // or other user/transaction content. `JSON.parse`'s own error message
        // also echoes a fragment of the offending input, so we log a fixed
        // reason + the arg length only.
        logger.warn("inference.openrouter.malformed_tool_args", {
          name: tc.function.name,
          argsLength: tc.function.arguments.length,
          reason: "invalid_json",
        });
      }
    }
    if (parsed.length > 0) {
      return {
        content: typeof msg?.content === "string" ? msg.content : null,
        toolCalls: parsed,
        usage,
        reasoning: msg?.reasoning ?? null,
        finishReason,
        generationId,
      };
    }
  }

  // Text response
  const content = typeof msg?.content === "string" ? msg.content : "";
  return {
    content,
    toolCalls: null,
    usage,
    reasoning: msg?.reasoning ?? null,
    finishReason,
    generationId,
  };
}

// ── Streaming tool call delta accumulation ────────────────────────

export function* processToolCallDelta(
  tc: ChatStreamToolCall,
  accumulator: Map<number, { id: string; name: string; argsBuffer: string }>,
): Generator<StreamChunk> {
  const idx = tc.index;

  if (!accumulator.has(idx)) {
    accumulator.set(idx, { id: tc.id ?? "", name: "", argsBuffer: "" });
  }

  const acc = accumulator.get(idx)!;

  if (tc.id) acc.id = tc.id;
  if (tc.function?.name) acc.name = tc.function.name;

  const chunk: StreamChunk = {
    type: "tool_call_delta",
    toolCallIndex: idx,
  };

  // First chunk for this tool call — emit id + name
  if (tc.id) chunk.toolCallId = tc.id;
  if (tc.function?.name) chunk.toolCallName = tc.function.name;

  // Arguments delta (incremental JSON string)
  if (tc.function?.arguments) {
    acc.argsBuffer += tc.function.arguments;
    chunk.toolCallArgsDelta = tc.function.arguments;
  }

  yield chunk;
}
