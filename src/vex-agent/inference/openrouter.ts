/**
 * OpenRouter inference provider — SDK-based with streaming + tool calling.
 *
 * Uses @openrouter/sdk for all communication. SDK handles:
 * - Retry with backoff (429, 5xx)
 * - Timeout management
 * - Auth header injection
 * - Zod-validated response parsing
 *
 * Streaming: SDK returns EventStream<ChatStreamChunk> which
 * we consume and yield as provider-agnostic StreamChunk instances.
 *
 * Tool calling: both streaming (delta accumulation) and non-streaming paths.
 *
 * Message mapping, response parsing, and streaming accumulation in openrouter-mappers.ts.
 *
 * @see https://openrouter.ai/docs/quickstart
 */

import { OpenRouter } from "@openrouter/sdk";
import { MetadataLevel } from "@openrouter/sdk/models/metadatalevel.js";
import type { ChatRequest } from "@openrouter/sdk/models/chatrequest.js";
import type { ChatResult } from "@openrouter/sdk/models/chatresult.js";
import type { ChatStreamChunk } from "@openrouter/sdk/models/chatstreamchunk.js";
import type { EventStream } from "@openrouter/sdk/lib/event-streams.js";

import type {
  InferenceProvider,
  InferenceConfig,
  InferenceRequestContext,
  InferenceResponse,
  InferenceUsage,
  StreamChunk,
  ProviderBalance,
  ProviderMessage,
  ToolDefinition,
  RequestCost,
} from "./types.js";

import { loadEnvConfig } from "./config.js";
import {
  OPENROUTER_APP_URL,
  OPENROUTER_APP_TITLE,
  OPENROUTER_SDK_TIMEOUT_MS,
  OPENROUTER_LOW_BALANCE_USD,
  MODEL_CONFIG_CACHE_TTL_MS,
  MODEL_CONFIG_STALE_RETRY_MS,
} from "./config.js";

import logger from "@utils/logger.js";
import { normalizeOpenRouterError } from "./openrouter/errors.js";
import { extractUsage, parseNonStreamingResponse } from "./openrouter/mappers.js";
import { buildOpenRouterParams } from "./openrouter/params.js";
import { computeRequestCost } from "./openrouter/cost.js";
import { consumeOpenRouterStream } from "./openrouter/stream.js";
import { asChatResult, asEventStream } from "./openrouter/chat-send.js";
import {
  fetchModelInferenceConfig,
  type ModelConfigFetchResult,
} from "./openrouter/model-catalog.js";
import { observeRoutingMetadata } from "./openrouter/routing-metadata.js";
import { composeRequestDeadline } from "./openrouter/request-deadline.js";

/**
 * Opt-in level for `openrouter_metadata` on the response. The SDK's own
 * `MetadataLevel` constant rather than a bare "enabled" string, so a rename in
 * the SDK is a compile error instead of a silently-ignored envelope field.
 */
const ROUTING_METADATA_ENABLED = MetadataLevel.Enabled;

// ── Provider ─────────────────────────────────────────────────────

export class OpenRouterProvider implements InferenceProvider {
  readonly id = "openrouter";
  readonly displayName = "OpenRouter";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly contextLimit: number;
  private readonly temperature: number | undefined;
  private readonly maxOutputTokens: number;
  /** Pinned endpoint tag from `OPENROUTER_ENDPOINT_TAG`; undefined ⇒ Auto. */
  private readonly endpointTag: string | undefined;
  private readonly client: OpenRouter;

  // ── loadConfig cache (F4) ───────────────────────────────────────
  // `loadConfig()` is called once per turn but `/models` pricing is stable.
  // We memoize the last SUCCESSFUL config and reuse it for the TTL, dedup
  // concurrent fetches, and serve the last-good config on a transient
  // metadata failure (throttled). `cachedConfig` is the single canonical
  // reference — every return path hands out a fresh shallow copy so callers
  // can never mutate the cache.
  private cachedConfig: InferenceConfig | null = null;
  private cachedAt = 0;
  private staleServeUntil = 0;
  private inFlight: Promise<InferenceConfig | null> | null = null;

