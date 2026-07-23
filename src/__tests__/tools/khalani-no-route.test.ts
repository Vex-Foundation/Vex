/**
 * Khalani typed no-route (W1, R10) — empty `routes[]` becomes a FAILURE-shaped
 * result that can never seed a successful prequote, in both plain and stream
 * mode. The stream-mode contract is the load-bearing one: the no-route decision
 * is made ONLY after a clean NDJSON close; a thrown value (bad line / transport
 * failure) PROPAGATES and is never silently downgraded to a no-route.
 */

import { describe, it, expect } from "vitest";
import {
  classifyKhalaniQuoteResponse,
  collectKhalaniQuoteStream,
  type KhalaniQuoteOutcome,
} from "@tools/khalani/quote-result.js";
import type { QuoteResponse, QuoteRoute, QuoteStreamRoute } from "@tools/khalani/types.js";

function route(routeId: string): QuoteRoute {
  return {
    routeId,
    type: "native-filler",
    depositMethods: ["CONTRACT_CALL"],
    quote: {
      amountIn: "1000",
      amountOut: "995",
      expectedDurationSeconds: 10,
      validBefore: 1700000000,
    },
  };
}

function streamRoute(routeId: string, quoteId: string): QuoteStreamRoute {
  return { ...route(routeId), quoteId };
}

async function* fromRoutes(routes: readonly QuoteStreamRoute[]): AsyncGenerator<QuoteStreamRoute> {
  for (const r of routes) {
    yield r;
  }
}

async function* throwsAfter(
  routes: readonly QuoteStreamRoute[],
  error: Error,
): AsyncGenerator<QuoteStreamRoute> {
  for (const r of routes) {
    yield r;
  }
  throw error;
}

describe("classifyKhalaniQuoteResponse — plain mode", () => {
  it("empty routes[] → typed no_route carrying the quoteId", () => {
    const response: QuoteResponse = { quoteId: "q-empty", routes: [] };
    const result = classifyKhalaniQuoteResponse(response);
    expect(result).toEqual({ outcome: "no_route", quoteId: "q-empty" } satisfies KhalaniQuoteOutcome);
  });

  it("non-empty routes[] → routes outcome (never no_route)", () => {
    const response: QuoteResponse = { quoteId: "q1", routes: [route("Hyperstream"), route("Across")] };
    const result = classifyKhalaniQuoteResponse(response);
    expect(result.outcome).toBe("routes");
    if (result.outcome === "routes") {
      expect(result.quoteId).toBe("q1");
      expect(result.routes).toHaveLength(2);
    }
  });
});

describe("collectKhalaniQuoteStream — stream mode (decide after clean close)", () => {
  it("clean close with zero routes → no_route (quoteId null)", async () => {
    const result = await collectKhalaniQuoteStream(fromRoutes([]));
    expect(result).toEqual({ outcome: "no_route", quoteId: null } satisfies KhalaniQuoteOutcome);
  });

  it("clean close with routes → routes outcome carrying the first quoteId", async () => {
    const result = await collectKhalaniQuoteStream(
      fromRoutes([streamRoute("Hyperstream", "q-stream"), streamRoute("Across", "q-stream")]),
    );
    expect(result.outcome).toBe("routes");
    if (result.outcome === "routes") {
      expect(result.quoteId).toBe("q-stream");
      expect(result.routes.map((r) => r.routeId)).toEqual(["Hyperstream", "Across"]);
    }
  });

  it("a thrown value on an EMPTY stream PROPAGATES — never a no_route", async () => {
    const boom = new Error("Invalid Khalani NDJSON line");
    await expect(collectKhalaniQuoteStream(throwsAfter([], boom))).rejects.toThrow(boom);
  });

  it("a thrown value AFTER some routes PROPAGATES — an unclean close is an error, not a partial result", async () => {
    const boom = new Error("stream aborted");
    await expect(
      collectKhalaniQuoteStream(throwsAfter([streamRoute("Hyperstream", "q-stream")], boom)),
    ).rejects.toThrow(boom);
  });
});
