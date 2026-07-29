/**
 * Routing-metadata observability for the two CONVERSATIONAL sends.
 *
 * Opting in with the request-envelope field `xOpenRouterMetadata: "enabled"`
 * makes OpenRouter return `openrouter_metadata` on the response, describing
 * how the request was actually routed. That answers questions the runtime
 * currently cannot: which upstream provider served this turn, did OpenRouter
 * retry across providers before one accepted it, and how many endpoints were
 * even eligible (the last one is how an over-narrow endpoint pin becomes
 * visible instead of just looking like bad luck).
 *
 * Scope guards, deliberate:
 * - Attached to `chatCompletion` and `chatCompletionStream` ONLY. Background
 *   one-shots (`chatCompletionSimple`: chunker, judge, entity extraction,
 *   regime) are not part of a conversation and get no benefit from routing
 *   provenance, so they keep a byte-identical envelope.
 * - LOG ONLY. Nothing here is persisted; no schema, no column, no event.
 * - A BOUNDED projection, never the raw object. `OpenRouterMetadata` also
 *   carries `params`, `pipeline` and `summary`, which can echo request shape;
 *   emitting the whole thing would drift into logging request content.
 * - Best-effort: this is telemetry on the money path, so a malformed or absent
 *   metadata block must never disturb the completion. Every field is read
 *   defensively and a throw is swallowed.
 */

import type { OpenRouterMetadata } from "@openrouter/sdk/models/openroutermetadata.js";

import logger from "@utils/logger.js";

import { boundedProviderName } from "./provider-signals.js";

/** The bounded projection we are willing to put in a log line. */
export interface RoutingMetadataSummary {
  /**
   * Upstream provider that served the request — the LAST routing attempt,
   * which is the one that succeeded when the response exists at all.
   */
  readonly provider: string | null;
  /** How many upstream attempts the router made before returning. */
  readonly attempts: number | null;
  /** How many endpoints were eligible for this request. */
  readonly endpointsAvailable: number | null;
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Project `OpenRouterMetadata` down to the three bounded fields we log.
 * Exported for direct unit testing without a live send.
 */
export function summarizeRoutingMetadata(
  metadata: OpenRouterMetadata,
): RoutingMetadataSummary {
  const attempts = Array.isArray(metadata.attempts) ? metadata.attempts : null;
  const servingAttempt = attempts !== null ? attempts[attempts.length - 1] : undefined;

  // LIVE-MEASURED (2026-07-28, DeepSeek@DeepInfra, 6/6 rounds): `attempts[]`
  // is ABSENT on a normal single-attempt success — the router only materializes
  // the list when it actually retried. The serving provider on the common path
  // is the `selected` entry of `endpoints.available` (EndpointInfo.selected).
  // Prefer the attempt list when it exists (a retry's last attempt is the one
  // that succeeded); fall back to the selected endpoint.
  const selectedEndpoint = Array.isArray(metadata.endpoints?.available)
    ? metadata.endpoints.available.find((endpoint) => endpoint.selected === true)
    : undefined;

  return {
    provider:
      boundedProviderName(servingAttempt?.provider)
      ?? boundedProviderName(selectedEndpoint?.provider),
    // Prefer the attempt LIST length (what actually happened); fall back to the
    // scalar `attempt` index the router always sets.
    attempts: attempts !== null ? attempts.length : finiteCount(metadata.attempt),
    endpointsAvailable:
      finiteCount(metadata.endpoints?.available?.length)
      ?? finiteCount(metadata.endpoints?.total),
  };
}

/**
 * Emit the bounded routing summary for one completion. Never throws — see the
 * best-effort guard in the module doc.
 */
export function observeRoutingMetadata(
  metadata: OpenRouterMetadata,
  operation: string,
): void {
  try {
    logger.info("inference.openrouter.routing", {
      operation,
      ...summarizeRoutingMetadata(metadata),
    });
  } catch {
    // Telemetry must never affect the completion it describes.
  }
}
