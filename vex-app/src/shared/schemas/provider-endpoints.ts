/**
 * Schemas for `vex.onboarding.providerListEndpoints` — Wizard Step 6
 * provider (endpoint) selection.
 *
 * OpenRouter serves ONE model id from many endpoints (Anthropic direct,
 * Amazon Bedrock, Azure, Google Vertex, …). They differ in price, context
 * window, quantization and — decisively for Vex — in whether they accept a
 * `tools` array at all. Vex is a tool-calling agent, so an endpoint without
 * tool support is not a degraded choice, it is a broken one; the main process
 * HARD-FILTERS those rows out and the renderer never learns they exist.
 *
 * Pin key is `tag`, never `providerName`: `providerName` is NOT unique (the
 * live catalogue shows `amazon-bedrock`, `anthropic/claude-on-aws` and
 * `amazon-bedrock/eu-west-1` all displaying "Amazon Bedrock"), while `tag` is
 * the identifier OpenRouter's `provider.order` routes on.
 *
 * Pricing fields are BASE rates converted from the SDK's per-TOKEN decimal
 * strings to per-million numbers. They are NOT a total: `pricing.overrides`
 * carries conditional long-context/time-window rates we deliberately do not
 * model here, so the UI must label these as base rates.
 *
 * Lives in its own module rather than `provider.ts` because it is a distinct
 * responsibility (endpoint routing choice) from provider credentials/persist.
 */

import { z } from "zod";

/**
 * Upper bound on endpoints returned for one model. The live catalogue's
 * widest model exposes single-digit endpoints; this is a boundary guard on an
 * untrusted provider response, not an expected limit.
 */
export const PROVIDER_ENDPOINT_LIST_MAX = 100;

/**
 * Accepted `AUTHOR/SLUG` shape for an OpenRouter model id. The value is split
 * on the FIRST `/` and both halves are interpolated into a provider URL path,
 * so the charset is closed: no whitespace, no `/` beyond the single separator,
 * no `.` segments that could traverse a path.
 */
export const OPENROUTER_MODEL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]*)\/[A-Za-z0-9](?:[A-Za-z0-9._~:-]*)$/;

export const providerEndpointOptionSchema = z
  .object({
    /** Unique routing identifier — the value pinned into `provider.order`. */
    tag: z.string().trim().min(1).max(200),
    /** Human display name. NOT unique across tags — never use as a key. */
    providerName: z.string().trim().min(1).max(200),
    contextLength: z.number().int().positive().nullable(),
    /** e.g. "fp8", "bf16", "unknown". Absent on many endpoints. */
    quantization: z.string().trim().min(1).max(64).nullable(),
    /** BASE prompt price per 1M tokens (conditional overrides excluded). */
    pricingInputPerMillion: z.number().finite().nonnegative().nullable(),
    /** BASE completion price per 1M tokens (conditional overrides excluded). */
    pricingOutputPerMillion: z.number().finite().nonnegative().nullable(),
    /** BASE cache-READ price per 1M tokens; null when unpriced. */
    pricingCacheReadPerMillion: z.number().finite().nonnegative().nullable(),
    /** BASE cache-WRITE price per 1M tokens; null when unpriced. */
    pricingCacheWritePerMillion: z.number().finite().nonnegative().nullable(),
    /**
     * BASE internal-reasoning price per 1M tokens; null when unpriced.
     *
     * The SDK's `Pricing` type declares `internalReasoning`, but the live
     * endpoints route did NOT send it for any model checked on 2026-07-29
     * (including the reasoning models `openai/o3` and `deepseek/deepseek-r1`),
     * so in practice this is `null` today. Carried anyway because the runtime's
     * `EndpointCandidate` has a `reasoningPricePerM` slot: a real null is the
     * honest answer, and the field starts working by itself if OpenRouter
     * begins publishing it.
     */
    pricingReasoningPerMillion: z.number().finite().nonnegative().nullable(),

    // --- Availability (see `main/onboarding/provider-endpoint-availability.ts`
    // for the ranking rule these feed). Every field below is `null` when
    // OpenRouter reported no data. `null` means UNKNOWN — never render or
    // compare it as a perfect score.
    /** OpenRouter `uptime_last_5m`: successes / (successes + errors) * 100. */
    uptimeLast5mPercent: z.number().min(0).max(100).nullable(),
    /** OpenRouter `uptime_last_30m`, same ratio over 30 minutes. */
    uptimeLast30mPercent: z.number().min(0).max(100).nullable(),
    /** OpenRouter `uptime_last_1d`, same ratio over one day. */
    uptimeLast1dPercent: z.number().min(0).max(100).nullable(),
    /**
     * Raw OpenRouter `status` enum (`0, -1, -2, -3, -5, -10`). `0` is normal,
     * NEGATIVE means OpenRouter is deranking the endpoint. Kept raw so a new
     * enum member survives this boundary instead of being flattened away.
     */
    statusCode: z.number().int().nullable(),
    /** `statusCode < 0` — OpenRouter is routing traffic away from this row. */
    isDeranked: z.boolean(),
    /**
     * Weighted mean of the uptime windows present, 0–100; `null` when the API
     * reported no window. Derived by `computeAvailabilityScore`; carried on the
     * DTO so main, the renderer and the runtime rank on ONE rule.
     */
    availabilityScore: z.number().min(0).max(100).nullable(),
  })
  .strict();

export type ProviderEndpointOption = z.infer<typeof providerEndpointOptionSchema>;

export const providerListEndpointsInputSchema = z
  .object({
    modelId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(OPENROUTER_MODEL_ID_PATTERN),
  })
  .strict();

export type ProviderListEndpointsInput = z.infer<
  typeof providerListEndpointsInputSchema
>;

export const providerListEndpointsResultSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    endpoints: z
      .array(providerEndpointOptionSchema)
      .max(PROVIDER_ENDPOINT_LIST_MAX)
      .readonly(),
    /**
     * Tag of the endpoint Vex suggests: the top-ranked row, and only when its
     * availability is both measured and not deranked. `null` when there is
     * nothing honest to suggest.
     *
     * A HINT ONLY. It never changes the operator's selection — the wizard
     * badges the row and leaves the choice alone.
     *
     * Carried at the RESULT level rather than as a per-row boolean so two rows
     * cannot both claim to be suggested.
     */
    suggestedEndpointTag: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

export type ProviderListEndpointsResult = z.infer<
  typeof providerListEndpointsResultSchema
>;

/**
 * Split a validated model id into the `{author, slug}` pair
 * `client.endpoints.list` expects. Splits on the FIRST `/` only.
 *
 * Returns `null` for anything that does not match
 * `OPENROUTER_MODEL_ID_PATTERN` so callers cannot skip validation by calling
 * this directly — the renderer is untrusted and these values reach a URL path.
 */
export function splitOpenRouterModelId(
  modelId: string,
): { readonly author: string; readonly slug: string } | null {
  const trimmed = modelId.trim();
  if (!OPENROUTER_MODEL_ID_PATTERN.test(trimmed)) return null;
  const separator = trimmed.indexOf("/");
  return {
    author: trimmed.slice(0, separator),
    slug: trimmed.slice(separator + 1),
  };
}
