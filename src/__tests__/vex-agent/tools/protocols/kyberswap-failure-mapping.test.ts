/**
 * `mapKyberFailureToActivityCode` / `deriveKyberRevealFailure` — the two
 * independent classifications of a caught Kyber error consumed by the
 * kyberswap.swap.quote/execute handlers (plan §4.1/§11.2).
 */

import { describe, it, expect } from "vitest";
import { VexError, ErrorCodes } from "../../../../errors.js";
import { mapAggregatorError } from "@tools/kyberswap/aggregator/errors.js";
import {
  mapKyberFailureToActivityCode,
  deriveKyberRevealFailure,
} from "@vex-agent/tools/protocols/kyberswap/failure-mapping.js";
import { isRevealEligibleKyberFailure } from "@vex-agent/tools/registry/uniswap-reveal-eligibility.js";

function statusError(code: string, httpStatus?: number): VexError {
  const err = new VexError(code, "boom");
  if (httpStatus !== undefined) err.httpStatus = httpStatus;
  return err;
}

/**
 * The live defect: a user in Vietnam was answered HTTP 403 by KyberSwap's
 * edge, the status was stamped into the KyberSwap BODY-code namespace, and the
 * fallback venue stayed locked. End-to-end through the REAL mapper, because
 * the collision only exists when both halves run together.
 */
describe("a geo-block 403 is a venue-availability failure, never a Kyber body code", () => {
  it("derives venue_unavailable through the real aggregator mapper", () => {
    const failure = deriveKyberRevealFailure(mapAggregatorError(403, null, "HTTP 403: (html)"), true);
    expect(failure).toEqual({ kind: "venue_unavailable", reason: "edge_refused" });
    expect(failure?.kind).not.toBe("kyber_code");
  });

  it("is reveal-eligible, so the agent is offered the fallback venue", () => {
    expect(isRevealEligibleKyberFailure({ kind: "venue_unavailable", reason: "edge_refused" })).toBe(true);
  });
});

describe("deriveVenueUnavailable, through deriveKyberRevealFailure", () => {
  it("maps every availability status to its closed reason", () => {
    const table: ReadonlyArray<readonly [number, string]> = [
      [401, "edge_refused"], [403, "edge_refused"], [451, "edge_refused"],
      [404, "endpoint_missing"], [408, "timeout"], [429, "rate_limited"],
      [500, "server_error"], [502, "server_error"], [520, "server_error"],
    ];
    for (const [status, reason] of table) {
      expect(deriveKyberRevealFailure(statusError(ErrorCodes.KYBER_API_ERROR, status), true))
        .toEqual({ kind: "venue_unavailable", reason });
    }
  });

  it("maps the availability CODES regardless of any httpStatus", () => {
    expect(deriveKyberRevealFailure(statusError(ErrorCodes.KYBER_TIMEOUT), true))
      .toEqual({ kind: "venue_unavailable", reason: "timeout" });
    expect(deriveKyberRevealFailure(statusError(ErrorCodes.KYBER_RATE_LIMITED, 429), true))
      .toEqual({ kind: "venue_unavailable", reason: "rate_limited" });
    expect(deriveKyberRevealFailure(statusError(ErrorCodes.KYBER_UNREACHABLE), true))
      .toEqual({ kind: "venue_unavailable", reason: "unreachable" });
  });

  // Closed by construction: 400 is OUR malformed parameter, not the venue's
  // availability, and every other unlisted status stays out too.
  it("is a closed set - an unlisted status is not an availability failure", () => {
    for (const status of [400, 402, 409, 418]) {
      expect(deriveKyberRevealFailure(statusError(ErrorCodes.KYBER_API_ERROR, status), true)).toBeNull();
    }
  });

  // A body code means the venue DID render a verdict about the trade, so the
  // semantic mapping wins even when the transport status looks like an outage.
  it("a semantic Kyber code takes precedence over the status", () => {
    const err = kyberError(ErrorCodes.KYBER_ROUTE_NOT_FOUND, "4008");
    err.httpStatus = 500;
    expect(deriveKyberRevealFailure(err, true)).toEqual({
      kind: "kyber_code", code: 4008, tokenInputsValidated: true,
    });
  });
});

