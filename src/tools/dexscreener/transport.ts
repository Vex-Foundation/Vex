/**
 * The DexScreener transport seam.
 *
 * WHY A SEAM EXISTS AT ALL (measured, not assumed): dexscreener.com sits behind
 * Cloudflare, which blocks on the TLS and HTTP/2 fingerprint. Node `fetch`,
 * `undici` and every Node WebSocket client get 403 on the site hosts;
 * Chromium's network stack passes with no challenge and no cookies. The site
 * surface is therefore only reachable from the Electron main process, and
 * `src/` must keep ZERO Electron imports. So `src/` owns the CONTRACT and the
 * registry; `vex-app/src/main/dexscreener-bridge/` owns the implementation and
 * registers it at startup.
 *
 * Two transports exist by design:
 *
 *  - the site bridge (`capabilities.site === true`), mounted by the desktop
 *    app: Chromium `net.fetch` for HTTP, a hidden sandboxed window for
 *    WebSockets;
 *  - the default transport in this file (`capabilities.site === false`), which
 *    serves `https://api.dexscreener.com` and the chain catalog on
 *    `https://dd.dexscreener.com`, and nothing else. It is what a headless caller
 *    (CLI, unit tests, CI) gets. It is a DEGRADED transport, not a broken one:
 *    tools that can answer from the public API do so and say which transport
 *    answered; tools that cannot return a typed refusal naming the remedy.
 *
 * Every failure here is typed (`site-errors.ts`). "Site transport unavailable"
 * must never read to the agent as a provider outage.
 */

import { VexError } from "../../errors.js";
import { DexScreenerSiteErrorCodes, siteError } from "./site-errors.js";

/** Origin the degraded default transport is allowed to reach. */
export const DEXSCREENER_PUBLIC_API_ORIGIN = "https://api.dexscreener.com";

/**
 * The catalog origin the degraded default transport may ALSO reach.
 *
 * `dd.dexscreener.com` is a site host by ownership but not by gating: measured
 * 2026-08-25 with Node's own `fetch` and no browser impersonation of any kind,
 * `https://dd.dexscreener.com/ds-data/v2/chains/by-trending` answered HTTP 200
 * with 63,237 bytes of JSON and `cf-cache-status: HIT`. There is no Cloudflare
 * fingerprint gate on it, which is the same measured property that puts
 * `api.dexscreener.com` on this list.
 *
 * It is on the list because the chain catalog is the VOCABULARY every other
 * tool's chain parameter is validated against. Refusing it headlessly did not
 * make anything safer; it made `chains_list` unavailable outside the desktop
 * app, and with it the remedy that every "unknown chain" refusal points at.
 *
 * NOT a general opening of the site hosts: `io.dexscreener.com` and every
 * WebSocket channel stay behind the bridge, because those ARE gated. Adding a
 * host here is a trust-surface change and needs its own live measurement.
 */
export const DEXSCREENER_CATALOG_ORIGIN = "https://dd.dexscreener.com";

/** Every origin the default transport may fetch, and nothing else. */
const DEFAULT_TRANSPORT_ORIGINS: readonly string[] = [
  DEXSCREENER_PUBLIC_API_ORIGIN,
  DEXSCREENER_CATALOG_ORIGIN,
];

/** What a transport can do. */
export interface DexScreenerTransportCapabilities {
  /** The site hosts (io.dexscreener.com, dd.dexscreener.com, WebSockets). */
  readonly site: boolean;
  /**
   * The public REST API (api.dexscreener.com). The default transport serves
   * it; the Electron site bridge does NOT - its allowlist admits only the
   * gated site hosts and refuses the public API by name, so a transport may
   * truthfully say `false` here.
   */
  readonly publicApi: boolean;
}

/** One HTTP response, whole. Nothing here is trimmed or summarized. */
export interface TransportResponse {
  /** Final URL the response came from (after any redirect the transport followed). */
  readonly url: string;
  readonly status: number;
  /**
   * Response headers with LOWERCASED names. The site lies about
   * `content-type` (it says `application/json` for protobuf and Avro bodies),
   * so callers dispatch decoding by endpoint and use these for cache and
   * rate-limit facts only.
   */
  readonly headers: ReadonlyMap<string, string>;
  /** The complete body. */
  readonly body: Uint8Array;
}

export interface HttpGetOptions {
  /** Hard deadline for the whole request, in milliseconds. Required: the caller owns the budget. */
  readonly timeoutMs: number;
  /** Caller's cancellation signal. Cancellation is propagated, not simulated. */
  readonly signal?: AbortSignal;
  /** Value for the `Accept` request header, when the endpoint needs a specific one. */
  readonly accept?: string;
  /**
   * Maximum body size the caller will accept, in bytes. A larger body is a
   * typed `RESPONSE_OVER_CAP` rejection naming the cap - never a silent cut.
   * Omitted means the caller accepts whatever the endpoint returns.
   */
  readonly maxBytes?: number;
}

