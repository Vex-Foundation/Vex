/**
 * KyberSwap constants — URLs, contract addresses, timeouts, spender allowlist.
 */

import type { Address } from "viem";

import { VEX_TREASURY_EVM } from "../../lib/vex-treasury.js";

// ── Client identification ───────────────────────────────────────────

export const KYBER_CLIENT_ID = "Vex";

// ── Vex integrator fee (aggregator swaps) ───────────────────────────
//
// Product-owner-reviewed constants — NEVER derived from model/tool params. A
// model-controllable fee is an overcharge vector, so these are hard-coded next
// to the venue they configure and fed to GET /routes verbatim. Base is 10000
// (Kyber `isInBps: true`), so 25 = 0.25%. Charged in the INPUT token; KyberSwap
// requires no on-chain approval and takes 0% cut. Fees accrue to VEX_TREASURY_EVM
// (Vex-treasury: token buyback and burn).

export const KYBERSWAP_FEE_BPS = 25;
export const KYBERSWAP_FEE_CHARGE_BY = "currency_in" as const;
export const KYBERSWAP_FEE_RECEIVER: Address = VEX_TREASURY_EVM;

// ── Native token (same on all EVM chains) ───────────────────────────

export const NATIVE_TOKEN_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// ── Base URLs ───────────────────────────────────────────────────────

export const AGGREGATOR_BASE_URL = "https://aggregator-api.kyberswap.com";
export const TOKEN_API_BASE_URL = "https://token-api.kyberswap.com";
export const COMMON_SERVICE_BASE_URL = "https://common-service.kyberswap.com";

// ── Aggregator contracts (same address on all 19 aggregator chains) ──

export const META_AGGREGATION_ROUTER_V2: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
export const INPUT_SCALING_HELPER_V2: Address = "0x2f577A41BeC1BE1152AeEA12e73b7391d15f655D";

// ── Spender allowlist (security: validate before any ERC-20 approve) ─
//
// Agent Scan (plan §4.2) deleted limit-order + zap tooling — the router is
// now the ONLY spender the aggregator swap path ever approves.

export const KYBER_KNOWN_SPENDERS: Set<string> = new Set([
  META_AGGREGATION_ROUTER_V2.toLowerCase(),
]);

// ── Per-client timeouts ─────────────────────────────────────────────

export const AGGREGATOR_TIMEOUT_MS = 15_000;
export const TOKEN_API_TIMEOUT_MS = 10_000;
export const COMMON_SERVICE_TIMEOUT_MS = 10_000;