function kyberError(code: string, externalName?: string): VexError {
  const err = new VexError(code, "boom");
  if (externalName !== undefined) err.externalName = externalName;
  return err;
}

describe("mapKyberFailureToActivityCode", () => {
  it("maps route-not-found-class codes to route_not_found", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_ROUTE_NOT_FOUND, "4008"))).toBe("route_not_found");
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_TOKEN_NOT_FOUND, "4011"))).toBe("route_not_found");
  });

  it("maps chain-unsupported to chain_unsupported", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN))).toBe("chain_unsupported");
  });

  it("maps amount/fee-size codes to insufficient_liquidity", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_AMOUNT_TOO_LARGE, "4009"))).toBe("insufficient_liquidity");
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT, "4005"))).toBe("insufficient_liquidity");
  });

  it("maps balance/approval failures to allowance_or_balance", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.INSUFFICIENT_BALANCE))).toBe("allowance_or_balance");
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.APPROVAL_FAILED))).toBe("allowance_or_balance");
  });

  it("falls back to unknown for an unmodeled VexError code and a non-VexError throw", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_WETH_NOT_CONFIGURED, "4221"))).toBe("unknown");
    expect(mapKyberFailureToActivityCode(new Error("plain"))).toBe("unknown");
    expect(mapKyberFailureToActivityCode("not an error")).toBe("unknown");
  });

  // Migration 076. Recorded as `unknown` before, which hid a live geo-block
  // stranding from telemetry entirely.
  it("maps the availability class to venue_unavailable", () => {
    expect(mapKyberFailureToActivityCode(statusError(ErrorCodes.KYBER_API_ERROR, 403))).toBe("venue_unavailable");
    expect(mapKyberFailureToActivityCode(statusError(ErrorCodes.KYBER_API_ERROR, 503))).toBe("venue_unavailable");
    expect(mapKyberFailureToActivityCode(statusError(ErrorCodes.KYBER_TIMEOUT))).toBe("venue_unavailable");
    expect(mapKyberFailureToActivityCode(statusError(ErrorCodes.KYBER_RATE_LIMITED))).toBe("venue_unavailable");
    expect(mapKyberFailureToActivityCode(statusError(ErrorCodes.KYBER_UNREACHABLE))).toBe("venue_unavailable");
  });

  it("keeps a status-less KYBER_API_ERROR on unknown - it is not availability evidence", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_API_ERROR))).toBe("unknown");
  });
});

describe("deriveKyberRevealFailure", () => {
  it("derives chain_unsupported without needing a raw code", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN), false)).toEqual({
      kind: "chain_unsupported",
    });
  });

  it("derives kyber_code with the RAW numeric code from externalName", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_ROUTE_NOT_FOUND, "4008"), false)).toEqual({
      kind: "kyber_code",
      code: 4008,
      tokenInputsValidated: false,
    });
  });

  it("threads tokenInputsValidated through unchanged for a 4011", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_TOKEN_NOT_FOUND, "4011"), true)).toEqual({
      kind: "kyber_code",
      code: 4011,
      tokenInputsValidated: true,
    });
  });

  // This pin used to encode "an API error never reveals". It now encodes "an
  // API error reveals only when it carries an availability status": a bare
  // KYBER_API_ERROR is ALSO the shape of `verifyRouterAddress`'s build-
  // integrity abort and of the response-schema validators, neither of which
  // is evidence about the venue's availability.
  it("returns null for a KYBER_API_ERROR carrying neither a raw code nor a status", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_API_ERROR), false)).toBeNull();
  });

  it("derives venue_unavailable for a KYBER_API_ERROR that DOES carry an availability status", () => {
    expect(deriveKyberRevealFailure(statusError(ErrorCodes.KYBER_API_ERROR, 403), false))
      .toEqual({ kind: "venue_unavailable", reason: "edge_refused" });
  });

  it("returns null for a non-VexError throw", () => {
    expect(deriveKyberRevealFailure(new Error("network down"), false)).toBeNull();
  });
});
