import { BlockscoutErrorCodes, blockscoutError } from "./errors.js";

export interface BlockscoutFetchOptions {
  /** Hard deadline for the complete request and body read. */
  readonly timeoutMs: number;
  /** Caller-owned cancellation, propagated through the Electron request. */
  readonly signal?: AbortSignal;
  /** Maximum response bytes accepted. An excess rejects the whole response. */
  readonly maxBytes: number;
}

export interface BlockscoutTransportResponse {
  /** Final URL reported by Chromium, checked again by the provider client. */
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  /** Complete body bytes. A transport never returns a truncated prefix. */
  readonly body: Uint8Array;
}

/**
 * Operation-specific transport for one Robinhood Blockscout endpoint.
 *
 * Deliberately not an HTTP client: accepting a URL here would turn Chromium's
 * Cloudflare-compatible network stack into a generic privileged fetch proxy.
 */
export interface BlockscoutTransport {
  readonly name: "electron_net";
  fetchAddressTokenBalances(
    address: string,
    options: BlockscoutFetchOptions,
  ): Promise<BlockscoutTransportResponse>;
}

let registeredTransport: BlockscoutTransport | null = null;

/** Claim the process-wide transport slot and return an idempotent release. */
export function registerBlockscoutTransport(
  transport: BlockscoutTransport,
): () => void {
  if (registeredTransport !== null) {
    throw blockscoutError(
      BlockscoutErrorCodes.TRANSPORT_ALREADY_REGISTERED,
      "A Blockscout transport is already registered in this process",
      "Unregister the current transport before mounting another one.",
    );
  }
  registeredTransport = transport;
  const claimed = transport;
  return () => {
    if (registeredTransport === claimed) registeredTransport = null;
  };
}

/** Return the mounted Electron transport or a typed unavailable outcome. */
export function getBlockscoutTransport(): BlockscoutTransport {
  if (registeredTransport === null) {
    throw blockscoutError(
      BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE,
      "The Blockscout Electron transport is not mounted in this process",
      "Run this read inside the Vex desktop app.",
      { retryable: false },
    );
  }
  return registeredTransport;
}