/*
 * DECLARED OMISSION: CONDITIONAL GETS.
 *
 * `HttpGetOptions` carries no validator field, so no caller can send
 * `If-None-Match` or `If-Modified-Since` and no endpoint on this surface ever
 * receives a 304. That is a real capability of the provider going unused: the
 * chain catalog answers with a strong `ETag` and would revalidate for free.
 *
 * It is left out rather than forgotten, for two measured reasons. First, the
 * one endpoint whose 304 would matter most does not honour it: the spotlight
 * document's ETag rotates at constant length between reads and an
 * `If-None-Match` probe came back 200 with a fresh body, so revalidating it
 * saves nothing. Second, adding a validator means adding a cache that OWNS the
 * stored ETag and its invalidation, and this surface's caching owner is
 * `./throttle.ts`, which caches by value and time. Sending a validator without
 * that ownership would let a 304 arrive at a caller holding no body.
 *
 * The consequence a reader must know: every endpoint here pays full bytes on
 * every read, and `sourceObservation.cacheState` reports the EDGE's cache, not
 * ours. Several callers also treat any `status !== 200` as a wire change, so a
 * 304 would be misclassified today; it cannot arrive while no validator is
 * sent, which is what makes this a declared omission rather than a latent bug.
 */

export interface WsExchangeOptions {
  /**
   * Frames to send once the socket is open, in order. Strings are sent as TEXT
   * frames, byte arrays as BINARY frames.
   */
  readonly send?: readonly (string | Uint8Array)[];
  /** What the caller is waiting for. The exchange resolves as soon as it is satisfied. */
  readonly expect: WsExpectation;
  /** Hard deadline for open + send + collect, in milliseconds. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * Coalescence scope: an opaque owner label that partitions the transport's
   * single-flight table.
   *
   * WHY IT EXISTS, and it is a lifecycle fact rather than a preference. The
   * site bridge single-flights identical exchanges (same URL, same frames, same
   * expectations) onto the FIRST caller's promise, so the first caller's signal
   * and deadline are the ones that control the socket. That is correct for the
   * case it was built for (the same snapshot asked for twice by the same kind
   * of caller) and wrong for a long-lived poller: a board's live loop that
   * joined an agent tool's exchange could neither abort it on toggle-off nor
   * impose its own deadline, and an agent tool that joined the board's could be
   * killed by a toggle it knows nothing about.
   *
   * Two callers coalesce only when their scopes are EQUAL. Absent means the
   * shared, unscoped pool: leaving it out is byte-for-byte the behaviour that
   * existed before this option, which is what makes it additive.
   *
   * The degraded public-API transport ignores it: it opens no sockets and
   * single-flights nothing, so there is nothing to partition.
   */
  readonly coalesceScope?: string;
}

export interface WsExpectation {
  /**
   * Number of BINARY frames to collect before resolving.
   *
   * Measured: the first binary frame on the screener channel is `latestBlock`
   * in 72 of 74 sessions, so a caller wanting one payload frame asks for more
   * than one and dispatches on the protobuf oneof itself. This transport does
   * not interpret frame contents.
   *
   * CONTRACT, binding on every implementation: a zero-length binary frame is a
   * keepalive, not a frame. It does NOT count toward this number and does not
   * appear in the returned array. Measured on `feed/ws`: the site sends real
   * BINARY frames of `byteLength === 0` about every 17-47 s, and counting them
   * made a 0.4 s answer look like three frames of progress, so callers asking
   * for 4 frames with a 25 s deadline could never be satisfied and threw
   * `TRANSPORT_TIMEOUT` with the answer already in hand.
   */
  readonly binaryFrames: number;
  /**
   * Total byte ceiling across collected frames. Exceeding it is a typed
   * `RESPONSE_OVER_CAP` rejection naming the cap, never a partial result
   * presented as complete.
   */
  readonly maxTotalBytes: number;
}

/**
 * The contract every transport implements.
 *
 * Implementations own their own handles: every socket, window, timer and
 * listener they create is theirs to close, and both methods must reject rather
 * than hang when the deadline or the caller's signal fires.
 *
 * FAILURE VOCABULARY of `wsExchange`, and why the distinctions are load-bearing:
 * `TRANSPORT_CANCELLED` and `TRANSPORT_TIMEOUT` belong to the caller's own
 * budget; `TRANSPORT_FAILED` says the socket died and says nothing about the
 * request; `WS_UPGRADE_REFUSED` says the provider rejected the request's
 * GRAMMAR at the handshake (HTTP 422, empty body) and is permanent, so a caller
 * must change the request rather than retry it. An implementation that cannot
 * observe the handshake status reports `TRANSPORT_FAILED` and never guesses the
 * refusal; one that can (the site bridge watches its own session) must raise
 * the refusal, because the two carry opposite remedies.
 */
