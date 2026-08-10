import { describe, it, expect } from "vitest";
import { mapAggregatorError } from "@tools/kyberswap/aggregator/errors.js";
import { ErrorCodes } from "../../errors.js";

describe("mapAggregatorError", () => {
  it("maps 429 to KYBER_RATE_LIMITED (retryable)", () => {
    const err = mapAggregatorError(429, null, "Rate limited");
    expect(err.code).toBe(ErrorCodes.KYBER_RATE_LIMITED);
    expect(err.retryable).toBe(true);
  });

  it("maps code 4001 to KYBER_MALFORMED_PARAMS", () => {
    const err = mapAggregatorError(400, 4001, "Bad params");
    expect(err.code).toBe(ErrorCodes.KYBER_MALFORMED_PARAMS);
    expect(err.retryable).toBe(false);
    expect(err.externalName).toBe("4001");
  });

  it("maps code 4002 to KYBER_MALFORMED_PARAMS", () => {
    const err = mapAggregatorError(400, 4002, "Bad body");
    expect(err.code).toBe(ErrorCodes.KYBER_MALFORMED_PARAMS);
    expect(err.externalName).toBe("4002");
  });

  it("maps code 4005 to KYBER_FEE_EXCEEDS_AMOUNT", () => {
    const err = mapAggregatorError(400, 4005, "Fee exceeds input");
    expect(err.code).toBe(ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT);
  });

  it("maps code 4007 to KYBER_FEE_EXCEEDS_AMOUNT", () => {
    const err = mapAggregatorError(400, 4007, "Fee exceeds output");
    expect(err.code).toBe(ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT);
  });

  it("maps code 4008 to KYBER_ROUTE_NOT_FOUND", () => {
    const err = mapAggregatorError(400, 4008, "No route");
    expect(err.code).toBe(ErrorCodes.KYBER_ROUTE_NOT_FOUND);
    expect(err.retryable).toBe(false);
  });

  it("maps code 4009 to KYBER_AMOUNT_TOO_LARGE", () => {
    const err = mapAggregatorError(400, 4009, "Amount too large");
    expect(err.code).toBe(ErrorCodes.KYBER_AMOUNT_TOO_LARGE);
  });

  it("maps code 4010 to KYBER_ROUTE_NOT_FOUND", () => {
    const err = mapAggregatorError(400, 4010, "No pools");
    expect(err.code).toBe(ErrorCodes.KYBER_ROUTE_NOT_FOUND);
  });

  it("maps code 4011 to KYBER_TOKEN_NOT_FOUND", () => {
    const err = mapAggregatorError(400, 4011, "Token not found");
    expect(err.code).toBe(ErrorCodes.KYBER_TOKEN_NOT_FOUND);
  });

  it("maps code 4221 to KYBER_WETH_NOT_CONFIGURED", () => {
    const err = mapAggregatorError(422, 4221, "WETH not configured");
    expect(err.code).toBe(ErrorCodes.KYBER_WETH_NOT_CONFIGURED);
  });

  it("maps 5xx to KYBER_API_ERROR (retryable)", () => {
    const err = mapAggregatorError(500, null, "Server error");
    expect(err.code).toBe(ErrorCodes.KYBER_API_ERROR);
    expect(err.retryable).toBe(true);
  });

  it("includes requestId in message", () => {
    const err = mapAggregatorError(400, 4008, "No route", "req-123");
    expect(err.message).toContain("req-123");
  });

  it("sets externalName from code", () => {
    const err = mapAggregatorError(400, 4008, "No route");
    expect(err.externalName).toBe("4008");
  });

  // An HTTP status must never be stamped into `externalName`: that field is
  // the KyberSwap BODY-code namespace, and a 403 landing in it read
  // downstream as "Kyber code 403" and kept the fallback venue locked for a
  // geo-blocked user. `httpStatus` already carries the status.
  const EDGE_REFUSAL_HINT =
    "The venue's edge rejected our client, not the trade. The same request will be refused the same way, so do not repeat it unchanged on this venue.";

  it("maps 403 to KYBER_API_ERROR with the status on httpStatus and NOT on externalName", () => {
    const err = mapAggregatorError(403, null, "blocked");
    expect(err.code).toBe(ErrorCodes.KYBER_API_ERROR);
    expect(err.message).toContain("KyberSwap refused the request (HTTP 403)");
    expect(err.httpStatus).toBe(403);
    expect(err.retryable).toBe(false);
    expect(err.externalName).toBeUndefined();
    expect(err.hint).toBe(EDGE_REFUSAL_HINT);
  });

  it("maps 401 through the same edge-refusal branch", () => {
    const err = mapAggregatorError(401, null, "unauthorized");
    expect(err.code).toBe(ErrorCodes.KYBER_API_ERROR);
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.externalName).toBeUndefined();
    expect(err.hint).toBe(EDGE_REFUSAL_HINT);
  });

  // 451 is what an edge returns when it blocks a whole region - the exact
  // scenario the availability class exists for, so it must not fall through
  // to the generic 4xx tail.
  it("maps 451 through the edge-refusal branch, not the generic 4xx tail", () => {
    const err = mapAggregatorError(451, null, "unavailable for legal reasons");
    expect(err.code).toBe(ErrorCodes.KYBER_API_ERROR);
    expect(err.message).toContain("KyberSwap refused the request (HTTP 451)");
    expect(err.httpStatus).toBe(451);
    expect(err.retryable).toBe(false);
    expect(err.externalName).toBeUndefined();
    expect(err.hint).toBe(EDGE_REFUSAL_HINT);
  });

  it("maps 404 with the status on httpStatus only", () => {
    const err = mapAggregatorError(404, null, "no such path");
    expect(err.code).toBe(ErrorCodes.KYBER_API_ERROR);
    expect(err.httpStatus).toBe(404);
    expect(err.externalName).toBeUndefined();
  });

  it("maps 429 to KYBER_RATE_LIMITED with the status on httpStatus only", () => {
    const err = mapAggregatorError(429, null, "Rate limited");
    expect(err.code).toBe(ErrorCodes.KYBER_RATE_LIMITED);
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.externalName).toBeUndefined();
  });

  // Scope guard: a REAL KyberSwap body code still belongs in `externalName`.
  it("keeps a real body code in externalName on the 5xx tail", () => {
    expect(mapAggregatorError(500, 4008, "x").externalName).toBe("4008");
  });

  it("no longer tells the agent a geo-block is unrecoverable with no alternative", () => {
    expect(mapAggregatorError(403, null, "blocked").hint).not.toContain("Do not retry unchanged");
  });

  it("handles unknown code on non-5xx", () => {
    const err = mapAggregatorError(400, 9999, "Unknown");
    expect(err.code).toBe(ErrorCodes.KYBER_API_ERROR);
    expect(err.retryable).toBe(false);
  });
});