  constructor() {
    const env = loadEnvConfig();

    if (!env.openrouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is required for OpenRouter provider");
    }
    if (!env.agentModel) {
      throw new Error("AGENT_MODEL is required for OpenRouter provider");
    }

    this.apiKey = env.openrouterApiKey;
    this.model = env.agentModel;
    this.contextLimit = env.contextLimit;
    this.endpointTag = env.openrouterEndpointTag ?? undefined;
    this.temperature = env.temperature ?? undefined;
    this.maxOutputTokens = env.maxOutputTokens;

    this.client = new OpenRouter({
      apiKey: this.apiKey,
      httpReferer: OPENROUTER_APP_URL,
      appTitle: OPENROUTER_APP_TITLE,
      timeoutMs: OPENROUTER_SDK_TIMEOUT_MS,
      retryConfig: {
        strategy: "backoff",
        backoff: {
          initialInterval: 2000,
          maxInterval: 15000,
          exponent: 2,
          maxElapsedTime: 60000,
        },
      },
    });
  }

  // ── send options (cancellation + deadline) ──────────────────────
  //
  // Every `chat.send` goes through here so no path can accidentally trade the
  // request ceiling for cancellation. The SDK arms its configured `timeoutMs`
  // ONLY when the send passes no signal, so handing it a raw caller signal
  // DISABLES the deadline outright — see `openrouter/request-deadline.ts` for
  // the SDK line numbers. Composing keeps both; no caller signal still means no
  // options object, leaving the SDK's own timeout in charge exactly as before.
  private sendOptions(
    signal: AbortSignal | undefined,
  ): { signal: AbortSignal } | undefined {
    const bounded = composeRequestDeadline(signal, OPENROUTER_SDK_TIMEOUT_MS);
    return bounded ? { signal: bounded } : undefined;
  }

  // ── loadConfig (cached) ─────────────────────────────────────────
  //
  // F4: the raw `/models` fetch lives in `_fetchConfig()`; this wrapper
  // memoizes the result so the per-turn call sites do not each hit the
  // network. Semantics:
  //   - fresh hit (within TTL) → cached config (copied);
  //   - concurrent calls → share one in-flight fetch, each gets its own copy;
  //   - transient metadata failure WITH a last-good → serve stale (copied),
  //     throttled so we re-attempt `/models` at most every STALE_RETRY window;
  //   - `model_not_found` (catalog responded, model absent) → null even if a
  //     last-good exists, so a delisted/misconfigured model stays loud;
  //   - first-fetch failure (no last-good) → null, re-attempted next turn.
  // The cached object is canonical and never handed out by reference — every
  // return is a fresh shallow copy.

  async loadConfig(): Promise<InferenceConfig | null> {
    const now = Date.now();

    // 1. Fresh cache hit.
    if (this.cachedConfig && now - this.cachedAt < MODEL_CONFIG_CACHE_TTL_MS) {
      return { ...this.cachedConfig };
    }
    // 2. Concurrent dedup — await the canonical fetch, copy per caller.
    if (this.inFlight) {
      const c = await this.inFlight;
      return c ? { ...c } : null;
    }
    // 3. Throttled stale-serve: a recent metadata failure left a last-good
    //    config and we're inside the retry window — serve stale without a
    //    network call.
    if (this.cachedConfig && now < this.staleServeUntil) {
      return { ...this.cachedConfig };
    }

    // 4. Fetch. The stored promise resolves to the CANONICAL reference (or
    //    null) — never a copy — so all awaiters clone independently.
    this.inFlight = this._fetchConfig()
      .then((result) => {
        if (result.kind === "success") {
          this.cachedConfig = result.config;
          this.cachedAt = Date.now();
          this.staleServeUntil = 0;
          return this.cachedConfig;
        }
        if (result.kind === "metadata_unavailable" && this.cachedConfig) {
          // Transient `/models` failure but we have a last-good — serve it and
          // throttle the next refetch attempt so we don't block every turn.
          this.staleServeUntil = Date.now() + MODEL_CONFIG_STALE_RETRY_MS;
          logger.warn("inference.openrouter.config_stale_served", {
            model: this.model,
            cachedAt: new Date(this.cachedAt).toISOString(),
          });
          return this.cachedConfig;
        }
        // `model_not_found` (surface delisting/misconfig), or metadata failure
        // with no last-good to fall back on.
        return null;
      })
      .finally(() => {
        this.inFlight = null;
      });

    // 5. Starter clones the canonical result too.
    const c = await this.inFlight;
    return c ? { ...c } : null;
  }

