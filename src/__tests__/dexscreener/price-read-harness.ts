/**
 * A byte-level DexScreener double that serves the SAME routes to both the old
 * REST client and the new `price-read` seam.
 *
 * ## Why it drives two layers at once (S11a)
 *
 * The migration in S11a swaps five consumers from `client.ts` onto
 * `price-read.ts`. A characterization test is only evidence if the SAME
 * assertions run before and after that swap: a test rewritten alongside the
 * code it guards proves nothing about what changed. The two layers take their
 * bytes from different places - the client from `fetchWithTimeout`, the seam
 * from the registered transport - so this harness answers both from one route
 * table, and every characterization test asserts on the request PATH and the
 * value the consumer produced, neither of which is supposed to move.
 *
 * The old REST client was deleted at measured zero consumers (S11 assembly);
 * only the transport half of this harness remains.
 */

import { registerDexScreenerTransport } from "@tools/dexscreener/transport.js";
import type { DexScreenerTransport } from "@tools/dexscreener/transport.js";

export interface ServedRoute {
  readonly status?: number;
  /** A JSON value, or a raw string for a body that is not JSON at all. */
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const routes = new Map<string, ServedRoute>();
const requested: string[] = [];

/** The route key: the decoded path, so a test writes it the way a human reads it. */
function keyOf(url: string): string {
  const { pathname, search } = new URL(url);
  return decodeURIComponent(pathname) + search;
}

/** Replace the route table and forget every recorded request. */
export function serveDexScreener(table: Readonly<Record<string, ServedRoute>>): void {
  routes.clear();
  requested.length = 0;
  for (const [path, route] of Object.entries(table)) routes.set(path, route);
}

/** Decoded paths, in the order they were requested, across BOTH layers. */
export function requestedPaths(): readonly string[] {
  return [...requested];
}

function resolveRoute(url: string): ServedRoute {
  const key = keyOf(url);
  requested.push(key);
  const route = routes.get(key);
  if (route === undefined) {
    throw new Error(`price-read-harness: no route served for ${key}`);
  }
  return route;
}

function bodyBytes(route: ServedRoute): Uint8Array {
  const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------------ */
/* Layer 1: the registered transport (what `price-read.ts` reads)      */
/* ------------------------------------------------------------------ */

/** Register the fake transport. Returns the unregister the test must call. */
export function installFakeTransport(): () => void {
  const transport: DexScreenerTransport = {
    name: "public_api",
    capabilities: { site: false, publicApi: true },
    async httpGet(url) {
      const route = resolveRoute(url);
      const headers = new Map<string, string>();
      for (const [name, value] of Object.entries(route.headers ?? {})) {
        headers.set(name.toLowerCase(), value);
      }
      return { url, status: route.status ?? 200, headers, body: bodyBytes(route) };
    },
    async wsExchange() {
      throw new Error("price-read-harness: no consumer under test opens a WebSocket");
    },
  };
  return registerDexScreenerTransport(transport);
}

/* ------------------------------------------------------------------ */
/* Layer 2: `@utils/http` (what `client.ts` reads)                      */
/* ------------------------------------------------------------------ */

interface FakeHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly servedBody: unknown;
}

