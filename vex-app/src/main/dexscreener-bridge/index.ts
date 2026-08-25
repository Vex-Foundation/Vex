/**
 * The DexScreener site transport, assembled.
 *
 * This is the Electron-side implementation of the contract in
 * `src/tools/dexscreener/transport.ts`. It is NOT mounted anywhere yet:
 * registering it into the agent runtime is a separate, later step, so nothing
 * agent-visible changes with this module's arrival.
 *
 * Ownership: the caller owns the returned handle. `transport` is what gets
 * registered; `dispose()` releases the hidden window, the session hook and any
 * exchange still running, and is idempotent. Whoever registers the transport
 * must call `dispose()` from the same teardown path that unregisters it.
 */

import type { DexScreenerTransport } from "@tools/dexscreener/transport.js";
import { siteHttpGet } from "./http.js";
import { DexScreenerWsBridge } from "./ws-bridge.js";

export interface DexScreenerBridgeHandle {
  readonly transport: DexScreenerTransport;
  /** Idempotent teardown of every handle this bridge owns. */
  dispose(): void;
}

/**
 * Build the site transport.
 *
 * Nothing is created eagerly: the session is materialized on the first request
 * and the hidden window on the first WebSocket exchange, so an app that never
 * asks DexScreener anything pays nothing for this.
 */
export function createDexScreenerBridgeTransport(): DexScreenerBridgeHandle {
  const bridge = new DexScreenerWsBridge();
  let disposed = false;

  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url, options) =>
      siteHttpGet(bridge.sessionForRequests(), url, options),
    wsExchange: (url, options) => bridge.exchange(url, options),
  };

  return {
    transport,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      bridge.dispose();
    },
  };
}
