/**
 * `ChatRequest.provider` — routing preferences for one OpenRouter request.
 *
 * This module is the SINGLE owner of the `provider` object. It previously lived
 * inline in `chatCompletionSimple` and covered only the judge's
 * `responseFormat`; two levers now merge here so neither can overwrite the
 * other:
 *
 * 1. `requireParameters: true` — "filter providers to only those that support
 *    the parameters you've provided" (SDK `providerpreferences.d.ts`; wire
 *    `require_parameters`). Set whenever the request carries TOOLS or a
 *    RESPONSE FORMAT. Without it OpenRouter may route a tool-bearing request to
 *    an endpoint that silently drops `tools` and returns prose, which the engine
 *    then has to interpret as a failed turn. With it the request fails loud and
 *    the caller retries — the conservative choice for an agent that acts on
 *    tool results. `allowFallbacks` stays at its default `true`, so a provider
 *    OUTAGE still falls back, but only among honoring endpoints.
 *
 * 2. An optional PINNED endpoint — `order: [tag]` + `allowFallbacks: false`.
 *    Pin on the endpoint `tag`, never `providerName`: the display name is
 *    non-unique (`anthropic` vs `anthropic/2`; three `amazon-bedrock*` tags all
 *    render "Amazon Bedrock"), while `tag` is the unique routing identifier.
 *    `order` (not `only`) is deliberate — `only` is documented as MERGED with
 *    account-wide allowed-provider settings we do not control, so it cannot
 *    express a deterministic pin.
 *
 * `endpointTag` has TWO producers now: the wizard's provider selection
 * (`OPENROUTER_ENDPOINT_TAG`), and — since 2026-07-29 — endpoint failover,
 * which replaces it after a session switches away from an endpoint that ran out
 * of capacity (`openrouter/endpoint-failover.ts`). Both arrive here the same
 * way, as a config field, so this module needs no branch for the difference.
 *
 * A manual `order` DISABLES OpenRouter's own sticky routing (its docs: "Sticky
 * routing is not used when you specify a manual provider order"), and
 * `allowFallbacks: false` leaves exactly ONE eligible endpoint — which is what
 * turned an upstream 429 into a hard wall on 2026-07-29. Pinned mode and the
 * router's own failover remain a real trade-off, not additive upgrades; the
 * runtime now supplies the missing failover ITSELF, deliberately, with a
 * chosen target and a persisted record instead of an invisible reroute.
 */

import type { ChatRequest } from "@openrouter/sdk/models/chatrequest.js";

export interface ProviderPreferencesInput {
  /** The request carries a non-empty `tools` array. */
  readonly hasTools: boolean;
  /** The request carries a `responseFormat` (structured-output enforcement). */
  readonly hasResponseFormat: boolean;
  /**
   * Endpoint `tag` to pin routing to. Undefined/blank ⇒ no pin (today's
   * behaviour). Supplied by the wizard-selected provider config in W3.
   */
  readonly endpointTag?: string | undefined;
}

/**
 * Build the merged `provider` preferences, or `undefined` when no lever
 * applies — callers with neither tools, a response format, nor a pin must send
 * a byte-identical wire request to today's.
 */
export function buildProviderPreferences(
  input: ProviderPreferencesInput,
): ChatRequest["provider"] | undefined {
  const requireParameters = input.hasTools || input.hasResponseFormat;
  const pinnedTag = input.endpointTag?.trim();
  const hasPin = pinnedTag !== undefined && pinnedTag.length > 0;

  if (!requireParameters && !hasPin) return undefined;

  return {
    ...(requireParameters && { requireParameters: true }),
    // A blank tag would produce an empty `order`, leaving zero eligible
    // endpoints and hard-failing the request (503) — treated as "no pin".
    ...(hasPin && { order: [pinnedTag], allowFallbacks: false }),
  };
}
