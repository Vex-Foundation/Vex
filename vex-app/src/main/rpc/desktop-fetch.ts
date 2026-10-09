import { net } from "electron";
import { configureEvmRpcFetch } from "@tools/evm-chains/rpc-fetch.js";

const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com/";

/** Use native networking for the official RHC endpoint; preserve all other fetch policies. */
export function createDesktopRpcFetch(
  nativeFetch: typeof fetch,
  defaultFetch: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let official = false;
    try { official = new URL(url).href === ROBINHOOD_RPC_URL; } catch { /* Delegate URL validation to the default transport. */ }
    if (!official) return defaultFetch(input, init);
    // No cookie authority or redirect to another endpoint accompanies RPC data.
    // This is one request on the already-selected node, including broadcasts.
    return nativeFetch(input, { ...init, credentials: "omit", redirect: "error" });
  };
}

export function installDesktopRpcFetch(): () => void {
  return configureEvmRpcFetch(createDesktopRpcFetch((input, init) => net.fetch(input instanceof URL ? input.href : input, init)));
}
