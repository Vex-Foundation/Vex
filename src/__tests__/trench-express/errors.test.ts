/**
 * Trench Express error mapping: bounded sanitization of leaked provider text and
 * transport-error re-tagging.
 */

import { describe, expect, it } from "vitest";

import { VexError, ErrorCodes } from "../../errors.js";
import { mapTransportError, mapTrenchExpressError } from "@tools/trench-express/errors.js";

describe("mapTrenchExpressError", () => {
  it("maps 5xx to a non-retryable TRENCH_INVALID_REQUEST with a bounded single-line snippet", () => {
    const leaked = "TypeError: null is not an object (evaluating 'params.token')\n at x\n at y".repeat(4);
    const err = mapTrenchExpressError(500, leaked);
    expect(err.code).toBe(ErrorCodes.TRENCH_INVALID_REQUEST);
    expect(err.retryable).toBeFalsy();
    expect(err.hint).not.toContain("\n");
    // 100-char snippet + "Provider detail: " prefix + ellipsis, still bounded.
    expect((err.hint ?? "").length).toBeLessThan(140);
  });

  it("maps a 4xx-ish other status to TRENCH_API_ERROR", () => {
    const err = mapTrenchExpressError(418, "");
    expect(err.code).toBe(ErrorCodes.TRENCH_API_ERROR);
  });

  it("maps 404 to TRENCH_NOT_FOUND", () => {
    expect(mapTrenchExpressError(404).code).toBe(ErrorCodes.TRENCH_NOT_FOUND);
  });
});

describe("mapTransportError", () => {
  it("passes an already-mapped TRENCH_ error through unchanged", () => {
    const original = new VexError(ErrorCodes.TRENCH_NOT_FOUND, "nope");
    expect(() => mapTransportError(original)).toThrow(original);
  });

  it("re-tags a shared HTTP_TIMEOUT as TRENCH_TIMEOUT (retryable)", () => {
    const t = new VexError(ErrorCodes.HTTP_TIMEOUT, "timed out");
    try {
      mapTransportError(t);
    } catch (err) {
      const ve = err as VexError;
      expect(ve.code).toBe(ErrorCodes.TRENCH_TIMEOUT);
      expect(ve.retryable).toBe(true);
    }
  });

  it("re-tags a shared HTTP_REQUEST_FAILED as TRENCH_API_ERROR", () => {
    const t = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, "conn refused");
    try {
      mapTransportError(t);
    } catch (err) {
      expect((err as VexError).code).toBe(ErrorCodes.TRENCH_API_ERROR);
    }
  });
});
