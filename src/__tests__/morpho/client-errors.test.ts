/**
 * Morpho client transport behaviour: error classification, the request budget,
 * and the circuit breaker.
 *
 * The 429 cases are the point of this file. Morpho answers sustained abuse with
 * `Retry-After: 604800` - a SEVEN-DAY block - so a client that treats that
 * header as an ordinary backoff hint takes the integration offline for a week.
 * These tests pin that a ban-length interval OPENS the breaker, that the breaker
 * refuses locally WITHOUT sending anything, and that its refusal is
 * distinguishable from Morpho's own.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MorphoClient } from "../../tools/morpho/client.js";
import { MorphoBudget } from "../../tools/morpho/budget.js";
import {
  mapMorphoHttpError,
  mapMorphoGraphqlError,
  readMorphoErrorMessage,
  sanitizeMorphoCause,
} from "../../tools/morpho/errors.js";
import { ErrorCodes, VexError } from "../../errors.js";
import { MORPHO_MARKETS_PAGE } from "../vex-agent/tools/protocols/morpho/fixtures.js";
import { MORPHO_MARKET_NOT_FOUND } from "../vex-agent/tools/protocols/morpho/position-fixtures.js";

const ENDPOINT = "https://api.morpho.org/graphql";

/** A test budget with a virtual clock, so nothing waits on a real timer. */
function testBudget(): { budget: MorphoBudget; advance: (ms: number) => void } {
  let now = 1_000_000;
  const budget = new MorphoBudget({
    requestsPerMinute: 60,
    deps: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
  });
  return { budget, advance: (ms) => { now += ms; } };
}

/**
 * A REAL `Response`. The client reads `ok`, `status`, `headers.get(...)` and
 * `json()`; a hand-shaped four-key double would keep passing if it started
 * reading a fifth, and could only be typed through an escape.
 */
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapMorphoHttpError", () => {
  it("preserves the HTTP status instead of collapsing it into text", () => {
    const err = mapMorphoHttpError(403, { message: "API key quota exceeded" });
    expect(err.httpStatus).toBe(403);
    expect(err.message).toContain("API key quota exceeded");
  });

  it("carries the provider's own words rather than a guess", () => {
    const err = mapMorphoHttpError(400, {
      errors: [{ message: 'Cannot query field "whitelisted" on type "Market". Did you mean "listed"?' }],
    });
    expect(err.message).toContain('Did you mean "listed"');
    expect(err.code).toBe(ErrorCodes.MORPHO_API_ERROR);
  });

  it("reads a body that is a bare JSON string, rather than dropping it", () => {
    expect(readMorphoErrorMessage("Invalid JSON in request body")).toBe("Invalid JSON in request body");
  });

  it("returns empty rather than throwing on a body shape no parser expected", () => {
    expect(readMorphoErrorMessage(42)).toBe("");
    expect(readMorphoErrorMessage({ unexpected: true })).toBe("");
  });

  it("describes a week-long Retry-After in DAYS and names it as an abuse block", () => {
    const err = mapMorphoHttpError(429, { message: "rate limited" }, 604_800);
    expect(err.code).toBe(ErrorCodes.MORPHO_RATE_LIMITED);
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterSeconds).toBe(604_800);
    expect(err.hint).toContain("7-day wait");
    expect(err.hint).toContain("ABUSE penalty");
  });

  it("marks only 429 and 5xx retryable - a 4xx verdict does not change on replay", () => {
    expect(mapMorphoHttpError(429, null).retryable).toBe(true);
    expect(mapMorphoHttpError(503, null).retryable).toBe(true);
    expect(mapMorphoHttpError(400, null).retryable).toBe(false);
    expect(mapMorphoHttpError(403, null).retryable).toBe(false);
  });

  it("maps GraphQL's HTTP-200-with-errors mode to a non-retryable drift error", () => {
    const err = mapMorphoGraphqlError("Cannot query field \"priceUsd\"");
    expect(err.httpStatus).toBe(200);
    expect(err.retryable).toBe(false);
    expect(err.hint).toContain("code fix, not a retry");
  });
});

