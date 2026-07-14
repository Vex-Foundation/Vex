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
export const LIMIT_ORDER_BASE_URL = "https://limit-order.kyberswap.com";
export const ZAAS_BASE_URL = "https://zap-api.kyberswap.com";

// ── Aggregator contracts (same address on all 19 aggregator chains) ──

export const META_AGGREGATION_ROUTER_V2: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
export const INPUT_SCALING_HELPER_V2: Address = "0x2f577A41BeC1BE1152AeEA12e73b7391d15f655D";

// ── Limit Order contracts ───────────────────────────────────────────

/**
 * DSLOProtocol — the current double-signature Limit Order Protocol, deployed at
 * the same address on all LO-supported chains. This is the ONLY verifyingContract
 * accepted for signing new orders / gasless cancels (see sign-message-verification).
 * The legacy single-signature LimitOrderProtocol
 * (0x227B0c196eA8db17A665EA6824D972A64202E936) is intentionally not defined here —
 * it must never be signed for.
 */
export const DSLO_PROTOCOL: Address = "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C";

export const WETH_UNWRAPPER: Address = "0x37334Cd06DFEcd2e9b3937a6dA17853d637A5b94";

// ── ZaaS contracts (same address on all ZaaS-supported chains) ──────

export const KS_ZAP_ROUTER_POSITION: Address = "0x0e97c887b61ccd952a53578b04763e7134429e05";
export const KS_ZAP_VALIDATOR_V2: Address = "0xa16f32442209c6b978431818aa535bcc9ad2863e";
/** Not deployed on Linea, Sonic, Ronin. */
export const KS_ZAP_ROUTER_PERMIT: Address = "0x638d935eEcD1646991A8b2CE9C2A2B7B840CCaBb";

// ── Spender allowlist (security: validate before any ERC-20 approve) ─

export const KYBER_KNOWN_SPENDERS: Set<string> = new Set([
  META_AGGREGATION_ROUTER_V2.toLowerCase(),
  DSLO_PROTOCOL.toLowerCase(),
  KS_ZAP_ROUTER_POSITION.toLowerCase(),
  KS_ZAP_ROUTER_PERMIT.toLowerCase(),
]);

// ── Per-client timeouts ─────────────────────────────────────────────

export const AGGREGATOR_TIMEOUT_MS = 15_000;
export const TOKEN_API_TIMEOUT_MS = 10_000;
export const COMMON_SERVICE_TIMEOUT_MS = 10_000;
export const LIMIT_ORDER_TIMEOUT_MS = 15_000;
export const ZAAS_TIMEOUT_MS = 20_000;