  // ── _fetchConfig (uncached `/models` read) ──────────────────────
  //
  // Delegates to `fetchModelInferenceConfig`, which owns the catalog read,
  // pricing parse and outcome classification. This wrapper exists only to
  // supply the provider's own identity/limits.

  private async _fetchConfig(): Promise<ModelConfigFetchResult> {
    return fetchModelInferenceConfig(this.client, {
      providerId: this.id,
      model: this.model,
      contextLimit: this.contextLimit,
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      endpointTag: this.endpointTag,
    });
  }

  // ── chatCompletion (non-streaming, with tools) ──────────────────

  async chatCompletion(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    config: InferenceConfig,
    context?: InferenceRequestContext,
    signal?: AbortSignal,
  ): Promise<InferenceResponse> {
    const params = buildOpenRouterParams(
      messages,
      tools,
      config,
      false,
      undefined,
      context,
    );

    let response: ChatResult;
    try {
      // SDK 1.1.13 no longer narrows the return type per `stream` literal —
      // `asChatResult` re-establishes it with a runtime guard (see chat-send.ts).
      response = asChatResult(
        await this.client.chat.send(
          {
            // Request-ENVELOPE field, a sibling of `chatRequest` — NOT part of
            // `ChatRequest`, so it deliberately does not live in
            // `buildOpenRouterParams` (verified against the installed SDK:
            // esm/models/operations/sendchatcompletionrequest.d.ts). One of the
            // exactly TWO conversational sends that opt in; see routing-metadata.ts.
            xOpenRouterMetadata: ROUTING_METADATA_ENABLED,
            chatRequest: { ...params, stream: false },
          },
          this.sendOptions(signal),
        ),
        "chat completion",
      );
    } catch (err) {
      throw normalizeOpenRouterError(err, "chat completion");
    }

    if (response.openrouterMetadata) {
      observeRoutingMetadata(response.openrouterMetadata, "chat completion");
    }

    return parseNonStreamingResponse(response);
  }

  // ── chatCompletionSimple (no tools) ─────────────────────────────

  async chatCompletionSimple(
    messages: ProviderMessage[],
    config: InferenceConfig,
    responseFormat?: ChatRequest["responseFormat"],
    signal?: AbortSignal,
  ): Promise<{ content: string; usage: InferenceUsage }> {
    // `provider.requireParameters` composition now lives in
    // `buildOpenRouterParams` (via `buildProviderPreferences`) so tool-bearing
    // and format-bearing requests are treated identically from one place.
    //
    // No request context: this path serves BACKGROUND work (memory judge,
    // entity extraction, regime worker, compaction chunker) which shares no
    // prefix with the conversation and stays deliberately ungrouped for sticky
    // routing — see `InferenceRequestContext`.
    //
    // No `xOpenRouterMetadata` either: routing provenance is a CONVERSATIONAL
    // concern (see routing-metadata.ts), so this envelope stays byte-identical
    // to what background callers already send. `signal` is the caller's
    // per-call deadline — every background caller now passes one, and it is
    // strictly tighter than the client ceiling `sendOptions` composes in, so
    // the caller's own timeout is what actually fires.
    const params = buildOpenRouterParams(messages, [], config, false, responseFormat);

    let response: ChatResult;
    try {
      response = asChatResult(
        await this.client.chat.send(
          { chatRequest: { ...params, stream: false } },
          this.sendOptions(signal),
        ),
        "simple chat completion",
      );
    } catch (err) {
      throw normalizeOpenRouterError(err, "simple chat completion");
    }

    const msg = response.choices?.[0]?.message;
    const content = typeof msg?.content === "string" ? msg.content : "";

    return {
      content,
      usage: extractUsage(response.usage),
    };
  }

