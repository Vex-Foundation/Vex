/**
 * Error TAXONOMY capture — `errorClass`, `retryAfterSeconds`, `errorType`.
 *
 * `normalizeOpenRouterError` deliberately rebuilds a plain `Error` so nothing
 * can walk back to the raw body / headers / `userId`. That also destroys the
 * only discriminator six SDK error shapes have (`SDKValidationError` + the five
 * status-less transports) and throws away the `Retry-After` header — the most
 * useful, most bounded thing on the 429 that motivated the error channel.
 *
 * These tests pin that both are captured BEFORE the rebuild, as lean bounded
 * own-properties, and that re-normalization (a mid-stream rejection is
 * normalized twice) is lossless rather than silently erasing them.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeOpenRouterError,
  attachErrorClass,
  attachRetryAfterSeconds,
} from "../../../vex-agent/inference/openrouter/errors.js";
import {
  boundedErrorClass,
  OPENROUTER_ERROR_CLASSES,
} from "../../../vex-agent/inference/openrouter/error-class.js";
import { retryAfterSecondsFromHeaders } from "../../../vex-agent/inference/openrouter/retry-after.js";
import { readMissionErrorSignal } from "../../../vex-agent/engine/core/runner/mission-error-signal.js";

function field(err: Error, key: string): unknown {
  return (err as unknown as Record<string, unknown>)[key];
}

describe("boundedErrorClass — CLOSED dictionary", () => {
  it("covers the 24 concrete classes the installed SDK exports", () => {
    expect(OPENROUTER_ERROR_CLASSES.size).toBe(24);
  });

  it("admits a real SDK class name off a thrown value", () => {
    const err = new Error("boom");
    err.name = "TooManyRequestsResponseError";
    expect(boundedErrorClass(err)).toBe("TooManyRequestsResponseError");
  });

  it("rejects a name outside the dictionary — including plain `Error`", () => {
    expect(boundedErrorClass(new Error("boom"))).toBeNull();
    const spoof = new Error("boom");
    spoof.name = "TotallyLegitError";
    expect(boundedErrorClass(spoof)).toBeNull();
  });

  it("rejects non-Errors", () => {
    expect(boundedErrorClass("TooManyRequestsResponseError")).toBeNull();
    expect(boundedErrorClass(null)).toBeNull();
  });
});

describe("retryAfterSecondsFromHeaders — SDK precedence + bounds", () => {
  const headers = (map: Record<string, string>) => ({
    get: (name: string) => map[name] ?? null,
  });

  it("prefers `retry-after-ms` over `retry-after`, matching the SDK's own order", () => {
    // `esm/lib/retries.js:129-150` reads ms first; disagreeing would make our
    // advice contradict the SDK's internal retry timing.
    expect(
      retryAfterSecondsFromHeaders(
        headers({ "retry-after-ms": "41000", "retry-after": "999" }),
      ),
    ).toBe(41);
  });

  it("rounds a sub-second wait UP to 1 so `retry shortly` stays expressible", () => {
    expect(retryAfterSecondsFromHeaders(headers({ "retry-after-ms": "250" }))).toBe(1);
  });

  it("reads integer seconds from `retry-after`", () => {
    expect(retryAfterSecondsFromHeaders(headers({ "retry-after": "41" }))).toBe(41);
  });

  it("reads an HTTP-date `retry-after` relative to now", () => {
    const now = Date.parse("2026-07-29T10:00:00.000Z");
    expect(
      retryAfterSecondsFromHeaders(
        headers({ "retry-after": "Wed, 29 Jul 2026 10:00:30 GMT" }),
        now,
      ),
    ).toBe(30);
  });

  it("returns null for a PAST date rather than a misleading 0", () => {
    const now = Date.parse("2026-07-29T10:00:00.000Z");
    expect(
      retryAfterSecondsFromHeaders(
        headers({ "retry-after": "Wed, 29 Jul 2026 09:00:00 GMT" }),
        now,
      ),
    ).toBeNull();
  });

  it("falls back to the seconds header when `retry-after-ms` is unusable", () => {
    // The SDK accepts ms only when finite AND >= 0, then falls THROUGH
    // (`esm/lib/retries.js:130-136`). Returning early on a negative ms would
    // discard a perfectly good seconds header.
    expect(
      retryAfterSecondsFromHeaders(
        headers({ "retry-after-ms": "-1000", "retry-after": "30" }),
      ),
    ).toBe(30);
    expect(
      retryAfterSecondsFromHeaders(
        headers({ "retry-after-ms": "not-a-number", "retry-after": "30" }),
      ),
    ).toBe(30);
  });

  it("returns null when BOTH headers are unusable", () => {
    expect(
      retryAfterSecondsFromHeaders(
        headers({ "retry-after-ms": "-1000", "retry-after": "nonsense" }),
      ),
    ).toBeNull();
    expect(retryAfterSecondsFromHeaders(headers({ "retry-after-ms": "-1000" }))).toBeNull();
  });

  it("rejects an out-of-bounds hint — the UI must never say `retry in 3 million seconds`", () => {
    expect(retryAfterSecondsFromHeaders(headers({ "retry-after": "999999999" }))).toBeNull();
    expect(retryAfterSecondsFromHeaders(headers({ "retry-after": "-5" }))).toBeNull();
    expect(retryAfterSecondsFromHeaders(headers({ "retry-after": "soon" }))).toBeNull();
  });

  it("survives a missing / hostile headers object", () => {
    expect(retryAfterSecondsFromHeaders(null)).toBeNull();
    expect(retryAfterSecondsFromHeaders({})).toBeNull();
    expect(
      retryAfterSecondsFromHeaders({
        get: () => {
          throw new Error("hostile");
        },
      }),
    ).toBeNull();
  });
});

describe("normalizeOpenRouterError — taxonomy capture", () => {
  it("captures the class name and retry hint that the rebuild would destroy", () => {
    const raw = new Error("rate limited");
    raw.name = "TooManyRequestsResponseError";
    Object.assign(raw, {
      statusCode: 429,
      headers: { get: (n: string) => (n === "retry-after" ? "41" : null) },
    });

    const normalized = normalizeOpenRouterError(raw, "chat completion");
    // The rebuilt error is a plain Error — its own `name` says nothing.
    expect(normalized.name).toBe("Error");
    expect(field(normalized, "errorClass")).toBe("TooManyRequestsResponseError");
    expect(field(normalized, "retryAfterSeconds")).toBe(41);
    expect(field(normalized, "statusCode")).toBe(429);
  });

  it("attaches both as NON-ENUMERABLE own-properties, like the existing signals", () => {
    const err = attachRetryAfterSeconds(
      attachErrorClass(new Error("x"), "ConnectionError"),
      12,
    );
    expect(Object.keys(err)).not.toContain("errorClass");
    expect(Object.keys(err)).not.toContain("retryAfterSeconds");
    expect(JSON.stringify(err)).not.toContain("ConnectionError");
  });

  it("is LOSSLESS on re-normalization — the mid-stream path normalizes twice", () => {
    const raw = new Error("mid-stream");
    raw.name = "ConnectionError";
    const once = normalizeOpenRouterError(raw, "streaming chat completion");
    expect(field(once, "errorClass")).toBe("ConnectionError");

    const twice = normalizeOpenRouterError(once, "streaming chat completion (mid-stream)");
    expect(field(twice, "errorClass")).toBe("ConnectionError");
  });

  it("preserves an already-attached errorType through re-normalization", () => {
    const streamError = new Error("stream error");
    Object.defineProperty(streamError, "errorType", {
      value: "rate_limit_exceeded",
      enumerable: false,
      configurable: true,
    });
    const normalized = normalizeOpenRouterError(streamError, "mid-stream");
    expect(field(normalized, "errorType")).toBe("rate_limit_exceeded");
  });

  it("does not invent a class for an ordinary Error", () => {
    const normalized = normalizeOpenRouterError(new Error("plain"), "chat completion");
    expect(field(normalized, "errorClass")).toBeUndefined();
    expect(field(normalized, "retryAfterSeconds")).toBeUndefined();
  });
});

describe("readMissionErrorSignal — widened taxonomy", () => {
  it("reads errorType, errorClass and retryAfterSeconds off a thrown value", () => {
    const err = new Error("x");
    Object.assign(err, {
      statusCode: 429,
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      retryAfterSeconds: 41,
    });
    const signal = readMissionErrorSignal(err);
    expect(signal.errorType).toBe("rate_limit_exceeded");
    expect(signal.errorClass).toBe("TooManyRequestsResponseError");
    expect(signal.retryAfterSeconds).toBe(41);
  });

  it("re-validates rather than trusting — this reader sees arbitrary throws", () => {
    const err = new Error("x");
    Object.assign(err, {
      // A class outside the closed dictionary, and a nonsense retry hint.
      errorClass: "AttackerSuppliedClass",
      retryAfterSeconds: -1,
      errorType: "a".repeat(200),
    });
    const signal = readMissionErrorSignal(err);
    expect(signal.errorClass).toBeNull();
    expect(signal.retryAfterSeconds).toBeNull();
    expect(signal.errorType).toBeNull();
  });

  it("returns all-null for a non-Error", () => {
    const signal = readMissionErrorSignal("nope");
    expect(signal.errorType).toBeNull();
    expect(signal.errorClass).toBeNull();
    expect(signal.retryAfterSeconds).toBeNull();
  });
});
