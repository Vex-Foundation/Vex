/**
 * Production wiring for the pools.fun attribution lane, split out of
 * `./pools-attribution.ts`. A different reason to change from the sweep: the
 * sweep owns the lane's behavior; this file owns where its dependencies come
 * from in the real process (the master gate, config URL policy, the keyless
 * HTTP client).
 *
 * TWO gates, both required before a single row is claimed:
 *
 *   1. `poolsAttestationEnabled()` - the strict-boolean master switch. The
 *      lane's contract says disabled means zero sweep claims and zero HTTP,
 *      not merely "no new signatures", so the sweep must ask it too: a
 *      configured URL alone must never turn delivery on.
 *   2. `resolvePoolsAttestBaseUrl` - the HTTPS-only URL policy, owned by the
 *      client module because that is the HTTP boundary it protects.
 *
 * Mirrors `agentscan-report/production-deps.ts` deliberately - the same
 * "ships dark, HTTPS-only, refuse rather than guess" policy.
 */

import { loadConfig, poolsAttestationEnabled } from "@config/store.js";
import { resolvePoolsAttestBaseUrl } from "@tools/pools-fun/attribution.js";
import logger from "@utils/logger.js";
import type { PoolsAttributionDeps } from "./pools-attribution.js";

/** Warn once per process about a refused non-empty URL - the lane ticks on a timer. */
let warnedRefusedUrl = false;

function resolveGatedBaseUrl(): string | null {
  if (!poolsAttestationEnabled()) return null;
  const raw = loadConfig().services.poolsFunAttestApiUrl;
  const resolved = resolvePoolsAttestBaseUrl(raw);
  if (resolved === null && typeof raw === "string" && raw.trim().length > 0 && !warnedRefusedUrl) {
    // The lane is ON and someone configured a URL the policy refuses - that is
    // an operator mistake worth exactly one loud line, not one per tick.
    warnedRefusedUrl = true;
    logger.warn("pools.attribution.attest_url_refused");
  }
  return resolved;
}

/** The production wiring: one keyless POST per candidate, no signer anywhere. */
export function buildProductionPoolsAttributionDeps(): PoolsAttributionDeps {
  return {
    baseUrl: resolveGatedBaseUrl,
    attribute: async (input) => {
      const { attributePoolsLaunch } = await import("@tools/pools-fun/attribution.js");
      return attributePoolsLaunch(input);
    },
  };
}