export interface DexScreenerTransport {
  readonly capabilities: DexScreenerTransportCapabilities;
  /** A name for logs and the `sourceObservation.transport` field. */
  readonly name: "site_bridge" | "public_api";
  httpGet(url: string, options: HttpGetOptions): Promise<TransportResponse>;
  wsExchange(url: string, options: WsExchangeOptions): Promise<Uint8Array[]>;
}

/* ------------------------------------------------------------------ */
/* Registry: single owner, explicit lifetime                           */
/* ------------------------------------------------------------------ */

let registered: DexScreenerTransport | null = null;

/**
 * Claim the single transport slot.
 *
 * Single-owner by contract: a second registration while one is live throws,
 * because two transports would mean two answers to "which transport served
 * this row" and a silent quality downgrade is exactly the failure this seam
 * prevents. Returns an idempotent unregister so the owner (the app's startup
 * path, or a test) can release the slot; calling it after another transport
 * has claimed the slot does nothing.
 */
export function registerDexScreenerTransport(
  transport: DexScreenerTransport
): () => void {
  if (registered !== null) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_ALREADY_REGISTERED,
      `A DexScreener transport (${registered.name}) is already registered; ${transport.name} cannot replace it`,
      "Unregister the current transport before registering another one."
    );
  }
  registered = transport;
  const claimed = transport;
  return () => {
    if (registered === claimed) registered = null;
  };
}

/**
 * The transport in force. Falls back to the degraded public-API transport when
 * no site bridge has been mounted, so headless callers get a working, honestly
 * labelled transport instead of a crash.
 */
export function getDexScreenerTransport(): DexScreenerTransport {
  return registered ?? defaultPublicApiTransport;
}

/* ------------------------------------------------------------------ */
/* Default transport: public API only                                  */
/* ------------------------------------------------------------------ */

/**
 * The degraded transport. It reaches `api.dexscreener.com` with Node's own
 * `fetch` (that host has no Cloudflare fingerprint gate: measured) and refuses
 * everything else by name.
 */
export const defaultPublicApiTransport: DexScreenerTransport = {
  name: "public_api",
  capabilities: { site: false, publicApi: true },

  async httpGet(url, options): Promise<TransportResponse> {
    assertPublicApiUrl(url);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted === true) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(TIMEOUT_REASON), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: options.accept === undefined ? {} : { accept: options.accept },
      });
      const buffer = await response.arrayBuffer();
      const body = new Uint8Array(buffer);
      if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
        throw siteError(
          DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP,
          `Response body is ${body.byteLength} bytes, over the caller's cap of ${options.maxBytes} bytes`,
          "Raise maxBytes or request a narrower window; the body was not truncated, it was rejected."
        );
      }
      const headers = new Map<string, string>();
      response.headers.forEach((value, key) => headers.set(key.toLowerCase(), value));
      return { url: response.url === "" ? url : response.url, status: response.status, headers, body };
    } catch (error) {
      throw asTransportFailure(error, url, options.signal, options.timeoutMs);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  },

  async wsExchange(url): Promise<Uint8Array[]> {
    throw siteError(
      DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
      `The DexScreener site transport is not mounted in this process, so the WebSocket channel at ${hostOf(url)} cannot be opened`,
      "Run inside the Vex desktop app, which mounts the site bridge. Headless contexts reach the public API and the chain catalog over plain HTTP, and no WebSocket channel at all."
    );
  },
};

const TIMEOUT_REASON = "dexscreener-transport-timeout";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an invalid URL";
  }
}

function assertPublicApiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED,
      "The requested URL is not a valid absolute URL",
      "Pass an absolute https URL."
    );
  }
  if (!DEFAULT_TRANSPORT_ORIGINS.includes(parsed.origin)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
      `The DexScreener site transport is not mounted in this process; the default transport serves ${DEFAULT_TRANSPORT_ORIGINS.join(" and ")} only and cannot reach ${parsed.origin}`,
      "Run inside the Vex desktop app, which mounts the site bridge, or use a tool that can answer from the public API or the chain catalog."
    );
  }
}

/** Turn a fetch rejection into the right typed outcome: cancelled, timed out, or failed. */
function asTransportFailure(
  error: unknown,
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): unknown {
  if (error instanceof VexError) return error;
  if (signal?.aborted === true) {
    return siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
      `The request to ${hostOf(url)} was cancelled by the caller`,
      "Nothing was read; issue a new request if the result is still wanted."
    );
  }
  const abortedByTimeout =
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
  if (abortedByTimeout) {
    return siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
      `The request to ${hostOf(url)} did not complete within ${timeoutMs} ms`,
      "Retry with a longer timeoutMs, or narrow the request."
    );
  }
  return siteError(
    DexScreenerSiteErrorCodes.TRANSPORT_FAILED,
    `The request to ${hostOf(url)} produced no response`,
    "The host was unreachable or the connection dropped. This is a transport failure, not a provider refusal: nothing is known about the endpoint's answer."
  );
}
