/**
 * pools.fun error mapping, driven by the real error bodies the provider sent.
 *
 * The 400 case is the important one: the provider's own zod text names the
 * parameter and lists every accepted value, and surfacing it verbatim is what
 * turns a burnt call into a corrected one. The 502 case is the second: a
 * not-found wearing a server-error status must not be reported as "the
 * launchpad is broken", because the remedy is entirely different.
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import { mapPoolsFunError, mapTransportError } from "@tools/pools-fun/errors.js";
import { errorCapture, htmlCapture, CAPTURES } from "./_captures.js";

describe("mapPoolsFunError - HTTP 400 invalid parameters", () => {
  const capture = errorCapture(CAPTURES.discoverInvalidSortBy);
  const err = mapPoolsFunError(capture.httpStatus!, JSON.stringify(capture.response));

  it("is a non-retryable POOLS_INVALID_REQUEST", () => {
    expect(err.code).toBe(ErrorCodes.POOLS_INVALID_REQUEST);
    expect(err.retryable).toBeFalsy();
  });

  it("surfaces the provider's own detail as a `path: message` pair", () => {
    expect(err.hint).toContain("sortBy:");
    // The listed alternatives are the whole value of the message - an agent
    // that reads them can fix the call on the next turn.
    expect(err.hint).toContain("marketCapUsd");
  });

  it("bounds the detail text so a chattier provider cannot flood the agent", () => {
    const many = JSON.stringify({
      error: "Invalid parameters",
      details: Array.from({ length: 20 }, (_v, i) => ({ message: "x".repeat(300), path: [`p${i}`] })),
    });
    const bounded = mapPoolsFunError(400, many);
    expect((bounded.hint ?? "").length).toBeLessThan(260);
  });
});

describe("mapPoolsFunError - the launch endpoints' OTHER 400 shapes", () => {
  /**
   * Both bodies below are real, and NEITHER carries `details[]`. A mapper that
   * reads only `details[]` renders them as "the launchpad rejected a parameter
   * but named no detail" - a diagnosable money-path refusal reported as a
   * generic one, which is what sends an agent back to retry the same call.
   */
  it("names the insufficient dev-buy balance and what to do about it", () => {
    const capture = errorCapture(CAPTURES.prepareInsufficientDevBuy);
    const err = mapPoolsFunError(capture.httpStatus!, JSON.stringify(capture.response));

    expect(err.code).toBe(ErrorCodes.POOLS_INVALID_REQUEST);
    expect(err.hint).not.toContain("named no detail");
    expect(err.hint).toContain("prebuy");
    expect(err.hint).toMatch(/fund the wallet/i);
  });

  it("names an unresolvable X fee recipient as the handle's problem, not a parameter's", () => {
    const capture = errorCapture(CAPTURES.prepareXUnresolvable);
    const err = mapPoolsFunError(capture.httpStatus!, JSON.stringify(capture.response));

    expect(err.code).toBe(ErrorCodes.POOLS_INVALID_REQUEST);
    expect(err.hint).not.toContain("named no detail");
    expect(err.hint).toMatch(/X handle/);
    expect(err.hint).toMatch(/wallet address/);
  });

  it("still surfaces the provider's sentence for an UNKNOWN bare-error 400", () => {
    const err = mapPoolsFunError(400, JSON.stringify({ error: "Symbol is already taken on this chain." }));
    expect(err.hint).toContain("Symbol is already taken on this chain.");
  });

  it("names an unclassified machine code rather than dropping it", () => {
    const err = mapPoolsFunError(400, JSON.stringify({ error: "nope", code: "SOME_NEW_CODE" }));
    expect(err.hint).toContain("SOME_NEW_CODE");
  });

  it("prefers the zod details when the provider sends both a code and details", () => {
    const err = mapPoolsFunError(400, JSON.stringify({
      error: "Invalid parameters",
      code: "UNCLASSIFIED",
      details: [{ message: "Invalid option", path: ["sortBy"] }],
    }));
    expect(err.hint).toContain("sortBy: Invalid option");
  });

  it("scrubs and bounds a bare 400 error field like every other provider string", () => {
    const err = mapPoolsFunError(400, JSON.stringify({
      error: `Authorization: Bearer POOLS_CANARY_7f3b9c2e see https://evil.example ${"z".repeat(500)}`,
    }));
    expect(`${err.message} ${err.hint ?? ""}`).not.toContain("POOLS_CANARY_7f3b9c2e");
    expect(`${err.message} ${err.hint ?? ""}`).not.toContain("evil.example");
    expect((err.hint ?? "").length).toBeLessThan(260);
  });
});

describe("mapPoolsFunError - HTTP 502 upstream pool resolution", () => {
  const capture = errorCapture(CAPTURES.ohlcvUnknownToken);
  const err = mapPoolsFunError(capture.httpStatus!, JSON.stringify(capture.response));

  it("maps the measured upstream body to a NAMED not-found, not a server fault", () => {
    expect(err.code).toBe(ErrorCodes.POOLS_NOT_FOUND);
    expect(err.message).toContain("no pool");
  });

  it("still reports an unrecognised 502 as an API error", () => {
    const other = mapPoolsFunError(502, JSON.stringify({ error: "something else entirely" }));
    expect(other.code).toBe(ErrorCodes.POOLS_API_ERROR);
  });
});

