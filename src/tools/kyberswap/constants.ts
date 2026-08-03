/**
 * KyberSwap constants — URLs, contract addresses, timeouts, spender allowlist.
 */

import type { Address } from "viem";

import { VEX_TREASURY_EVM } from "../../lib/vex-treasury.js";

// ── Client identification ───────────────────────────────────────────

export const KYBER_CLIENT_ID = "Vex";

/**
 * The header set EVERY KyberSwap client sends (SPEC §2.1, W2a).
 *
 * BLOCKING, live-reproduced 2026-08-03: KyberSwap sits behind Cloudflare on all
 * three hosts, and our previous header shape (no `User-Agent`, no `Accept`)
 * returns HTTP 403 with `cf-mitigated: challenge` — an HTML page, not JSON.
 * We had been running on a runtime accident: Node's `fetch` happens to send
 * `user-agent: node`, and any non-empty UA satisfies the edge. Making the UA
 * explicit removes the dependency on that accident.
 *
 * `X-Client-Id` is a REGISTERED id, not decoration: live-proven 60 requests /
 * 10 s with it against 30 / 10 s with a garbage id or none. It belongs on the
 * common-service client too, which sent none.
 *
 * Re-probed 2026-08-03 with this exact set: aggregator 200
 * (`x-ratelimit-limit: 60, 10`), token-api 200 (`100, 10`), common-service 200.
 *
 * The version is a LITERAL rather than a `package.json` read: this module is
 * bundled into the Electron main process, the value is only an identifier for
 * the provider's edge, and a stale digit has no behavioral effect. Update it
 * with the product version when it matters.
 */
export const KYBERSWAP_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "X-Client-Id": KYBER_CLIENT_ID,
  "User-Agent": "Vex/1.0.0 (+https://projectvex.ai)",
  Accept: "application/json",
};

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

// ── Slippage (venue facts) ──────────────────────────────────────────
//
// These are KyberSwap's OWN numbers, not Vex policy. The Vex-wide ceiling
// lives in `@vex-agent/tools/protocols/slippage-policy.ts` and is applied on
// top of `KYBERSWAP_MAX_SLIPPAGE_BPS` (the effective bound is the smaller of
// the two). `src/tools` must not import `src/vex-agent`, which is why the
// venue fact and the product policy are stated in different places.

// NOTE: there is no KyberSwap default slippage here anymore. What an omitted
// `slippageBps` MEANS is Vex product policy with exactly one home
// (`@vex-agent/tools/protocols/slippage-policy.ts` `VEX_DEFAULT_SLIPPAGE_BPS`),
// resolved by `protocols/kyberswap/handlers/swap/slippage.ts` before anything in
// this layer is called. A venue-local copy split the prequote match hash.

/**
 * The largest `slippageTolerance` KyberSwap's `/route/build` accepts.
 *
 * MEASURED, not documented: KyberSwap's public docs still state `[0, 2000]`,
 * but live builds accept up to 5000 chain-invariantly, reject 5001, and do NOT
 * clamp — a 5000 bps request produces a real 50%-loss-tolerant transaction.
 * Recorded here so the effective bound is derived from what the provider
 * actually enforces rather than from a stale doc.
 */
export const KYBERSWAP_MAX_SLIPPAGE_BPS = 5000;

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
