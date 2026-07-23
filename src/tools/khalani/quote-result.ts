/**
 * Khalani quote outcome — first-class typed no-route (Phase 2 W1, binding R10).
 *
 * The `POST /v1/quotes` endpoint signals "no route for this pair" by returning
 * an EMPTY `routes[]`, NOT by throwing. Nothing consumed that today. This module
 * turns it into a FAILURE-shaped result that can never be mistaken for a
 * quotable route, so it cannot seed a successful prequote (R10):
 *
 *   - plain mode: an empty `routes[]` on the parsed `QuoteResponse` → `no_route`.
 *   - stream mode: routes are decided ONLY after a clean NDJSON close. The
 *     underlying generator (`KhalaniClient.streamQuotes`) yields only
 *     successfully parsed routes and THROWS on a bad line / transport failure;
 *     individual filler failures are dropped silently upstream. So a thrown
 *     error PROPAGATES (it is a transport/parse failure, never a no-route), and
 *     only a clean close with zero routes is a `no_route`.
 *
 * The `no_route` variant carries no route data; a caller that pattern-matches on
 * `outcome === "routes"` to build a prequote structurally cannot build one for a
 * no-route. Feed a `no_route` into `classifyKhalaniFailure({ kind: "empty_routes" })`
 * to get the reveal decision.
 */

import type { QuoteResponse, QuoteRoute, QuoteStreamRoute } from "./types.js";

export type KhalaniQuoteOutcome =
  | { readonly outcome: "routes"; readonly quoteId: string; readonly routes: QuoteRoute[] }
  | { readonly outcome: "no_route"; readonly quoteId: string | null };

/**
 * Classify a plain (non-stream) `QuoteResponse`. Empty `routes[]` → `no_route`.
 */
export function classifyKhalaniQuoteResponse(response: QuoteResponse): KhalaniQuoteOutcome {
  if (response.routes.length === 0) {
    return { outcome: "no_route", quoteId: response.quoteId };
  }
  return { outcome: "routes", quoteId: response.quoteId, routes: response.routes };
}

/**
 * Drain a Khalani NDJSON quote stream to its clean close, then decide. A thrown
 * value from the stream (bad line / transport failure) PROPAGATES — it is never
 * silently treated as a no-route. Zero routes after a clean close → `no_route`.
 */
export async function collectKhalaniQuoteStream(
  stream: AsyncIterable<QuoteStreamRoute>,
): Promise<KhalaniQuoteOutcome> {
  const routes: QuoteRoute[] = [];
  let quoteId: string | null = null;
  for await (const route of stream) {
    // Every validated stream route carries a non-empty quoteId; capture the
    // first one as the batch quoteId.
    if (quoteId === null) {
      quoteId = route.quoteId;
    }
    // QuoteStreamRoute is a QuoteRoute with an extra `quoteId`; structurally
    // assignable, so it is stored as-is.
    routes.push(route);
  }

  // Reached ONLY on a clean close. The `quoteId === null` arm is unreachable
  // when routes is non-empty (the first route always set it) but keeps the
  // union honest without a non-null assertion.
  if (routes.length === 0 || quoteId === null) {
    return { outcome: "no_route", quoteId };
  }
  return { outcome: "routes", quoteId, routes };
}
