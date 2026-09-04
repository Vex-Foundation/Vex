import { net } from "electron";
import {
  BlockscoutErrorCodes,
  blockscoutError,
} from "@tools/blockscout/errors.js";
import type { BlockscoutTransport } from "@tools/blockscout/transport.js";
import {
  fetchBlockscoutAddressTokenBalances,
  type BlockscoutNetFetch,
} from "./http.js";

export interface BlockscoutBridgeHandle {
  readonly transport: BlockscoutTransport;
  /** Close admission, cancel active requests, and join the complete drain. */
  dispose(): Promise<void>;
}

function electronNetFetch(input: string, init: RequestInit): Promise<Response> {
  return net.fetch(input, init);
}

/** Build the main-owned Blockscout transport without opening any request. */
export function createBlockscoutBridgeTransport(
  fetcher: BlockscoutNetFetch = electronNetFetch,
): BlockscoutBridgeHandle {
  const lifecycleController = new AbortController();
  const active = new Set<Promise<unknown>>();
  let accepting = true;
  let pendingDisposal: Promise<void> | null = null;

  const transport: BlockscoutTransport = {
    name: "electron_net",
    async fetchAddressTokenBalances(address, options) {
      if (!accepting) {
        throw blockscoutError(
          BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE,
          "The Blockscout transport is not accepting new inventory reads",
          "Wait for the desktop runtime to finish restarting before reading again.",
        );
      }

      const request = fetchBlockscoutAddressTokenBalances(
        fetcher,
        address,
        options,
        lifecycleController.signal,
      );
      active.add(request);
      try {
        return await request;
      } finally {
        active.delete(request);
      }
    },
  };

  return {
    transport,
    dispose() {
      pendingDisposal ??= (async () => {
        accepting = false;
        lifecycleController.abort();
        await Promise.allSettled([...active]);
      })();
      return pendingDisposal;
    },
  };
}
