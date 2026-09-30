/**
 * Effective WalletBalances leg bounds (Kairos Phase 6, W-1), read from the
 * environment at the point of use.
 *
 * An invalid value never widens anything: it is logged (key and reason only,
 * never the raw value) and the field's default applies. `loadEnvConfig` in
 * `inference/config.ts` validates the same fields and fails startup on them,
 * so in a running engine this fallback is only a guard.
 *
 * `parallelLegs: false` with `legTimeoutMs: 0` is the pre-Phase-6 read,
 * exactly (proven in `read-legs.test.ts`).
 */

import {
  parseAgentWalletReadEnv,
  type AgentWalletReadBounds,
} from "../../../../lib/agent-config.js";
import logger from "@utils/logger.js";

export type { AgentWalletReadBounds };

/** Pre-Phase-6 behaviour. Also what the OFF test compares against. */
export const WALLET_READ_LEGACY_BOUNDS: AgentWalletReadBounds = {
  parallelLegs: false,
  legTimeoutMs: 0,
};

/**
 * Khalani chains in flight when the legs run in parallel. Today's serial
 * read uses 4 (`DEFAULT_BALANCE_SCAN_CONCURRENCY`). Measured 2026-09-30 on
 * the public endpoint: 18 EVM chains, 0.6 to 3.4 s per chain call, 13.3 s for
 * the scan at 4 in flight. One provider, so one cap.
 */
export const WALLET_READ_KHALANI_CONCURRENCY = 8;

/**
 * Chains priced at once in the Khalani price pass when the legs run in
 * parallel. Every request still draws on the one shared DexScreener throttle.
 */
export const WALLET_READ_PRICING_CHAIN_CONCURRENCY = 4;

export function readWalletReadBounds(
  env: NodeJS.ProcessEnv = process.env,
): AgentWalletReadBounds {
  const parsed = parseAgentWalletReadEnv(env);
  for (const error of parsed.errors) {
    logger.warn("wallet.read_bounds.invalid_using_default", {
      key: error.key,
      reason: error.reason,
    });
  }
  return parsed.value;
}
