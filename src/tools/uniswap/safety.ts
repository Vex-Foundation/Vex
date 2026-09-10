/**
 * Uniswap quote-time safety signals (LOCKED Wave-2 correction #5).
 *
 * Uniswap has no honeypot/FoT oracle like KyberSwap, so on chains without those
 * flags Vex derives its own conservative signals at QUOTE time and embeds them
 * in the quote result. The prequote safety extractor re-validates them and maps
 * to the EXISTING pass/fail/unknown doctrine (unknown = allowed-with-approval-
 * warning; only a hard integrity violation is `fail`). This module owns the two
 * on-chain (RPC) signals; the DexScreener min-liquidity signal is gathered by
 * the handler (it owns the throttled DexScreener client).
 *
 * - FACTORY ALLOWLIST: every pool in the winning route must report a `factory()`
 *   that is the registered Uniswap V2/V3 factory for that chain. A mismatch is a
 *   hard integrity violation (a spoofed pool) → the extractor maps it to `fail`.
 *   Since routes are built from our own quoter/router this should always hold —
 *   it is a defense-in-depth confirmation, fail-CLOSED to "unknown" on a read
 *   error (never fabricate a pass).
 * - FoT SIGNAL: V3 QuoterV2 reverts on fee-on-transfer tokens. If a V3 pool
 *   EXISTS for the output token but the quoter reverts on it, that is a
 *   fee-on-transfer tell (best-effort; never gates on its own).
 */

import {
  getAddress,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { assertV4Binding } from "./v4-pool.js";
import {
  UNISWAP_V2_FACTORY_ABI,
  UNISWAP_V2_PAIR_ABI,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
  UNISWAP_V3_QUOTER_V2_ABI,
} from "./abis.js";
import type { UniswapDeployment } from "./deployments.js";
import type { UniswapRoute } from "./types.js";

/** Minimum output-token DEX liquidity (USD) for a `pass`-worthy signal. */
export const UNISWAP_MIN_LIQUIDITY_USD = 5_000;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isZero(addr: string): boolean {
  return /^0x0+$/.test(addr);
}

/**
 * Confirm every pool in the route reports an allowlisted factory. Returns
 * `{ checked: true, allowlisted }`; on any read failure returns
 * `{ checkFailed: true }` (the extractor treats that as `unknown`, never `pass`).
 */
export async function checkRouteFactories(
  client: PublicClient<Transport, Chain>,
  deployment: UniswapDeployment,
  route: UniswapRoute,
): Promise<{ checked: true; allowlisted: boolean } | { checkFailed: true }> {
  if (route.version === "v4") {
    try { assertV4Binding(deployment, route.v4); return { checked: true, allowlisted: true }; }
    catch { return { checked: true, allowlisted: false }; }
  }
  const allowed = new Set<string>();
  if (deployment.v2) allowed.add(deployment.v2.factory.toLowerCase());
  if (deployment.v3) allowed.add(deployment.v3.factory.toLowerCase());

  try {
    for (let i = 0; i < route.path.length - 1; i += 1) {
      const a = getAddress(route.path[i]!);
      const b = getAddress(route.path[i + 1]!);
      let poolAddr: Address;
      if (route.version === "v2") {
        poolAddr = (await client.readContract({
          address: deployment.v2!.factory,
          abi: UNISWAP_V2_FACTORY_ABI,
          functionName: "getPair",
          args: [a, b],
        })) as Address;
      } else {
        const fee = route.fees?.[i];
        if (fee === undefined) return { checkFailed: true };
        poolAddr = (await client.readContract({
          address: deployment.v3!.factory,
          abi: UNISWAP_V3_FACTORY_ABI,
          functionName: "getPool",
          args: [a, b, fee],
        })) as Address;
      }
      if (isZero(poolAddr)) return { checked: true, allowlisted: false };
      const factory = (await client.readContract({
        address: poolAddr,
        abi: route.version === "v2" ? UNISWAP_V2_PAIR_ABI : UNISWAP_V3_POOL_ABI,
        functionName: "factory",
      })) as Address;
      if (!allowed.has(factory.toLowerCase())) return { checked: true, allowlisted: false };
    }
    return { checked: true, allowlisted: true };
  } catch {
    return { checkFailed: true };
  }
}

/**
 * Best-effort fee-on-transfer signal for the OUTPUT token. True only when a V3
 * pool clearly EXISTS for [output, WETH] yet the QuoterV2 reverts on it (the
 * classic FoT tell). Returns false when no V3 deployment, no such pool, the
 * quote succeeds, or any read fails — never throws.
 */
export async function probeFotSignal(
  client: PublicClient<Transport, Chain>,
  deployment: UniswapDeployment,
  outputToken: Address,
): Promise<boolean> {
  if (!deployment.v3) return false;
  const weth = getAddress(deployment.weth);
  if (outputToken.toLowerCase() === weth.toLowerCase()) return false;
  const probeFee = 3000;
  try {
    const pool = (await client.readContract({
      address: deployment.v3.factory,
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: "getPool",
      args: [weth, outputToken, probeFee],
    })) as Address;
    if (isZero(pool)) return false;
    const liquidity = (await client.readContract({
      address: pool,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "liquidity",
    })) as bigint;
    if (liquidity <= 0n) return false;
    // Pool exists with liquidity — the quoter should return. If it reverts, FoT.
    try {
      await client.readContract({
        address: deployment.v3.quoterV2,
        abi: UNISWAP_V3_QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: weth, tokenOut: outputToken, amountIn: 10n ** 12n, fee: probeFee, sqrtPriceLimitX96: 0n }],
      });
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

// Keep ZERO_ADDRESS referenced for clarity / future callers.
export { ZERO_ADDRESS };
