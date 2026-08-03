/**
 * A 429 that names its interval must reach the agent WITH the number.
 *
 * The gap this pins: an agent hitting Jupiter's ~10-request window was told
 * "the provider is rate-limiting; wait before retrying this venue" — true, and
 * with no interval in it, so the agent either retried straight back into the
 * wall or deferred for an invented duration. Every layer of the path is pinned
 * here: header → bounded integer (`readRetryAfterSeconds`), integer →
 * `VexError.retryAfterSeconds` (`parseJsonResponse`), field → the agent's
 * remedy (`remediationFor`/`summarizeProtocolError`), and the whole thing
 * end-to-end through the real Jupiter swap-order client.
 *
 * The bound is the security property: a header value is untrusted external
 * input, so nothing but a validated integer may cross, and a header that is
 * prose, negative, or absurd leaves the wording exactly as it was.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VexError, ErrorCodes } from "../../errors.js";
import { readRetryAfterSeconds } from "../../utils/http/retry-after.js";
import { parseJsonResponse } from "../../utils/http.js";
import { remediationFor } from "../../utils/error-summary/remediation.js";
import { summarizeProtocolError, renderProtocolFailureOutput } from "../../utils/error-summary/render.js";

const NOW_MS = Date.UTC(2026, 7, 3, 12, 0, 0);

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function errorResponse(status: number, headerEntries: Record<string, string>, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headerEntries },
  });
}

describe("readRetryAfterSeconds — header to bounded integer", () => {
  it("reads Retry-After delta-seconds on any error status", () => {
    expect(readRetryAfterSeconds(headers({ "retry-after": "12" }), 429, NOW_MS)).toBe(12);
    expect(readRetryAfterSeconds(headers({ "retry-after": "30" }), 503, NOW_MS)).toBe(30);
  });

  it("reads Retry-After as an HTTP-date, as a delta from now", () => {
    const at = new Date(NOW_MS + 45_000).toUTCString();
    expect(readRetryAfterSeconds(headers({ "retry-after": at }), 429, NOW_MS)).toBe(45);
  });

  it("rejects a Retry-After that is prose, negative, zero, or absurd", () => {
    for (const raw of ["soon", "", "-5", "0", "999999999", "12; drop table", "NaN"]) {
      expect(readRetryAfterSeconds(headers({ "retry-after": raw }), 429, NOW_MS)).toBeUndefined();
    }
  });

  it("reads the x-ratelimit family ONLY on a 429", () => {
    const reset = headers({ "x-ratelimit-reset-after": "8" });
    expect(readRetryAfterSeconds(reset, 429, NOW_MS)).toBe(8);
    expect(readRetryAfterSeconds(reset, 400, NOW_MS)).toBeUndefined();
    expect(readRetryAfterSeconds(reset, 500, NOW_MS)).toBeUndefined();
  });

  it("disambiguates x-ratelimit-reset by magnitude: delta, epoch seconds, epoch millis", () => {
    expect(readRetryAfterSeconds(headers({ "x-ratelimit-reset": "20" }), 429, NOW_MS)).toBe(20);
    expect(
      readRetryAfterSeconds(
        headers({ "x-ratelimit-reset": String(Math.floor(NOW_MS / 1000) + 25) }),
        429,
        NOW_MS,
      ),
    ).toBe(25);
    expect(
      readRetryAfterSeconds(headers({ "x-ratelimit-reset": String(NOW_MS + 30_000) }), 429, NOW_MS),
    ).toBe(30);
  });

  it("prefers Retry-After over the x-ratelimit family", () => {
    expect(
      readRetryAfterSeconds(
        headers({ "retry-after": "5", "x-ratelimit-reset-after": "600" }),
        429,
        NOW_MS,
      ),
    ).toBe(5);
  });

  it("is undefined when the response advertised nothing", () => {
    expect(readRetryAfterSeconds(headers({}), 429, NOW_MS)).toBeUndefined();
  });
});

describe("parseJsonResponse — the interval reaches the thrown VexError", () => {
  it("stamps retryAfterSeconds from a 429's Retry-After", async () => {
    const thrown = await parseJsonResponse(
      errorResponse(429, { "retry-after": "12" }, { error: "Too many requests" }),
    ).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown as VexError;
    expect(error.httpStatus).toBe(429);
    expect(error.retryAfterSeconds).toBe(12);
    // The header text itself never travels — only the integer.
    expect(error.message).not.toContain("retry-after");
  });

  it("leaves retryAfterSeconds absent when no usable header was sent", async () => {
    const thrown = (await parseJsonResponse(
      errorResponse(429, {}, { error: "Too many requests" }),
    ).catch((err: unknown) => err)) as VexError;

    expect(thrown.retryAfterSeconds).toBeUndefined();
  });

  it("leaves retryAfterSeconds absent when the header is unparseable", async () => {
    const thrown = (await parseJsonResponse(
      errorResponse(429, { "retry-after": "whenever you feel like it" }, { error: "nope" }),
    ).catch((err: unknown) => err)) as VexError;

    expect(thrown.retryAfterSeconds).toBeUndefined();
  });
});

describe("remediationFor — the remedy quotes the number only when known", () => {
  it("names the concrete interval when one was recovered", () => {
    expect(remediationFor("rate_limit", 12))
      .toBe("the provider is rate-limiting; wait ~12s before retrying this venue, or use another venue");
  });

  it("keeps the wording unchanged when no interval is known", () => {
    expect(remediationFor("rate_limit"))
      .toBe("the provider is rate-limiting; wait before retrying this venue, or use another venue");
  });

  it("does not splice the number into any other category", () => {
    expect(remediationFor("auth", 12)).toBe(remediationFor("auth"));
    expect(remediationFor("timeout", 12)).toBe(remediationFor("timeout"));
  });

  it("reaches the agent-facing rendering of a rate-limited VexError", () => {
    const error = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, "Too many requests");
    error.httpStatus = 429;
    error.retryAfterSeconds = 12;

    const summary = summarizeProtocolError(error);
    expect(summary.category).toBe("rate_limit");
    expect(summary.remediation).toContain("wait ~12s");
    expect(renderProtocolFailureOutput("solana.swap.quote", summary))
      .toContain("HTTP 429");
    expect(renderProtocolFailureOutput("solana.swap.quote", summary))
      .toContain("wait ~12s before retrying this venue");
  });
});

describe("Jupiter end-to-end: a real 429 from the swap-order client tells the agent how long", () => {
  const originalKey = process.env.JUPITER_API_KEY;

  beforeEach(() => {
    // The client refuses to call without one; the value never leaves the stub.
    process.env.JUPITER_API_KEY = "test-key-not-a-real-credential";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = originalKey;
  });

  it("carries Jupiter's own Retry-After all the way into the agent's remedy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "10" },
        }),
      ),
    );

    const { jupiterSwapOrder } = await import(
      "../../tools/solana-ecosystem/jupiter/jupiter-swaps/client.js"
    );

    const thrown = await jupiterSwapOrder({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      taker: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
    }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(VexError);
    const summary = summarizeProtocolError(thrown);
    expect(summary.httpStatus).toBe(429);
    expect(summary.category).toBe("rate_limit");
    expect(renderProtocolFailureOutput("solana.swap.quote", summary))
      .toContain("wait ~10s before retrying this venue");
  });
});
