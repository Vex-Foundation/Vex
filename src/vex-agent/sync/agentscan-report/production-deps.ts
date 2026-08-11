/**
 * Production wiring for the reporting lane, split out of
 * `../agentscan-report.ts` (550-line facade decree). A different reason to
 * change from the facade: the facade owns the lane's behavior; this file owns
 * where its dependencies come from in the real process (config URL policy,
 * HTTP clients, the vault-gated signer, the host app version).
 */

import { loadConfig } from "../../../config/store.js";
import { buildAgentscanClient } from "../../agentscan/client.js";
import { buildAgentscanSessionClient } from "../../agentscan/session-client.js";
import { signAgentscanChallenge } from "../../agentscan/handshake.js";
import logger from "@utils/logger.js";
import type { AgentscanReporterDeps } from "../agentscan-report.js";

/** Warn once per process about a refused non-HTTPS URL — the lane ticks every 30 s. */
let warnedInsecureUrl = false;

/**
 * Resolve the configured base URL. HTTPS-only, except localhost for local
 * development against the compose stack — the contract is HTTPS-only and a
 * plaintext ingest URL would leak the token to the network path.
 */
export function resolveAgentscanBaseUrl(rawUrl: string): string | null {
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
    logger.warn("agentscan.report.insecure_url_refused");
  }
  return null;
}

export function buildProductionAgentscanReporterDeps(): AgentscanReporterDeps {
  return {
    baseUrl: () => resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl),
    buildClient: buildAgentscanClient,
    buildSessionClient: buildAgentscanSessionClient,
    signChallenge: signAgentscanChallenge,
    appVersion: () => {
      const version = process.env.VEX_APP_VERSION;
      return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
    },
  };
}
