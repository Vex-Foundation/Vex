/**
 * The aggregator's envelope is not the HTTP status.
 *
 * MEASURED (live, 2026-08-27 and 2026-08-28):
 *   - every answer is wrapped as `{code, message, data}` and `code: 0` is the
 *     ONLY success, so a documented failure can arrive with HTTP 200 and no
 *     usable `data`. Before this mapping, the schema validator refused such a
 *     body as a shape error and the real cause (route not found, token not
 *     found, WETH not configured) never reached the agent;
 *   - a chain slug the aggregator does not serve answers a DIFFERENT envelope
 *     with NO `code` at all -
 *     `{message, path, request_id, request_ip, status}` - archived from a live
 *     404 on 2026-08-28.
 *
 * The documented code table is exercised whole, because "which codes are
 * mapped" is exactly the sort of thing that silently rots.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VexError, ErrorCodes } from "../../errors.js";
import {
  readAggregatorEnvelope,
  isUncodedEnvelopeShape,
  mapUncodedAggregatorEnvelope,
  mapAggregatorError,
} from "@tools/kyberswap/aggregator/errors.js";
import { KyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";

const ROUTE_PATH = "/robinhood/api/v1/routes";
/**
 * A slug the aggregator does not serve. Declared through the client's own
 * parameter type rather than cast away: the client accepts a `KyberChainSlug`,
 * and what is being tested is the PROVIDER's answer for an unserved chain, not
 * a bypass of our own chain typing.
 */
const UNSERVED_SLUG = "robinhood" as KyberChainSlug;

describe("readAggregatorEnvelope", () => {
  it("code 0 is the only success", () => {
    expect(readAggregatorEnvelope({ code: 0, message: "successfully", data: {} })).toEqual({ kind: "success" });
  });

  const documented = [4001, 4002, 4005, 4007, 4008, 4009, 4010, 4011, 4221] as const;
  for (const code of documented) {
    it(`classifies a 2xx body carrying code ${code} as a provider failure`, () => {
      expect(readAggregatorEnvelope({ code, message: "nope", requestId: "rq-1" })).toEqual({
        kind: "provider_code", code, message: "nope", requestId: "rq-1",
      });
    });
  }

  it("classifies an undocumented nonzero code rather than letting it read as success", () => {
    expect(readAggregatorEnvelope({ code: 9999, message: "" })).toMatchObject({ kind: "provider_code", code: 9999 });
  });

  it("recognises the uncoded envelope by its own shape, not by its prose", () => {
    const live = {
      message: "",
      path: "/no-such-chain-xyz/api/v1/routes?tokenIn=0xeee",
      request_id: "3ad50f13-32b4-4101-9b12-c6cb6f6cd0e4",
      request_ip: "10.19.14.2",
      status: 404,
    };
    expect(isUncodedEnvelopeShape(live)).toBe(true);
    expect(readAggregatorEnvelope(live)).toEqual({
      kind: "uncoded", requestId: "3ad50f13-32b4-4101-9b12-c6cb6f6cd0e4",
    });
  });

  it("a coded body is never mistaken for the uncoded envelope", () => {
    expect(isUncodedEnvelopeShape({ code: 0, path: "/x", status: 200 })).toBe(false);
  });

  for (const notAnEnvelope of [null, undefined, "text", 5, []]) {
    it(`leaves ${JSON.stringify(notAnEnvelope)} to the schema validators`, () => {
      expect(readAggregatorEnvelope(notAnEnvelope)).toEqual({ kind: "success" });
    });
  }
});

describe("mapUncodedAggregatorEnvelope", () => {
  it("is its own typed outcome, names the chain, and is not retryable", () => {
    const err = mapUncodedAggregatorEnvelope("no-such-chain-xyz", 404, "rq-1");
    expect(err).toBeInstanceOf(VexError);
    expect(err.code).toBe(ErrorCodes.KYBER_UNSUPPORTED_CHAIN);
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(404);
    expect(err.message).toContain("no-such-chain-xyz");
    expect(err.message).toContain("rq-1");
  });
});

