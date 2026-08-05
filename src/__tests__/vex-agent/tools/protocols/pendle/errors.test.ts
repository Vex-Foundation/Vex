/**
 * Pendle money-path error contract (W2e).
 *
 * Two defects are pinned here, both of which made the agent retry a refusal it
 * could never satisfy:
 *
 *  1. Pendle's hosted API is NestJS, so a validation 400 arrives as an ARRAY
 *     `message` (`{"message":["timeFrame must be either hour, day or week"]}`).
 *     The mapper read `message` only when it was a string, so every
 *     parameter-level 400 in the namespace collapsed to *"Pendle rejected the
 *     request."* — no status, no field, no cause.
 *  2. 401/402/403/409/422 fell through to a bare `HTTP n` with NO hint at all,
 *     which is live-relevant now that Pendle sells API keys.
 *
 * `httpStatus` is asserted on every branch: it is the field the error contract
 * classifies on before it reads any prose.
 */

import { describe, expect, it } from "vitest";

import { mapPendleError, mapPendleTransportError, readPendleErrorMessage } from "@tools/pendle/errors.js";
import { ErrorCodes, VexError } from "../../../../../errors.js";

describe("readPendleErrorMessage", () => {
  it("reads the string shape", () => {
    expect(readPendleErrorMessage({ message: "token not found in list" })).toBe("token not found in list");
  });

  it("JOINS the NestJS array shape rather than dropping it", () => {
    expect(
      readPendleErrorMessage({
        message: ["timeFrame must be either hour, day or week", "chainId must be a number"],
        error: "Bad Request",
        statusCode: 400,
      }),
    ).toBe("timeFrame must be either hour, day or week; chainId must be a number");
  });

  it("falls back to `error` when `message` is absent, and to empty when neither is usable", () => {
    expect(readPendleErrorMessage({ error: "Bad Request" })).toBe("Bad Request");
    expect(readPendleErrorMessage({ message: [] })).toBe("");
    expect(readPendleErrorMessage(null)).toBe("");
    expect(readPendleErrorMessage("a plain string body")).toBe("");
  });

  it("bounds the copied text — a body is untrusted in LENGTH too", () => {
    const long = "x".repeat(5_000);
    const read = readPendleErrorMessage({ message: long });
    expect(read.length).toBeLessThanOrEqual(201);
    expect(read.endsWith("…")).toBe(true);
  });
});

describe("mapPendleError — 400 classification", () => {
  it("classifies an ARRAY-shaped validation 400 and carries every sentence", () => {
    const err = mapPendleError(400, {
      message: ["timeFrame must be either hour, day or week", "chainId must be a number"],
      error: "Bad Request",
      statusCode: 400,
    });

    expect(err.code).toBe(ErrorCodes.PENDLE_API_ERROR);
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain("timeFrame must be either hour, day or week");
    expect(err.message).toContain("chainId must be a number");
    expect(err.hint ?? "").not.toBe("");
  });

  it("routes an ARRAY-shaped body through the SAME keyword classification a string body gets", () => {
    const fromArray = mapPendleError(400, { message: ["The input valuation is too low. The minimum valuation is 0.01"] });
    const fromString = mapPendleError(400, { message: "The input valuation is too low. The minimum valuation is 0.01" });

    expect(fromArray.code).toBe(ErrorCodes.PENDLE_VALUATION_TOO_LOW);
    expect(fromArray.code).toBe(fromString.code);
    expect(fromArray.message).toContain("The minimum valuation is 0.01");
  });

  it("keeps the expired-market classification (the body carries no `error` field)", () => {
    const err = mapPendleError(400, { message: "Unable to classify convert action" });
    expect(err.code).toBe(ErrorCodes.PENDLE_MARKET_EXPIRED);
    expect(err.httpStatus).toBe(400);
  });
});

describe("mapPendleError — the previously hint-less statuses", () => {
  it.each([401, 402, 403, 409, 422])("gives HTTP %i a named hint and the status", (status) => {
    const err = mapPendleError(status, { message: "provider said why" });

    expect(err.httpStatus).toBe(status);
    expect(err.message).toContain(String(status));
    expect(err.message).toContain("provider said why");
    expect(err.hint ?? "").not.toBe("");
  });

  it("says an auth/payment refusal cannot be retried, and a 409 needs a fresh quote", () => {
    expect(mapPendleError(401, null).hint).toContain("Retrying cannot succeed");
    expect(mapPendleError(402, null).hint).toContain("Retrying cannot succeed");
    expect(mapPendleError(403, null).hint).toContain("Do not retry unchanged");
    expect(mapPendleError(409, null).hint).toContain("FRESH quote");
    expect(mapPendleError(422, null).hint).toContain("Fix the parameter");
  });

  it("still marks 429 and 5xx retryable, and stamps their status", () => {
    expect(mapPendleError(429, null)).toMatchObject({ code: ErrorCodes.PENDLE_RATE_LIMITED, httpStatus: 429, retryable: true });
    expect(mapPendleError(503, null)).toMatchObject({ code: ErrorCodes.PENDLE_API_ERROR, httpStatus: 503, retryable: true });
  });

  it("stamps httpStatus even on an unmapped status", () => {
    expect(mapPendleError(418, null).httpStatus).toBe(418);
  });
});

describe("mapPendleTransportError", () => {
  it("carries an observed httpStatus through the re-wrap", () => {
    const wrapped = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, "request failed");
    wrapped.httpStatus = 502;

    const thrown = ((): VexError => {
      try {
        mapPendleTransportError(wrapped);
      } catch (err) {
        return err as VexError;
      }
      throw new Error("unreachable");
    })();

    expect(thrown.code).toBe(ErrorCodes.PENDLE_API_ERROR);
    expect(thrown.httpStatus).toBe(502);
  });

  it("does NOT invent a status when none was observed", () => {
    const thrown = ((): VexError => {
      try {
        mapPendleTransportError(new VexError(ErrorCodes.HTTP_TIMEOUT, "timed out"));
      } catch (err) {
        return err as VexError;
      }
      throw new Error("unreachable");
    })();

    expect(thrown.code).toBe(ErrorCodes.PENDLE_TIMEOUT);
    expect(thrown.httpStatus).toBeUndefined();
  });
});