describe("sanitizeMorphoCause", () => {
  it("strips URLs, long hex blobs and auth fragments while keeping the real cause", () => {
    const scrubbed = sanitizeMorphoCause(
      "reverted at 0xabcdef0123456789abcdef see https://viem.sh/docs bearer: sk-secret-value",
    );
    expect(scrubbed).toContain("reverted at");
    expect(scrubbed).not.toContain("viem.sh");
    expect(scrubbed).not.toContain("sk-secret-value");
    expect(scrubbed).not.toContain("0xabcdef0123456789abcdef");
  });

  it("length-caps rather than dropping an oversized message", () => {
    const scrubbed = sanitizeMorphoCause("x".repeat(1_000));
    expect(scrubbed).toContain("[truncated]");
    expect(scrubbed.length).toBeLessThan(450);
  });
});

describe("MorphoClient budget and circuit breaker", () => {
  it("serves a successful read through the validator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, MORPHO_MARKETS_PAGE)));
    const { budget } = testBudget();
    const page = await new MorphoClient(ENDPOINT, budget).getMarketPage({
      first: 3, skip: 0, orderBy: "supplyUsd", order: "desc", where: { listed: true },
    });
    expect(page.markets).toHaveLength(3);
  });

  it("sends an explicit User-Agent and Accept on every request", async () => {
    const seen: Array<{ method?: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { method?: string; headers: Record<string, string> }) => {
        seen.push(init);
        return response(200, MORPHO_MARKETS_PAGE);
      }),
    );
    const { budget } = testBudget();
    await new MorphoClient(ENDPOINT, budget).getMarketPage({
      first: 1, skip: 0, orderBy: "supplyUsd", order: "desc", where: { listed: true },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["User-Agent"]).toMatch(/Vex-Agent/);
    expect(seen[0]?.headers["Accept"]).toBe("application/json");
    expect(seen[0]?.method).toBe("POST");
  });

  it("OPENS the breaker on a 429 carrying a ban-length Retry-After, and then sends NOTHING", async () => {
    const fetchSpy = vi.fn(async () => response(429, { message: "too many requests" }, { "retry-after": "604800" }));
    vi.stubGlobal("fetch", fetchSpy);
    const { budget } = testBudget();
    const client = new MorphoClient(ENDPOINT, budget);
    const query = { first: 1, skip: 0, orderBy: "supplyUsd", order: "desc", where: { listed: true } } as const;

    await expect(client.getMarketPage({ ...query })).rejects.toMatchObject({
      code: ErrorCodes.MORPHO_RATE_LIMITED,
      httpStatus: 429,
    });
    expect(client.describeBudget().open).toBe(true);

    // The SECOND call must never reach the network: backing off inside our own
    // process is the only move that cannot dig the hole deeper.
    const before = fetchSpy.mock.calls.length;
    await expect(client.getMarketPage({ ...query, skip: 1 })).rejects.toMatchObject({
      code: ErrorCodes.MORPHO_BUDGET_EXHAUSTED,
    });
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it("distinguishes OUR refusal from Morpho's, in the code and in the hint", async () => {
    const { budget } = testBudget();
    budget.recordRateLimit(604_800);
    vi.stubGlobal("fetch", vi.fn(async () => response(200, MORPHO_MARKETS_PAGE)));
    const client = new MorphoClient(ENDPOINT, budget);
    await client.getMarketPage({ first: 1, skip: 0, orderBy: "supplyUsd", order: "desc", where: { listed: true } })
      .then(
        () => expect.fail("expected the breaker to refuse"),
        (err: VexError) => {
          expect(err.code).toBe(ErrorCodes.MORPHO_BUDGET_EXHAUSTED);
          expect(err.message).toContain("day(s)");
          expect(err.hint).toContain("Vex's own circuit breaker, not a Morpho refusal");
          // No status: nothing answered, so inventing one would erase the
          // difference between a refusal and an unreachable provider.
          expect(err.httpStatus).toBeUndefined();
        },
      );
  });

  it("trips the breaker after repeated 429s even with no Retry-After header", () => {
    const { budget } = testBudget();
    budget.recordRateLimit(undefined);
    budget.recordRateLimit(undefined);
    expect(budget.describeState().open).toBe(false);
    budget.recordRateLimit(undefined);
    expect(budget.describeState().open).toBe(true);
    expect(budget.describeState().reason).toContain("3 consecutive");
  });

  it("caches an identical read inside the TTL instead of spending a second request", async () => {
    const fetchSpy = vi.fn(async () => response(200, MORPHO_MARKETS_PAGE));
    vi.stubGlobal("fetch", fetchSpy);
    const { budget } = testBudget();
    const client = new MorphoClient(ENDPOINT, budget);
    const query = { first: 3, skip: 0, orderBy: "supplyUsd", order: "desc", where: { listed: true } } as const;
    await client.getMarketPage({ ...query });
    await client.getMarketPage({ ...query });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses an address-shaped marketId before any request is sent", async () => {
    const fetchSpy = vi.fn(async () => response(200, {}));
    vi.stubGlobal("fetch", fetchSpy);
    const { budget } = testBudget();
    await expect(
      new MorphoClient(ENDPOINT, budget).getMarket({
        marketId: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        chainId: 8453,
        includeHistory: false,
        lookback: "seven_days",
        includeSupplyingVaults: false,
      }),
    ).rejects.toThrowError(/20-byte contract ADDRESS/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * REGRESSION (batch 2 review, fixed in batch 3): `getMarket` did not pass the
 * `notFound` hook, so a nonexistent market id came back as MORPHO_API_ERROR
 * ("Morpho rejected the GraphQL query") instead of MORPHO_MARKET_NOT_FOUND.
 *
 * The distinction is not cosmetic. One says "your query is broken", which sends
 * the agent hunting a schema fault it cannot fix; the other says "that id does
 * not exist on that chain", which is a mistake it can correct in one call.
 * Morpho reports BOTH through the identical HTTP 200 + `data: null` +
 * `errors[{status: "NOT_FOUND"}]` envelope, so only the hook tells them apart.
 */
describe("getMarket not-found classification", () => {
  it("maps Morpho's NOT_FOUND envelope to MORPHO_MARKET_NOT_FOUND with a readable remedy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, MORPHO_MARKET_NOT_FOUND)));
    const client = new MorphoClient(ENDPOINT, testBudget().budget);

    const err = await client
      .getMarket({
        marketId: `0x${"00".repeat(31)}01`,
        chainId: 1,
        includeHistory: false,
        lookback: "one_day",
        includeSupplyingVaults: false,
      })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(VexError);
    const vexErr = err as VexError;
    expect(vexErr.code).toBe(ErrorCodes.MORPHO_MARKET_NOT_FOUND);
    // The agent-readable half: what is wrong, and what to do about it.
    expect(vexErr.message).toContain("no market with that id on that chain");
    expect(vexErr.hint).toContain("chain-scoped");
    expect(vexErr.hint).toContain("morpho.markets.discover");
    // The exact wording the bug produced must NOT come back.
    expect(vexErr.message).not.toMatch(/rejected the GraphQL query/);
  });

  it("still reports a genuine schema failure as a GraphQL refusal, not as a missing market", () => {
    // The other side of the same envelope: errors WITHOUT a NOT_FOUND status.
    const err = mapMorphoGraphqlError('Cannot query field "uniqueKey" on type "Market".');
    expect(err.code).not.toBe(ErrorCodes.MORPHO_MARKET_NOT_FOUND);
    expect(err.message).toContain("uniqueKey");
  });
});
