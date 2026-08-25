/**
 * `price-read` - the current pair snapshot(s) a NON-AGENT consumer reads.
 *
 * ## Who this is for, and who it is NOT for
 *
 * Four callers inside this process need a price or a pool list without being a
 * tool the model called: the wake price-watch poller, the `token_price` watch
 * evaluator, the `$VEX` own-token prompt banner, the Uniswap quote-safety
 * liquidity check and the local-chain balance valuation. None of them wants a
 * model-facing envelope, a `sourceObservation` block or a screener projection;
 * all of them want typed rows and a typed failure. That is one responsibility,
 * so it has one owner, and this is it.
 *
 * The agent-facing DexScreener tools do NOT go through here. They own richer
 * projections and their own provenance reporting over the site channels.
 *
 * ## Why these three reads, on the PUBLIC REST endpoints, and not the batch
 * ## channel
 *
 * MEASURED 2026-08-25 against the live provider (archived under
 * `scratchpad/execution/s11a/probe1-endpoint-equivalence.json`), because the
 * obvious consolidation is wrong in a way that would silently move money:
 *
 *   - `/token-pairs/v1/{chain}/{token}` answered 30 pools per token on `base`
 *     for all three probed tokens;
 *   - `/tokens/v1/{chain}/{a,b,c}` answered THREE rows in total for the same
 *     three tokens: 2, 2 and 1 pool respectively, and one of the pools it
 *     returned for WETH (`0x4e829f8a...`) was not among the 30 that
 *     `/token-pairs/v1` returned at the same moment.
 *
 * So `/tokens/v1` is a representative-pool lookup, NOT a batched pool list.
 * `selectTokenWatchPrice` picks the deepest sane non-outlier pool out of the
 * FULL list; feeding it a representative pool instead would hand a price watch
 * a pool the provider chose rather than the pool the rule chose. The same
 * objection applies to the v8 `pairs-search` batch channel, which
 * `endpoints/pairs-batch.ts` records as resolving a token address to one
 * PROVIDER-CANONICAL pair that is measurably not the deepest, and which needs
 * the site bridge that a headless caller does not have.
 *
 * The three reads therefore stay exactly the three the old REST client made,
 * with the same paths, the same validators and the same rate class. What
 * changed is the TRANSPORT: bytes now come from the registered transport
 * (`transport.ts`), which is the site bridge inside the desktop app and the
 * degraded public-API transport everywhere else. Both serve
 * `api.dexscreener.com`, so this seam works headless, which is a hard
 * requirement: the poller runs in the agent process with or without a bridge.
 *
 * ## What is shared with every other caller of this host
 *
 * One module-level `DexScreenerThrottle` owns the rate budget, the 30 s URL
 * cache and the in-flight dedupe for this seam. The cache is what makes the
 * poller affordable: it ticks every 3 s against a 30 s TTL, so roughly nine of
 * ten ticks never touch the network. Two callers asking for the same URL in the
 * same moment share one request, which is why caller deadlines bound the WAIT
 * and never the request - see `caller-bounds.ts`.
 *
 * ## Declared omissions, so neither is a silent gap
 *
 *  - NO PER-VALUE OBSERVATION. The old client kept a `WeakMap` of cache-hit,
 *    cache-age and upstream-`Age` facts per returned value, reachable through
 *    `observationFor`. Measured at migration time, no production caller of this
 *    surface ever read it, and a `WeakMap` keyed on a value the throttle hands
 *    to several callers at once cannot answer "how stale is MY copy" honestly
 *    anyway. A consumer that needs provenance should get it returned beside the
 *    value, not looked up afterwards.
 *  - NO `search` READ. The three reads here are the three these consumers make.
 *    Search is an agent-facing question and belongs to the tool surface.
 */

import { getDexScreenerTransport, DEXSCREENER_PUBLIC_API_ORIGIN } from "./transport.js";
import {
  awaitWithinCallerBounds,
  boundsTheWait,
  type DexScreenerRequestOptions,
} from "./caller-bounds.js";
import { mapDexScreenerError, mapTransportError } from "./errors.js";
import {
  DexScreenerThrottle,
  cacheTtlForClass,
  classifyRateClass,
  parseRetryAfterMs,
} from "./throttle.js";
import type { PairsResponse, TokensPairsResponse, TokensResponse } from "./types.js";
import {
  validatePairsResponse,
  validateTokensPairsResponse,
  validateTokensResponse,
} from "./validation/pairs.js";

export type { DexScreenerRequestOptions } from "./caller-bounds.js";

/**
 * Deadline for the SHARED request, matching `fetchWithTimeout`'s own default so
 * the migration did not quietly shorten or lengthen anyone's patience. Caller
 * options bound the caller's wait on top of it, never this.
 */