  // ── chatCompletionStream (streaming with tools) ─────────────────

  async *chatCompletionStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    config: InferenceConfig,
    signal?: AbortSignal,
    context?: InferenceRequestContext,
  ): AsyncGenerator<StreamChunk> {
    const params = buildOpenRouterParams(
      messages,
      tools,
      config,
      true,
      undefined,
      context,
    );

    let stream: EventStream<ChatStreamChunk>;
    try {
      // `signal` is a flattened RequestInit field on the SDK's RequestOptions;
      // it cancels the fetch so a chat-turn "stop generating" tears down the
      // HTTP stream (Stage 9-5a). It does NOT merely take precedence over the
      // client timeout — supplying one suppresses that timeout entirely, which
      // is why it goes through `sendOptions` to be composed with the deadline.
      // SDK 1.1.13 no longer narrows the return type per `stream` literal —
      // `asEventStream` re-establishes it with a runtime guard.
      stream = asEventStream(
        await this.client.chat.send(
          {
            // The SECOND (and last) conversational send that opts into routing
            // provenance — envelope field, sibling of `chatRequest`. The
            // metadata rides the stream chunks; `consumeOpenRouterStream` logs
            // the first one it sees.
            xOpenRouterMetadata: ROUTING_METADATA_ENABLED,
            chatRequest: { ...params, stream: true },
          },
          this.sendOptions(signal),
        ),
        "streaming chat completion",
      );
    } catch (err) {
      throw normalizeOpenRouterError(err, "streaming chat completion");
    }

    try {
      // Post-first-chunk (mid-stream) rejections from the async iterator
      // (dropped connection, upstream disconnect) reach here OUTSIDE the
      // `client.chat.send` try/catch above — normalize them the same way so
      // the classifier's own-property signals and the redactor both apply
      // (a raw SDK rejection would otherwise bypass classification metadata
      // AND message redaction).
      yield* consumeOpenRouterStream(stream);
    } catch (err) {
      throw normalizeOpenRouterError(err, "streaming chat completion (mid-stream)");
    }
  }

  // ── getBalance ──────────────────────────────────────────────────

  async getBalance(): Promise<ProviderBalance | null> {
    // Try management key endpoint first (richer data)
    try {
      const res = await this.client.credits.getCredits();
      const total = res.data?.totalCredits ?? 0;
      const used = res.data?.totalUsage ?? 0;
      const remaining = total - used;
      const isLow = remaining < OPENROUTER_LOW_BALANCE_USD;

      return {
        available: remaining,
        currency: "USD",
        isLow,
        displayText: `$${remaining.toFixed(2)} USD`,
        total,
      };
    } catch {
      // Management key not available — try regular key metadata
    }

    // Fallback: getCurrentKeyMetadata (works with regular inference keys)
    try {
      const keyInfo = await this.client.apiKeys.getCurrentKeyMetadata();
      const data = keyInfo.data;
      const limit = data?.limit ?? null;
      const limitRemaining = data?.limitRemaining ?? null;

      if (limit != null && limitRemaining != null) {
        const isLow = limitRemaining < OPENROUTER_LOW_BALANCE_USD;
        return {
          available: limitRemaining,
          currency: "USD",
          isLow,
          displayText: `$${limitRemaining.toFixed(2)} USD (limit: $${limit.toFixed(2)})`,
          total: limit,
          usageDaily: data?.usageDaily,
          usageMonthly: data?.usageMonthly,
        };
      }

      // Key has no spending limit — balance unknown but not low
      return null;
    } catch {
      return null;
    }
  }

  // ── calculateCost ───────────────────────────────────────────────
  //
  // Delegates to the pure `computeRequestCost` (testable without a provider
  // instance). It prefers OpenRouter's authoritative `usage.cost` and falls
  // back to the local price-table estimate when that value is absent/invalid.

  calculateCost(usage: InferenceUsage, config: InferenceConfig): RequestCost {
    return computeRequestCost(usage, config);
  }

}
