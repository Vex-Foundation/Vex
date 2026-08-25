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

/** Hosts the bridge may fetch over HTTPS, each with its allowed path prefixes. */
const HTTP_ALLOW: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "io.dexscreener.com",
    ["/dex/", "/metas/", "/feed/", "/hype/"],
  ],
  ["dd.dexscreener.com", ["/ds-data/"]],
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

/** Is this HTTPS URL one the bridge may fetch? */
export function checkHttpUrl(rawUrl: string): AllowDecision {
  return decide(rawUrl, "https:", HTTP_ALLOW);
}

/** Is this WebSocket URL one the bridge may open? */
export function checkWsUrl(rawUrl: string): AllowDecision {
  return decide(rawUrl, "wss:", WS_ALLOW);
}