describe("the documented code table maps the same way at 200 as at 422", () => {
  const expectations: readonly [number, string][] = [
    [4001, ErrorCodes.KYBER_MALFORMED_PARAMS],
    [4002, ErrorCodes.KYBER_MALFORMED_PARAMS],
    [4005, ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT],
    [4007, ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT],
    [4008, ErrorCodes.KYBER_ROUTE_NOT_FOUND],
    [4010, ErrorCodes.KYBER_ROUTE_NOT_FOUND],
    [4009, ErrorCodes.KYBER_AMOUNT_TOO_LARGE],
    [4011, ErrorCodes.KYBER_TOKEN_NOT_FOUND],
    [4221, ErrorCodes.KYBER_WETH_NOT_CONFIGURED],
  ];
  for (const [code, expected] of expectations) {
    it(`code ${code} -> ${expected} on both statuses`, () => {
      expect(mapAggregatorError(200, code, "m").code).toBe(expected);
      expect(mapAggregatorError(422, code, "m").code).toBe(expected);
    });
  }
});

describe("the client raises the envelope, not a shape error", () => {
  const realFetch = globalThis.fetch;

  // Typed as the real `fetch`, so a stub that stops matching the platform
  // signature is a compile error rather than a silently different transport.
  function respondWith(body: unknown, status = 200): void {
    const stub: typeof fetch = async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = vi.fn(stub);
  }

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("a 200 carrying code 4008 surfaces as route-not-found, never as a validator shape error", async () => {
    respondWith({ code: 4008, message: "route not found" });
    const client = new KyberAggregatorClient("https://aggregator-api.kyberswap.com");

    await expect(
      client.getRoute("robinhood", { tokenIn: "0xa", tokenOut: "0xb", amountIn: "1" }),
    ).rejects.toMatchObject({ code: ErrorCodes.KYBER_ROUTE_NOT_FOUND });
  });

  it("a 200 uncoded envelope surfaces as an unsupported chain", async () => {
    respondWith({ message: "", path: ROUTE_PATH, request_id: "rq-2", request_ip: "10.0.0.1", status: 200 });
    const client = new KyberAggregatorClient("https://aggregator-api.kyberswap.com");

    await expect(
      client.getRoute("robinhood", { tokenIn: "0xa", tokenOut: "0xb", amountIn: "1" }),
    ).rejects.toMatchObject({ code: ErrorCodes.KYBER_UNSUPPORTED_CHAIN });
  });

  it("a NON-2xx uncoded envelope surfaces the same way, not as a generic 404", async () => {
    respondWith({ message: "", path: ROUTE_PATH, request_id: "rq-3", request_ip: "10.0.0.1", status: 404 }, 404);
    const client = new KyberAggregatorClient("https://aggregator-api.kyberswap.com");

    await expect(
      // A slug outside `KyberChainSlug` is precisely the case: the aggregator
      // answers its uncoded envelope for a chain it does not serve.
      client.getRoute(UNSERVED_SLUG, { tokenIn: "0xa", tokenOut: "0xb", amountIn: "1" }),
    ).rejects.toMatchObject({ code: ErrorCodes.KYBER_UNSUPPORTED_CHAIN });
  });

  it("a real code-0 success still validates and returns", async () => {
    respondWith({
      code: 0, message: "successfully",
      data: {
        routeSummary: {
          tokenIn: "0xa", amountIn: "1", amountInUsd: "1",
          tokenOut: "0xb", amountOut: "2", amountOutUsd: "2",
          gas: "1", gasPrice: "1", gasUsd: "0.01", route: [],
          routeID: "r1", checksum: "c1", timestamp: 1,
        },
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      },
    });
    const client = new KyberAggregatorClient("https://aggregator-api.kyberswap.com");

    const res = await client.getRoute("robinhood", { tokenIn: "0xa", tokenOut: "0xb", amountIn: "1" });
    expect(res.data.routeSummary.amountOut).toBe("2");
  });
});
