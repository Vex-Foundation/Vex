import { describe, expect, it } from "vitest";
import { mapDexScreenerError, mapTransportError } from "@tools/dexscreener/errors.js";
import { VexError, ErrorCodes } from "../../errors.js";

describe("mapDexScreenerError", () => {
  it("maps 429 to DEXSCREENER_RATE_LIMITED", () => {
    const error = mapDexScreenerError(429);
    expect(error.code).toBe(ErrorCodes.DEXSCREENER_RATE_LIMITED);
  });

  it("marks 429 as retryable", () => {
    const error = mapDexScreenerError(429);
    expect(error.retryable).toBe(true);
  });

  it("maps 404 to DEXSCREENER_NOT_FOUND", () => {
    const error = mapDexScreenerError(404);
    expect(error.code).toBe(ErrorCodes.DEXSCREENER_NOT_FOUND);
  });

  it("maps 500 to DEXSCREENER_API_ERROR", () => {
    const error = mapDexScreenerError(500);
    expect(error.code).toBe(ErrorCodes.DEXSCREENER_API_ERROR);
  });

  it("marks 500 as retryable", () => {
    const error = mapDexScreenerError(500);
    expect(error.retryable).toBe(true);
  });

  it("maps 502 to DEXSCREENER_API_ERROR (server error family)", () => {
    const error = mapDexScreenerError(502);
    expect(error.code).toBe(ErrorCodes.DEXSCREENER_API_ERROR);
    expect(error.retryable).toBe(true);
  });

  it("maps 400 to DEXSCREENER_API_ERROR (generic)", () => {
    const error = mapDexScreenerError(400);
    expect(error.code).toBe(ErrorCodes.DEXSCREENER_API_ERROR);
  });

  // W2f: the body no longer REPLACES the message. It used to, which dropped the
  // status digits our own classifier was reading — so a body-carrying 429 lost
  // the one token that made it classify as a rate limit.
  it("appends the provider body to the status line, never replacing it", () => {
    const error = mapDexScreenerError(429, { error: "Too many requests" });
    expect(error.message).toBe("DexScreener API returned HTTP 429: Too many requests");
  });

  it("uses default message when none provided", () => {
    const error = mapDexScreenerError(500);
    expect(error.message).toContain("HTTP 500");
  });

  it("stamps httpStatus on every mapped error", () => {
    for (const status of [400, 404, 429, 500, 503]) {
      expect(mapDexScreenerError(status).httpStatus).toBe(status);
    }
  });

  // The live 400 body is a JSON STRING (an HTML "400 Bad Request" page), not an
  // object with `error`. The old reader tested `typeof raw === "object"` and
  // threw the cause away.
  it("surfaces a JSON-STRING body (the live 400 shape)", () => {
    const error = mapDexScreenerError(400, "<html>\n <head>\n <title>400 Bad Request</title>\n </head>\n</html>");
    expect(error.httpStatus).toBe(400);
    expect(error.message).toContain("HTTP 400");
    expect(error.message).toContain("400 Bad Request");
  });

  it("bounds the surfaced body and redacts secret shapes", () => {
    const secret = "sk-ant-abcdef0123456789abcdef0123456789";
    const error = mapDexScreenerError(400, `${secret} ${"y".repeat(500)}`);
    expect(error.message).not.toContain(secret);
    expect(error.message.length).toBeLessThan(320);
  });

  it("gives a 4xx a hint that points at the caller's own parameters", () => {
    expect(mapDexScreenerError(400).hint ?? "").toContain("refused the request itself");
  });

  it("reads `message` and `detail` bodies as well as `error`", () => {
    expect(mapDexScreenerError(422, { message: "bad query" }).message).toContain("bad query");
    expect(mapDexScreenerError(422, { detail: "bad query" }).message).toContain("bad query");
  });

  it("says only the status when the response carried no body", () => {
    expect(mapDexScreenerError(404, null).message).toBe("DexScreener API returned HTTP 404");
  });
});

describe("mapTransportError", () => {
  it("re-throws DEXSCREENER_* errors as-is", () => {
    const original = new VexError(ErrorCodes.DEXSCREENER_RATE_LIMITED, "rate limited");
    expect(() => mapTransportError(original)).toThrow(original);
  });

  it("maps HTTP_TIMEOUT to DEXSCREENER_TIMEOUT", () => {
    const original = new VexError(ErrorCodes.HTTP_TIMEOUT, "timed out");
    try {
      mapTransportError(original);
    } catch (err) {
      expect(err).toMatchObject({ code: ErrorCodes.DEXSCREENER_TIMEOUT });
      return;
    }
    expect.fail("should have thrown");
  });

  it("maps HTTP_REQUEST_FAILED to DEXSCREENER_API_ERROR", () => {
    const original = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, "connection refused");
    try {
      mapTransportError(original);
    } catch (err) {
      expect(err).toMatchObject({ code: ErrorCodes.DEXSCREENER_API_ERROR });
      return;
    }
    expect.fail("should have thrown");
  });

  it("re-throws unknown errors", () => {
    const original = new Error("something else");
    expect(() => mapTransportError(original)).toThrow(original);
  });
});