describe("mapPoolsFunError - HTTP 404 HTML route drift", () => {
  const capture = htmlCapture();
  const err = mapPoolsFunError(capture.httpStatus, capture.bodyText);

  it("maps an HTML body to POOLS_API_ERROR with a bounded single-line snippet", () => {
    expect(err.code).toBe(ErrorCodes.POOLS_API_ERROR);
    expect(err.hint).not.toContain("\n");
    expect((err.hint ?? "").length).toBeLessThan(220);
    expect(err.hint).toContain("Cannot GET");
  });
});

describe("adversarial provider bodies never reach the agent raw", () => {
  /**
   * The failure this suite exists for: the top-level `error` string used to be
   * passed to `VexError.hint` with no scrub and no cap, because the shapes we
   * had MEASURED were harmless. Codex reproduced a 594-character output with a
   * bearer-token canary intact. "We have seen what this field contains" is not
   * a security property - an upstream that echoes a request header into its
   * error body is all it takes.
   */
  const CANARY = "POOLS_CANARY_7f3b9c2e";

  /** Everything an agent would actually be shown for this failure. */
  function agentText(status: number, body: string): string {
    const err = mapPoolsFunError(status, body);
    return `${err.message} ${err.hint ?? ""}`;
  }

  it.each([
    [
      "a bearer token in the error field",
      JSON.stringify({ error: `upstream said Authorization: Bearer ${CANARY}` }),
    ],
    [
      "a bearer token inside a validation detail",
      JSON.stringify({
        error: "Invalid parameters",
        details: [{ message: `bad token: Bearer ${CANARY}`, path: ["sortBy"] }],
      }),
    ],
    [
      "a secret assignment in the error field",
      JSON.stringify({ error: `retry with api_key=${CANARY}` }),
    ],
    [
      "a canary hidden in a detail PATH rather than its message",
      JSON.stringify({
        error: "Invalid parameters",
        details: [{ message: "nope", path: [`Bearer ${CANARY}`] }],
      }),
    ],
  ])("scrubs %s", (_label, body) => {
    expect(agentText(400, body)).not.toContain(CANARY);
    expect(agentText(500, body)).not.toContain(CANARY);
  });

  it("collapses a URL in the error field rather than quoting it", () => {
    const text = agentText(500, JSON.stringify({ error: "see https://evil.example/steal?t=abc" }));
    expect(text).not.toContain("evil.example");
    expect(text).toContain("[url]");
  });

  it("removes a long hex blob instead of echoing calldata at the agent", () => {
    const blob = `0x${"ab".repeat(80)}`;
    const text = agentText(500, JSON.stringify({ error: `reverted with ${blob}` }));
    expect(text).not.toContain(blob);
  });

  it("bounds an oversized error field (over 1kB) to a readable hint", () => {
    const huge = "z".repeat(2000);
    const err = mapPoolsFunError(500, JSON.stringify({ error: huge }));
    expect((err.hint ?? "").length).toBeLessThan(200);
  });

  it("bounds a flood of oversized validation details", () => {
    const err = mapPoolsFunError(400, JSON.stringify({
      error: "Invalid parameters",
      details: Array.from({ length: 50 }, (_v, i) => ({
        message: "y".repeat(500),
        path: ["p".repeat(200), i],
      })),
    }));
    expect((err.hint ?? "").length).toBeLessThan(260);
  });

  it("flattens control characters and newlines so no hint is multi-line", () => {
    const err = mapPoolsFunError(500, JSON.stringify({ error: "line one\nline two \ttail" }));
    expect(err.hint).not.toContain("\n");
    expect(err.hint).not.toContain(" ");
  });

  it("bounds an HTML body on a non-404 status too", () => {
    const html = `<!DOCTYPE html><html><body><pre>Bearer ${CANARY}</pre></body></html>`;
    const err = mapPoolsFunError(503, html);
    expect(`${err.message} ${err.hint ?? ""}`).not.toContain(CANARY);
    expect((err.hint ?? "").length).toBeLessThan(200);
  });
});

describe("mapTransportError", () => {
  it("passes an already-mapped POOLS_ error through unchanged", () => {
    const original = new VexError(ErrorCodes.POOLS_NOT_FOUND, "nope");
    expect(() => mapTransportError(original)).toThrow(original);
  });

  it("re-tags a shared HTTP_TIMEOUT as POOLS_TIMEOUT (retryable)", () => {
    try {
      mapTransportError(new VexError(ErrorCodes.HTTP_TIMEOUT, "timed out"));
      expect.unreachable("mapTransportError always throws");
    } catch (err) {
      expect((err as VexError).code).toBe(ErrorCodes.POOLS_TIMEOUT);
      expect((err as VexError).retryable).toBe(true);
    }
  });

  it("re-tags a shared HTTP_REQUEST_FAILED as POOLS_API_ERROR", () => {
    try {
      mapTransportError(new VexError(ErrorCodes.HTTP_REQUEST_FAILED, "conn refused"));
      expect.unreachable("mapTransportError always throws");
    } catch (err) {
      expect((err as VexError).code).toBe(ErrorCodes.POOLS_API_ERROR);
    }
  });
});
