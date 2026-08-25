/**
 * HTTP half of the DexScreener site bridge: Chromium's network stack, driven
 * from the main process.
 *
 * Measured (evidence/report-electron-spike.md, Electron 42 / Chrome 148):
 * `net.fetch` with a Chrome UA plus `Origin` and `Referer` gets 200 from
 * io.dexscreener.com, where Node `fetch`/undici get 403. The header set below
 * is the one that was measured working; it is not decoration.
 *
 * This module owns no long-lived handle. Each call owns one AbortController and
 * one timer and releases both on every exit path.
 */

import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import type {
  HttpGetOptions,
  TransportResponse,
} from "@tools/dexscreener/transport.js";
import { checkHttpUrl, DEXSCREENER_ORIGIN } from "./allowlist.js";
import type { BridgeSession } from "./ws-bridge.js";

/**
 * The Chrome identity the site's edge accepts. Kept as one exported constant so
 * the hidden bridge window and these requests present the same client.
 */
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

/**
 * The measured header set for the API hosts. The SSR navigation header set
 * (Sec-Fetch-Dest/Mode/Site/User, Upgrade-Insecure-Requests) is deliberately
 * absent: the SSR route was deleted from this design, and these requests are
 * XHR-shaped, which is what the site's own client sends.
 */
function requestHeaders(accept: string | undefined): Record<string, string> {
  return {
    "User-Agent": CHROME_USER_AGENT,
    Accept: accept ?? "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: DEXSCREENER_ORIGIN,
    Referer: `${DEXSCREENER_ORIGIN}/`,
    "sec-ch-ua": '"Chromium";v="148", "Not(A:Brand";v="24", "Google Chrome";v="148"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

/**
 * GET one site URL through Chromium.
 *
 * `session` is the bridge's own partition, so these requests share the
 * bridge's cookie jar and nothing else in the app sees them.
 */
export async function siteHttpGet(
  sessionForRequests: BridgeSession,
  url: string,
  options: HttpGetOptions
): Promise<TransportResponse> {
  const decision = checkHttpUrl(url);
  if (!decision.allowed) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED,
      `The DexScreener bridge refused to fetch this URL: ${decision.reason}`,
      "Only the measured DexScreener API hosts and path prefixes are reachable through the bridge."
    );
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options.signal?.aborted === true) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    // `session.fetch` is `net.fetch` bound to THIS session, which is what keeps
    // the bridge's cookie jar and header hook off every other session.
    const response = await sessionForRequests.fetch(decision.url.toString(), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      credentials: "omit",
      headers: requestHeaders(options.accept),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
      throw siteError(
        DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP,
        `Response body from ${decision.url.host} is ${body.byteLength} bytes, over the caller's cap of ${options.maxBytes} bytes`,
        "Raise maxBytes or request a narrower window; the body was rejected whole, not truncated."
      );
    }
    const headers = new Map<string, string>();
    response.headers.forEach((value: string, key: string) =>
      headers.set(key.toLowerCase(), value)
    );
    return {
      url: response.url === "" ? decision.url.toString() : response.url,
      status: response.status,
      headers,
      body,
    };
  } catch (error) {
    if (isDexScreenerSiteError(error)) throw error;
    if (timedOut) {
      throw siteError(
        DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
        `The request to ${decision.url.host} did not complete within ${options.timeoutMs} ms`,
        "Retry with a longer timeoutMs, or narrow the request."
      );
    }
    if (options.signal?.aborted === true) {
      throw siteError(
        DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
        `The request to ${decision.url.host} was cancelled by the caller`,
        "Nothing was read; issue a new request if the result is still wanted."
      );
    }
    throw siteError(
      DexScreenerSiteErrorCodes.TRANSPORT_FAILED,
      `The request to ${decision.url.host} produced no response`,
      "The host was unreachable, refused the connection, or answered with a redirect the bridge does not follow. Nothing is known about the endpoint's answer."
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
