import type { ChatRequest, ChatRequestEffort } from "@openrouter/sdk/models/chatrequest.js";
import { unrecognized } from "@openrouter/sdk/types";
import type {
  InferenceConfig,
  InferenceRequestContext,
  ProviderMessage,
  ReasoningEffort,
  ToolDefinition,
} from "../types.js";
import { normalizeToolSchemaForProvider } from "../schema-normalizer.js";
import { mapMessages } from "./mappers.js";
import { buildProviderPreferences } from "./provider-prefs.js";

/**
 * OpenRouter's documented cap on `session_id` (`chatrequest.d.ts`: "Maximum of
 * 256 characters").
 */
const MAX_SESSION_ID_LENGTH = 256;

/**
 * Resolve the sticky routing key for a request.
 *
 * A mission run is the tighter grouping — every turn of one run shares a
 * prefix — so it wins over the session when present. Falls back to the session
 * id for ordinary chat.
 *
 * Returns `undefined` rather than truncating an over-long id: a sliced
 * identifier could COLLIDE with a different conversation and pin two unrelated
 * runs to one provider, whereas omitting it simply restores OpenRouter's own
 * message-hash derivation. Our ids are UUID-shaped (~36 chars), so the cap is
 * unreachable in practice — this is a boundary guard, not an expected path.
 */
export function resolveStickyRoutingKey(
  context: InferenceRequestContext | undefined,
): string | undefined {
  if (context === undefined) return undefined;
  const key = (context.missionRunId ?? context.sessionId).trim();
  if (key.length === 0 || key.length > MAX_SESSION_ID_LENGTH) return undefined;
  return key;
}

/**
 * Model families that require EXPLICIT `cache_control` breakpoints per the
 * OpenRouter prompt-caching docs (https://openrouter.ai/docs/features/prompt-caching):
 *
 * - Anthropic Claude: "cache_control breakpoints … Cache writes are charged
 *   at 1.25×/2× the input price; cache reads at 0.1×."
 * - Alibaba Qwen: explicit `cache_control` breakpoints, same mechanism.
 * - Google: IMPLICIT caching on Gemini 2.5 only — `google/` is deliberately
 *   NOT in this list (2.5 caches without markup; older models get nothing,
 *   which equals today's behavior).
 * - OpenAI / DeepSeek / Grok: automatic prefix caching, zero request markup.
 *
 * Closed prefix list by design: deriving the gate from
 * `cacheWritePricePerM !== null` was considered and rejected — the pricing
 * catalog can carry placeholders, while this 2-prefix list is predictable
 * and cheap to maintain. `cachePricePerM !== null` (read pricing present in
 * the `/models` catalog) remains the co-condition at the call site.
 */
const EXPLICIT_CACHE_MODEL_PREFIXES = ["anthropic/", "qwen/"] as const;

export function isExplicitCacheModel(model: string): boolean {
  return EXPLICIT_CACHE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/**
 * F3 fallback activation switch (D-LIVETEST gate): when the live test shows
 * that a TRAILING turn-state system message costs Anthropic the history
 * cache, flip this to `true` to merge turn-state into the static system
 * message (`[static(+cache_control), turn-state]`) while RETAINING
 * breakpoint B on `history_tail`. Shipped `false` — the trailing shape is
 * the primary design; the merged shape is implemented + unit-tested so the
 * flip stays a one-line change after the livetest verdict.
 */
export const MERGE_TURN_STATE_FALLBACK_ENABLED = false;

/**
 * Adapt Vex's own 7-value `ReasoningEffort` to the SDK's `ChatRequestEffort`
 * OpenEnum. The installed SDK (0.12.79) does not type a "max" member —
 * OpenRouter's live API added it ahead of the pinned SDK's types (verified
 * against the installed package) — so "max" is passed through the SDK's
 * own public `unrecognized()` escape hatch (`ChatRequestEffort` is an
 * OpenEnum: unknown values forward to the wire unchanged). Every other
 * value is already a literal member of `ChatRequestEffort` — no cast.
 */
export function toChatRequestEffort(effort: ReasoningEffort): ChatRequestEffort {
  return effort === "max" ? unrecognized<string>("max") : effort;
}

export function buildOpenRouterParams(
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  config: InferenceConfig,
  stream: boolean,
  responseFormat?: ChatRequest["responseFormat"],
  context?: InferenceRequestContext,
): ChatRequest {
  // Breakpoints ONLY for explicit-cache model families AND when the catalog
  // reports cache-read pricing ("model supports cache" detection). Everything
  // else keeps today's exact request shape — zero markup for auto-prefix
  // providers and for models without cache pricing.
  const applyBreakpoints =
    isExplicitCacheModel(config.model) && config.cachePricePerM !== null;

  // Routing preferences are owned by `buildProviderPreferences` (tools OR
  // responseFormat ⇒ requireParameters; optional W3 endpoint pin). Composed
  // here so every send path gets the same treatment from one place; omitted
  // entirely when no lever applies, keeping unaffected callers byte-identical.
  const provider = buildProviderPreferences({
    hasTools: tools.length > 0,
    hasResponseFormat: responseFormat !== undefined,
    endpointTag: config.endpointTag,
  });

  // Sticky provider routing (`session_id` on the wire). Absent for background
  // callers that pass no context — see `InferenceRequestContext`.
  const sessionId = resolveStickyRoutingKey(context);

  const params: ChatRequest = {
    model: config.model,
    messages: mapMessages(messages, {
      applyBreakpoints,
      mergeTurnStateIntoStaticPrefix:
        applyBreakpoints && MERGE_TURN_STATE_FALLBACK_ENABLED,
    }),
    maxTokens: config.maxOutputTokens,
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(stream && { stream: true }),
    // D6: send `reasoning.effort` ONLY when the operator made an EXPLICIT
    // per-turn choice AND the model advertises the `reasoning_effort`
    // parameter. No explicit choice → no reasoning param at all — the
    // provider's own model default applies (the forced "medium" fallback is
    // retired; an unconditional default risked sending an unadvertised
    // effort to models with a narrower advertised set). Explicit "none" is
    // sent verbatim, not treated as omission.
    ...(config.reasoningEffort !== undefined &&
      config.supportsReasoningEffort && {
        reasoning: { effort: toChatRequestEffort(config.reasoningEffort) },
      }),
    // API-level output-format enforcement (F31 Layer B). Omitted by default so
    // every caller that passes nothing keeps a byte-identical wire request.
    ...(responseFormat !== undefined && { responseFormat }),
    ...(provider !== undefined && { provider }),
    ...(sessionId !== undefined && { sessionId }),
  };

  if (tools.length > 0) {
    params.tools = tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: normalizeToolSchemaForProvider(tool.function.parameters),
      },
    }));
    params.toolChoice = "auto";
  }

  return params;
}
