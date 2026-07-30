/**
 * OpenRouter `/models` catalog read — derives an `InferenceConfig` for the
 * configured model.
 *
 * Extracted from `OpenRouterProvider` so the provider keeps ONE reason to
 * change (sending chat requests) and the catalog keeps its own (reading model
 * metadata and pricing). The caching/stale-serve policy stays with the
 * provider; this module performs the uncached read and classifies its outcome.
 */

import type { OpenRouter } from "@openrouter/sdk";

import type { InferenceConfig } from "../types.js";
import { resolveEffectiveContextLimit } from "../context-window.js";
import logger from "@utils/logger.js";
import { extractCauseCode } from "../../../lib/error-cause.js";

// ── Pricing parse ────────────────────────────────────────────────
//
// OpenRouter `/models` pricing fields are per-TOKEN decimal strings. Convert
// to per-1M and reject any non-finite result (missing field, non-numeric, NaN,
// Infinity) so a malformed catalog entry can never propagate NaN into cost
// math — it becomes `null`, and required prices fall back to 0 at the call site.
export function parsePricePerM(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const perToken = parseFloat(String(raw));
  if (!Number.isFinite(perToken)) return null;
  const perM = perToken * 1_000_000;
  return Number.isFinite(perM) ? perM : null;
}

// ── api_unreachable hint selection (error-diagnostics D-RUNTIME) ─
//
// The generic "Check OPENROUTER_API_KEY" hint is actively misleading when the
// real failure is TLS interception (antivirus/proxy) or DNS. Pick the hint
// from the errno-shaped cause code; the code itself is logged alongside.
const TLS_CAUSE_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
]);
const DNS_CAUSE_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN"]);

export function apiUnreachableHint(causeCode: string | null): string {
  if (causeCode !== null && TLS_CAUSE_CODES.has(causeCode)) {
    return (
      "TLS certificate verification failed — antivirus or proxy HTTPS " +
      "inspection may be intercepting connections"
    );
  }
  if (causeCode !== null && DNS_CAUSE_CODES.has(causeCode)) {
    return "DNS lookup failed — check your network connection or DNS settings";
  }
  return "Check OPENROUTER_API_KEY and network connectivity";
}

// ── Fetch ────────────────────────────────────────────────────────

/** Identity + operator-chosen limits the catalog read turns into a config. */
export interface ModelConfigSpec {
  readonly providerId: string;
  readonly model: string;
  /**
   * Operator-configured ceiling (`AGENT_CONTEXT_LIMIT`). NOT the value that
   * reaches `InferenceConfig.contextLimit` — the catalog row's real window
   * clamps it first (see `context-window.ts`).
   */
  readonly contextLimit: number;
  readonly temperature: number | undefined;
  readonly maxOutputTokens: number;
  /** Optional pinned endpoint tag (`OPENROUTER_ENDPOINT_TAG`). */
  readonly endpointTag: string | undefined;
}

/**
 * Outcome of one `/models` read, classified so the caller can decide
 * stale-vs-null:
 *   - `success`              → catalog responded and contains the model;
 *   - `model_not_found`      → catalog responded but lacks the model (hard);
 *   - `metadata_unavailable` → the `/models` request itself failed.
 */
export type ModelConfigFetchResult =
  | { kind: "success"; config: InferenceConfig }
  | { kind: "model_not_found" }
  | { kind: "metadata_unavailable" };

/** Minimal shape we consume from a catalog row (provider response = untrusted). */
interface CatalogModelRow {
  readonly id: string;
  /**
   * The model's real context window in tokens. Typed `number | null` by the
   * installed SDK (`models/model.d.ts`), declared `unknown` here because the
   * catalog is an untrusted provider response — validated in
   * `context-window.ts`, never trusted as typed.
   */
  readonly contextLength?: unknown;
  readonly pricing?:
    | {
        readonly prompt?: unknown;
        readonly completion?: unknown;
        readonly inputCacheRead?: unknown;
        readonly inputCacheWrite?: unknown;
        readonly internalReasoning?: unknown;
      }
    | undefined;
  readonly supportedParameters?: unknown;
}

