/**
 * The user's own EVM RPC endpoints for one chain id, read from the two config
 * override maps (`localChainRpcUrls`, `pendleRpcUrls` in `./store.ts`).
 *
 * WHY THIS EXISTS AS A NAMED READER. Both maps are keyed by chain-id string and
 * both mean the same thing to a consumer that only needs an endpoint for a
 * chain: "the endpoint the OWNER of this install told us to use". Each map had
 * exactly one reader that knew about it (`tools/evm-chains/registry.ts`
 * `getLocalChainRpcUrl`, `tools/pendle/evm-client.ts` `rpcUrlFor`), and both of
 * those resolve a URL for a chain they already have a registry entry for. The
 * bridge fill verifier needs the opposite question - "does the user have ANY
 * endpoint for chain 42161?" - for a chain no local registry knows, so the
 * question gets an owner here rather than a third private copy of the lookup.
 *
 * TRUST. These are the app's own configuration, written by the user, not
 * provider-supplied input: callers use them WITHOUT the SSRF filter that guards
 * a provider registry (a user pointing Vex at their own `http://localhost:8545`
 * archive node is a supported setup, and `isSsrfSafeRpcUrl` would refuse it).
 * The shape check below is therefore the only bound: an http(s) URL, same rule
 * `getLocalChainRpcUrl` already applies to the same map.
 */

import { loadConfig } from "./store.js";

/** Same shape rule the local-chain registry applies to `localChainRpcUrls`. */
const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * Every user-configured RPC endpoint for `chainId`, `localChainRpcUrls` first,
 * de-duplicated, order preserved. Empty when the user configured none.
 */
export function getUserRpcOverridesForChain(chainId: number): string[] {
  const config = loadConfig();
  const key = String(chainId);
  const out: string[] = [];
  for (const map of [config.localChainRpcUrls, config.pendleRpcUrls]) {
    const raw = map?.[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!HTTP_URL.test(trimmed) || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}