export const PRICE_READ_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Byte ceiling for one response, matching the batch channel's ceiling.
 *
 * A bound, not a cut: the transport REJECTS a larger body by name
 * (`RESPONSE_OVER_CAP`) rather than returning part of it. The largest response
 * measured on these three endpoints was 43,088 bytes, so this cannot fire on
 * today's provider; it exists so a provider that starts streaming something
 * unbounded fails loudly instead of being parsed.
 */
export const PRICE_READ_MAX_BYTES = 4_000_000;

/** Per-process budget, cache and dedupe for this seam. */
let throttle = new DexScreenerThrottle();

/**
 * Drop the cached responses and the rate budget.
 *
 * Test-only, and named so: a suite that serves different bytes for the same URL
 * across two cases would otherwise read the first case's answer out of a 30 s
 * cache. Production has exactly one owner of this state and never resets it.
 */
export function resetPriceReadCacheForTests(): void {
  throttle = new DexScreenerThrottle();
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function buildUrl(path: string): string {
  return new URL(path, `${DEXSCREENER_PUBLIC_API_ORIGIN}/`).toString();
}

/**
 * Read the body as JSON, or as `undefined` when it is not JSON at all.
 *
 * Mirrors `readJson`'s contract on purpose: a non-2xx body reaches
 * `mapDexScreenerError` in WHATEVER shape it arrived, because the provider's
 * live 400 is an HTML page and discarding it leaves the caller a bare status.
 */
function readJsonBody(body: Uint8Array): unknown {
  if (body.byteLength === 0) return undefined;
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    return undefined;
  }
}

async function request<T>(
  path: string,
  validate: (raw: unknown) => T,
  options?: DexScreenerRequestOptions,
): Promise<T> {
  const url = buildUrl(path);
  const rateClass = classifyRateClass(path);
  const ttlMs = cacheTtlForClass(rateClass);
  try {
    // The shared request carries NO caller policy - see `caller-bounds.ts`.
    const shared = throttle.run(url, rateClass, ttlMs, async () => {
      const response = await getDexScreenerTransport().httpGet(url, {
        timeoutMs: PRICE_READ_REQUEST_TIMEOUT_MS,
        accept: "application/json",
        maxBytes: PRICE_READ_MAX_BYTES,
      });
      if (response.status !== 200) {
        if (response.status === 429) {
          throttle.penalize(rateClass, parseRetryAfterMs(response.headers.get("retry-after")));
        }
        throw mapDexScreenerError(response.status, readJsonBody(response.body));
      }
      return validate(readJsonBody(response.body));
    });
    return await (boundsTheWait(options) ? awaitWithinCallerBounds(shared, options) : shared);
  } catch (err) {
    mapTransportError(err);
  }
}

/**
 * EVERY pool the provider indexes for one token on one chain.
 *
 * This is the input `selectTokenWatchPrice` needs: its rule is "deepest sane
 * non-outlier of the full list", and a shorter list is a different rule. The
 * result is unbounded only in the provider's own terms - it answers a bounded
 * window (30 pools on every token measured) and says so by returning fewer rows,
 * never by signalling a cut.
 */
export function readTokenPools(
  chainSlug: string,
  tokenAddress: string,
  options?: DexScreenerRequestOptions,
): Promise<TokensPairsResponse> {
  return request(
    `/token-pairs/v1/${encodeURIComponent(chainSlug)}/${encodeURIComponent(tokenAddress)}`,
    validateTokensPairsResponse,
    options,
  );
}

/** One pool by its own address. `pairs` is empty when the provider has no such pool. */
export function readPair(
  chainSlug: string,
  pairAddress: string,
  options?: DexScreenerRequestOptions,
): Promise<PairsResponse> {
  return request(
    `/latest/dex/pairs/${encodeURIComponent(chainSlug)}/${encodeURIComponent(pairAddress)}`,
    validatePairsResponse,
    options,
  );
}

/**
 * The provider's REPRESENTATIVE pools for up to 30 token addresses at once.
 *
 * NOT a pool list: measured, this answers roughly one pool per address and can
 * name a pool absent from that token's own `/token-pairs/v1` window. It is the
 * right read for "is there meaningful liquidity behind this token" and for
 * valuing a wallet's rows, and the WRONG read for choosing the pool a price
 * watch will act on.
 *
 * `tokenAddresses` is the provider's comma-separated form; the caller owns the
 * batching because the caller owns which addresses belong in one budget.
 */
export function readTokensPairs(
  chainSlug: string,
  tokenAddresses: string,
  options?: DexScreenerRequestOptions,
): Promise<TokensResponse> {
  return request(
    `/tokens/v1/${encodeURIComponent(chainSlug)}/${encodeURIComponent(tokenAddresses)}`,
    validateTokensResponse,
    options,
  );
}