export async function fetchModelInferenceConfig(
  client: OpenRouter,
  spec: ModelConfigSpec,
): Promise<ModelConfigFetchResult> {
  const logUnreachable = (err: unknown): void => {
    const causeCode = extractCauseCode(err);
    logger.error("inference.openrouter.api_unreachable", {
      model: spec.model,
      error: err instanceof Error ? err.message : String(err),
      ...(causeCode !== null ? { causeCode } : {}),
      hint: apiUnreachableHint(causeCode),
    });
  };

  // `/models` transport/server/SDK failure → metadata_unavailable (the caller
  // may serve a last-good config). A successful catalog that lacks the model is
  // a distinct, hard `model_not_found`.
  //
  // SDK 1.1.13 returns a PAGE ITERATOR here (0.12.79 returned a single
  // response with `.data`). The default page size is 500 and the live catalog
  // is ~341 models, so page one holds everything today — but relying on that
  // would turn future catalog growth into a spurious `model_not_found`, which
  // is a HARD failure that stops the agent. Walk the pages until the model is
  // found instead. The iterator fetches page 2+ lazily, so the common case
  // still costs exactly one request.
  let found: CatalogModelRow | undefined;
  try {
    const pages = await client.models.list({});
    for await (const page of pages) {
      const rows: ReadonlyArray<CatalogModelRow> = page.result.data ?? [];
      found = rows.find((m) => m.id === spec.model);
      if (found !== undefined) break;
    }
  } catch (err) {
    logUnreachable(err);
    return { kind: "metadata_unavailable" };
  }

  if (!found) {
    logger.error("inference.openrouter.model_not_found", {
      model: spec.model,
      hint: "Check AGENT_MODEL or OpenRouter model availability",
    });
    return { kind: "model_not_found" };
  }

  let inputPricePerM = 0;
  let outputPricePerM = 0;
  let cachePricePerM: number | null = null;
  let cacheWritePricePerM: number | null = null;
  let reasoningPricePerM: number | null = null;

  if (found.pricing) {
    // PublicPricing: prompt/completion are per-TOKEN strings (not per-1M).
    // A malformed/non-numeric price must NOT poison cost math as NaN — guard
    // each parse so a bad value falls back to 0 (required prices) or null
    // (optional prices).
    //
    // These top-level keys remain the right ones to read after the 1.1.13
    // bump: the SDK now also types `pricing.overrides` (conditional
    // long-context/time-window pricing) and `inputCacheWrite1h`, but its own
    // docstring states the top-level keys "always reflect the price that
    // applies under default conditions". `usage.cost` stays authoritative for
    // what we actually persist; this table is the local cross-check.
    inputPricePerM = parsePricePerM(found.pricing.prompt) ?? 0;
    outputPricePerM = parsePricePerM(found.pricing.completion) ?? 0;
    cachePricePerM = parsePricePerM(found.pricing.inputCacheRead);
    cacheWritePricePerM = parsePricePerM(found.pricing.inputCacheWrite);
    reasoningPricePerM = parsePricePerM(found.pricing.internalReasoning);
  }

  // D6: the reasoning-EFFORT request gate is the catalog's own
  // `supported_parameters` tag, independent of pricing — a model can be
  // free to reason (no `internalReasoning` price) yet still accept an
  // explicit effort, and vice versa. Untrusted provider response: guard
  // for a missing/non-array field rather than trusting the SDK's type.
  const supportedParameters: ReadonlyArray<string> = Array.isArray(
    found.supportedParameters,
  )
    ? found.supportedParameters
    : [];
  // The request we emit is the `reasoning` OBJECT param, whose catalog tag
  // is "reasoning"; some models additionally (or only) tag the flat
  // "reasoning_effort" param. Either tag means the model accepts an effort
  // choice — the OR keeps this gate symmetric with the app catalog's
  // capability predicate, so a visible selector can never have its choice
  // dropped here (coordinator fix, 2026-07-21).
  const supportsReasoningEffort =
    supportedParameters.includes("reasoning") ||
    supportedParameters.includes("reasoning_effort");

  // Effective context limit = min(configured, the model's REAL window). The
  // configured value is an operator throttle; the catalog row is the only
  // place the provider's actual window is known. Unknown/implausible window ⇒
  // configured value unchanged — the catalog never blocks a run.
  //
  // Bounded logging: this whole function runs at most once per
  // MODEL_CONFIG_CACHE_TTL_MS (1 h) per provider instance, so the warn below
  // cannot flood a loop even though the limit is consulted every iteration.
  const contextLimit = resolveEffectiveContextLimit(spec.contextLimit, found.contextLength);
  if (contextLimit.reason !== "within_model_window") {
    logger.warn("inference.openrouter.context_limit_adjusted", {
      model: spec.model,
      configured: contextLimit.configured,
      effective: contextLimit.effective,
      modelContextWindow: contextLimit.modelWindow,
      reason: contextLimit.reason,
    });
  }

  logger.info("inference.openrouter.config_loaded", {
    model: spec.model,
    contextLimit: contextLimit.effective,
    modelContextWindow: contextLimit.modelWindow,
    inputPricePerM: inputPricePerM.toFixed(4),
    outputPricePerM: outputPricePerM.toFixed(4),
    hasCachePrice: cachePricePerM !== null,
    hasReasoningPrice: reasoningPricePerM !== null,
    supportsReasoningEffort,
  });

  return {
    kind: "success",
    config: {
      provider: spec.providerId,
      model: spec.model,
      contextLimit: contextLimit.effective,
      temperature: spec.temperature,
      maxOutputTokens: spec.maxOutputTokens,
      ...(spec.endpointTag !== undefined && { endpointTag: spec.endpointTag }),
      inputPricePerM,
      outputPricePerM,
      priceCurrency: "USD",
      cachePricePerM,
      cacheWritePricePerM,
      reasoningPricePerM,
      supportsReasoningEffort,
    },
  };
}
