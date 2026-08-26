/**
 * What the DexScreener bridge is allowed to reach.
 *
 * The bridge holds a privileged capability: a Chromium network stack that
 * Cloudflare accepts, plus an injected `Origin: https://dexscreener.com` on one
 * session. That capability must never be pointable at an arbitrary URL by
 * anything upstream (a tool argument, a model-proposed cursor, a provider
 * redirect), so host AND path are checked here, on the exact URL that is about
 * to be opened.
 *
 * This module is pure so it can be tested without an Electron runtime. It
 * decides; `http.ts` and `ws-bridge.ts` execute.
 */

/**
 * The image CDN host, and the only path prefix on it the bridge may fetch.
 *
 * Measured 2026-08-25: `https://cdn.dexscreener.com/cms/images/{iconId}` with
 * `width`/`height`/`fit`/`quality`/`format` answers 200 `image/png` (2,684
 * bytes for the probed icon) and honours the size parameters, and an unknown
 * id answers a clean 404. It is a CDN for issuer-uploaded artwork, NOT an API
 * host: it is not behind the Cloudflare fingerprint gate that the site hosts
 * are, and it wants no site Origin (see {@link sendsSiteOrigin}).
 *
 * The prefix is `/cms/images/` and nothing wider. Board token icons are the
 * only reason this host is reachable at all, and the icon service composes the
 * URL itself from a pattern-checked opaque id, so no caller upstream can point
 * this capability at another path.
 */
export const DEXSCREENER_CDN_HOST = "cdn.dexscreener.com";

/** Hosts the bridge may fetch over HTTPS, each with its allowed path prefixes. */
const HTTP_ALLOW: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "io.dexscreener.com",
    ["/dex/", "/metas/", "/feed/", "/hype/"],
  ],
  ["dd.dexscreener.com", ["/ds-data/"]],
  [DEXSCREENER_CDN_HOST, ["/cms/images/"]],
]);

/** WebSocket channels the bridge may open. */
const WS_ALLOW: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "io.dexscreener.com",
    [
      "/dex/screener/v7/pairs/",
      "/dex/screener/v7/pair/",
      "/dex/screener/v2/tokens/",
      "/dex/screener/v8/pairs-search",
      "/feed/ws",
    ],
  ],
]);

/** The only host whose requests get the injected `Origin` header. */
export const ORIGIN_INJECTION_HOST = "io.dexscreener.com";

/** The Origin the site's WebSocket upgrade requires (403 without it). */
export const DEXSCREENER_ORIGIN = "https://dexscreener.com";

/**
 * `webRequest` filter patterns for the Origin injection. Scoped to one host on
 * one session; nothing else in the app shares that session.
 */
export const ORIGIN_INJECTION_URL_PATTERNS: readonly string[] = [
  `https://${ORIGIN_INJECTION_HOST}/*`,
  `wss://${ORIGIN_INJECTION_HOST}/*`,
];

export type AllowDecision =
  | { readonly allowed: true; readonly url: URL }
  | { readonly allowed: false; readonly reason: string };

function decide(
  rawUrl: string,
  expectedProtocol: "https:" | "wss:",
  table: ReadonlyMap<string, readonly string[]>
): AllowDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "the URL is not a valid absolute URL" };
  }
  if (url.protocol !== expectedProtocol) {
    return {
      allowed: false,
      reason: `scheme "${url.protocol}" is not ${expectedProtocol}`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, reason: "the URL carries embedded credentials" };
  }
  const prefixes = table.get(url.host);
  if (prefixes === undefined) {
    return { allowed: false, reason: `host "${url.host}" is not on the bridge allowlist` };
  }
  if (!prefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return {
      allowed: false,
      reason: `path "${url.pathname}" on ${url.host} is not on the bridge allowlist (allowed prefixes: ${prefixes.join(", ")})`,
    };
  }
  return { allowed: true, url };
}

/**
 * Does a request to this host carry the site's `Origin` and `Referer`?
 *
 * The API hosts do: the measured 200 from `io.dexscreener.com` depends on
 * presenting as the site's own XHR client, which is what the header set in
 * `http.ts` exists for.
 *
 * The image CDN does NOT, and that is a privacy decision as much as a protocol
 * one. Nothing about serving a static icon needs to know which page asked, so
 * sending `Origin: https://dexscreener.com` on an icon fetch would hand the CDN
 * a correlation signal for no functional gain. The CDN answers these requests
 * without it (measured); the header is therefore not "harmless default", it is
 * data we decline to send.
 *
 * Pure and exported so the header decision is provable in a unit test against
 * a captured request rather than asserted in prose.
 */
export function sendsSiteOrigin(host: string): boolean {
  return host !== DEXSCREENER_CDN_HOST;
}

/** Is this HTTPS URL one the bridge may fetch? */
export function checkHttpUrl(rawUrl: string): AllowDecision {
  return decide(rawUrl, "https:", HTTP_ALLOW);
}

/** Is this WebSocket URL one the bridge may open? */
export function checkWsUrl(rawUrl: string): AllowDecision {
  return decide(rawUrl, "wss:", WS_ALLOW);
}
