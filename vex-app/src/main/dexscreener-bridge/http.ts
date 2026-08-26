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
import { checkHttpUrl, DEXSCREENER_ORIGIN, sendsSiteOrigin } from "./allowlist.js";
import type { BridgeSession } from "./ws-bridge.js";

/**
 * The Chrome identity the site's edge accepts. Kept as one exported constant so
 * the hidden bridge window and these requests present the same client.
 */
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

/**
 * The header set for one request, CONDITIONED ON THE HOST.
 *
 * The API hosts get the measured set that gets a 200 out of the site's edge.
 * The SSR navigation headers (Sec-Fetch-Dest/Mode/Site/User,
 * Upgrade-Insecure-Requests) are deliberately absent: the SSR route was deleted
 * from this design, and these requests are XHR-shaped, which is what the site's
 * own client sends.
 *
 * The image CDN gets the same client identity and NO `Origin`/`Referer`
 * ({@link sendsSiteOrigin} carries the reason). This used to be unconditional,
 * which meant every host the allowlist ever gained would inherit a site origin
 * it had no need for. The decision is a pure function of the host so a test can
 * capture the real request for both hosts and assert the difference.
 *
 * Exported for that test. It is not a general-purpose helper: `siteHttpGet`
 * below is the only production caller.
 */
export function requestHeaders(
  accept: string | undefined,
  host: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": CHROME_USER_AGENT,
    Accept: accept ?? "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="148", "Not(A:Brand";v="24", "Google Chrome";v="148"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
  if (sendsSiteOrigin(host)) {
    headers["Origin"] = DEXSCREENER_ORIGIN;
    headers["Referer"] = `${DEXSCREENER_ORIGIN}/`;
  }
  return headers;
}

/**
 * Read a response body while COUNTING BYTES, and stop the transfer the moment
 * the caller's cap is passed.
 *
 * Why streaming rather than `arrayBuffer()` then a length check: the buffered
 * form pulls the WHOLE body into memory before it is allowed to have an
 * opinion about its size, so a host that answered with a gigabyte would be
 * fully downloaded and only then rejected. The cap is meant to bound what this
 * process reads, and a bound applied after the read is not a bound. The reader
 * is cancelled as soon as the running total passes the cap, so nothing beyond
 * roughly one chunk past the limit is ever pulled.
 *
 * This is a REJECTION, never a truncation: the over-cap body is refused whole,
 * with its measured size named, and no caller ever receives a short body that
 * looks complete. A response with no body at all reads as zero bytes.
 *
 * `maxBytes` undefined means the caller accepts whatever the endpoint returns,
 * which is the contract `HttpGetOptions` already declares.
 */
async function readBoundedBody(
  response: { readonly body: ReadableStream<Uint8Array> | null; arrayBuffer: () => Promise<ArrayBuffer> },
  maxBytes: number | undefined,
  host: string,
): Promise<Uint8Array> {
  if (maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
  const stream = response.body;
  if (stream === null) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw siteError(
          DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP,
          `Response body from ${host} passed the caller's cap of ${maxBytes} bytes after ${total} bytes and the transfer was stopped`,
          "Raise maxBytes or request a narrower window; the body was rejected whole, not truncated.",
        );
      }
      chunks.push(value);
    }
  } finally {
    // Idempotent and safe after a completed read; on the over-cap path this is
    // what actually stops the transfer rather than letting it drain.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
      headers: requestHeaders(options.accept, decision.url.host),
    });
    const body = await readBoundedBody(response, options.maxBytes, decision.url.host);
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
