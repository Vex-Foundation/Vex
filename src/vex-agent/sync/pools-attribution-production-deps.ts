/**
 * Production wiring for the pools.fun attribution lane, split out of
 * `./pools-attribution.ts`. A different reason to change from the sweep: the
 * sweep owns the lane's behavior; this file owns where its dependencies come
 * from in the real process (config URL policy, the keyless HTTP client).
 *
 * Mirrors `agentscan-report/production-deps.ts` deliberately - the two lanes
 * have the same "ships dark, HTTPS-only, refuse rather than guess" policy, and
 * a second lane that resolved its URL differently would be a second answer to
 * the same question.
 */

import { loadConfig } from "@config/store.js";
import logger from "@utils/logger.js";
import type { PoolsAttributionDeps } from "./pools-attribution.js";

/** Warn once per process about a refused non-HTTPS URL - the lane ticks on a timer. */
let warnedInsecureUrl = false;

/**
 * Resolve the configured base URL. HTTPS-only, except localhost for local
 * development against a stub - the contract is HTTPS-only, and a plaintext
 * attestation URL would expose the launcher's signature to the network path.
 *
 * Returns `null` for empty, malformed, or insecure. The sweep checks this
 * BEFORE claiming any row, so an unconfigured lane costs nothing.
 */
export function resolvePoolsAttestBaseUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return trimmed;
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && isLocalhost) return trimmed;
  if (!warnedInsecureUrl) {
    warnedInsecureUrl = true;
    logger.warn("pools.attribution.insecure_url_refused");
  }
  return null;
}

/** The production wiring: one keyless POST per candidate, no signer anywhere. */
export function buildProductionPoolsAttributionDeps(): PoolsAttributionDeps {
  return {
    baseUrl: () => resolvePoolsAttestBaseUrl(loadConfig().services.poolsFunAttestApiUrl),
    attribute: async (input) => {
      const { attributePoolsLaunch } = await import("@tools/pools-fun/attribution.js");
      return attributePoolsLaunch(input);
    },
  };
}
