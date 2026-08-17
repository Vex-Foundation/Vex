/**
 * The Merkl error contract.
 *
 * Every case below carries a REAL body captured from the live API on
 * 2026-08-14, because the whole point of the contract is that the provider's own
 * words survive to the agent. A test that asserted over an invented body would
 * pass while the real failure still arrived as a bare status.
 */

import { describe, it, expect } from "vitest";

import { VexError, ErrorCodes } from "../../errors.js";
import { mapMerklHttpError, readMerklErrorMessage, sanitizeMerklCause } from "@tools/merkl/errors.js";

/** Live: `GET /v4/users/{address}/rewards` with `chainId` omitted. */
const VALIDATION_BODY = {
  type: "/errors/validation",
  title: "Validation Error",
  status: 400,
  detail: "Validation failed",
  instance: "/v4/users/0x0d3594751F3dc1e0FbD8879660D0A4343a822F28/rewards",
  errors: { type: "validation", on: "query", found: { breakdownPage: 0 } },
};

/** Live: a route that does not exist. */
const NOT_FOUND_BODY = {
  type: "/errors/not-found",
  title: "Not Found",
  status: 404,
  detail: "Route not found",
  instance: "/v4/opportunities/8453/ERC20LOGPROCESSOR/0x91C0/leaderboard",
};

describe("merkl error cause extraction", () => {
  it("puts the machine-readable `type` FIRST so it survives the length cap", () => {
    expect(readMerklErrorMessage(VALIDATION_BODY).startsWith("/errors/validation")).toBe(true);
  });

  it("carries the provider's own words rather than a Vex-authored guess", () => {
    const cause = readMerklErrorMessage(VALIDATION_BODY);
    expect(cause).toContain("Validation Error");
    expect(cause).toContain("Validation failed");
    expect(cause).toContain("breakdownPage");
  });

  it("treats a bare STRING body as evidence rather than dropping it", () => {
    expect(readMerklErrorMessage("upstream connect error")).toBe("upstream connect error");
  });

  it("treats a body missing every expected field as evidence, not as silence", () => {
    expect(readMerklErrorMessage({ unexpected: "shape", errors: ["a"] })).toContain("a");
  });

  it("scrubs urls, auth fragments and long hex without hiding the sentence", () => {
    const scrubbed = sanitizeMerklCause(
      "failed calling https://api.merkl.xyz/v4 with api_key=sk-secret for 0xabcdefabcdefabcdefabcdef",
    );
    expect(scrubbed).toContain("failed calling");
    expect(scrubbed).not.toContain("sk-secret");
    expect(scrubbed).not.toContain("api.merkl.xyz");
    expect(scrubbed).not.toContain("abcdefabcdefabcdef");
  });
});

describe("merkl status classification", () => {
  it("classifies status-FIRST and preserves httpStatus on the error", () => {
    const err = mapMerklHttpError(400, VALIDATION_BODY);
    expect(err).toBeInstanceOf(VexError);
    expect(err.code).toBe(ErrorCodes.MERKL_API_ERROR);
    expect(err.httpStatus).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("/errors/validation");
  });

  it("names the one-chain-per-request rule as the 400 remediation", () => {
    expect(mapMerklHttpError(400, VALIDATION_BODY).hint).toContain("one chain per request");
  });

  it("says a 404 is a route fault, distinct from an empty wallet", () => {
    const err = mapMerklHttpError(404, NOT_FOUND_BODY);
    expect(err.message).toContain("Route not found");
    expect(err.hint).toContain("empty list");
    expect(err.retryable).toBe(false);
  });

  it("blames OUR fan-out on a 429, because Merkl publishes a generous limit", () => {
    const err = mapMerklHttpError(429, {}, 30);
    expect(err.code).toBe(ErrorCodes.MERKL_RATE_LIMITED);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.hint).toContain("4,200");
    expect(err.hint).toContain("30-second");
  });

  it("marks a 5xx retryable and refuses to report unknown rewards as zero", () => {
    const err = mapMerklHttpError(503, "upstream unavailable");
    expect(err.retryable).toBe(true);
    expect(err.hint).toContain("rather than as zero");
  });
});
