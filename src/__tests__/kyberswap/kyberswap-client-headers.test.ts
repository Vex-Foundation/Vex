/**
 * W2a (SPEC §2.1) — the header set and the status contract for all three
 * KyberSwap clients.
 *
 * BLOCKING and live-reproduced: KyberSwap fronts every host with Cloudflare.
 * Our previous shape sent no `User-Agent` of its own and no `Accept`, and ran
 * only because Node's `fetch` happens to send `user-agent: node`. A 403
 * challenge answers with an HTML page, which the old hand-rolled `readJson`
 * discarded — so the agent was told "HTTP 403" with no status attached and
 * retried an edge refusal forever.
 *
 * `X-Client-Id` is a registered id worth 60 req/10 s against 30 with none, and
 * the common-service client sent none at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { KYBERSWAP_REQUEST_HEADERS, KYBER_CLIENT_ID } from "@tools/kyberswap/constants.js";
import { mapAggregatorError } from "@tools/kyberswap/aggregator/errors.js";
import { readKyberErrorBody } from "@tools/kyberswap/errors.js";
import type { SwapRouteParams } from "@tools/kyberswap/aggregator/types.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";

describe("KYBERSWAP_REQUEST_HEADERS", () => {
  it("carries a non-empty User-Agent, an Accept, and the registered client id", () => {
    expect(KYBERSWAP_REQUEST_HEADERS["User-Agent"]).toMatch(/^Vex\/\d+\.\d+\.\d+ \(\+https:\/\/projectvex\.ai\)$/);
    expect(KYBERSWAP_REQUEST_HEADERS.Accept).toBe("application/json");
    expect(KYBERSWAP_REQUEST_HEADERS["X-Client-Id"]).toBe(KYBER_CLIENT_ID);
    expect(KYBER_CLIENT_ID).toBe("Vex");
  });
});

describe("every KyberSwap client sends the shared header set", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentHeaders(): Record<string, string> {
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    return init?.headers ?? {};
  }

  it("aggregator", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    const { KyberAggregatorClient } = await import("@tools/kyberswap/aggregator/client.js");
    await new KyberAggregatorClient("https://aggregator-api.kyberswap.com")
      .getRoute("base", { tokenIn: "0x1", tokenOut: "0x2", amountIn: "1" } satisfies SwapRouteParams)
      .catch(() => undefined);
    expect(sentHeaders()).toMatchObject(KYBERSWAP_REQUEST_HEADERS);
  });

  it("token-api", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    const { KyberTokenApiClient } = await import("@tools/kyberswap/token-api/client.js");
    await new KyberTokenApiClient("https://token-api.kyberswap.com")
      .getHoneypotFotInfo(8453, "0x1")
      .catch(() => undefined);
    expect(sentHeaders()).toMatchObject(KYBERSWAP_REQUEST_HEADERS);
  });

  it("common-service — which previously sent no client id at all", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    const { KyberCommonClient } = await import("@tools/kyberswap/common/client.js");
    await new KyberCommonClient("https://common-service.kyberswap.com")
      .getSupportedChains()
      .catch(() => undefined);
    expect(sentHeaders()).toMatchObject(KYBERSWAP_REQUEST_HEADERS);
  });
});

describe("a 403 with a Cloudflare HTML body", () => {
  it("classifies auth, keeps the status, and never reaches the agent as raw markup", async () => {
    const html = "<!DOCTYPE html><html><head><title>Just a moment…</title></head>"
      + "<body>Attention Required! Cloudflare Ray ID: 8f0</body></html>";
    const body = await readKyberErrorBody(new Response(html, { status: 403 }));
    const err = mapAggregatorError(403, body.code, body.message);

    expect(err.httpStatus).toBe(403);
    expect(err.retryable).toBe(false);

    const summary = summarizeProtocolError(err);
    expect(summary.category).toBe("auth");
    expect(summary.httpStatus).toBe(403);
    expect(summary.message).not.toContain("<html");
    expect(summary.message).not.toContain("Cloudflare");
    expect(summary.message).toContain("(html)");
    expect(summary.remediation).toContain("do not retry");
  });

  it("adds a 404 branch that names the wrong-chain cause", () => {
    const err = mapAggregatorError(404, null, "HTTP 404");
    expect(err.httpStatus).toBe(404);
    expect(summarizeProtocolError(err).category).toBe("invalid_request");
  });

  it("keeps the 429 status so the rate-limit remedy is reachable", () => {
    const err = mapAggregatorError(429, null, "slow down");
    expect(err.httpStatus).toBe(429);
    const summary = summarizeProtocolError(err);
    expect(summary.category).toBe("rate_limit");
    expect(summary.remediation).toContain("rate-limiting");
  });
});

describe("readKyberErrorBody", () => {
  it("prefers the JSON envelope's message, code and requestId", async () => {
    const body = await readKyberErrorBody(
      new Response(JSON.stringify({ code: 4008, message: "no route", requestId: "r-1" }), { status: 400 }),
    );
    expect(body).toEqual({ code: 4008, message: "no route", requestId: "r-1" });
  });

  it("keeps a non-JSON body instead of discarding it", async () => {
    const body = await readKyberErrorBody(new Response("upstream blocked", { status: 403 }));
    expect(body.code).toBeNull();
    expect(body.message).toBe("HTTP 403: upstream blocked");
  });

  it("falls back to the bare status for an empty body", async () => {
    const body = await readKyberErrorBody(new Response("", { status: 502 }));
    expect(body.message).toBe("HTTP 502");
  });
});
