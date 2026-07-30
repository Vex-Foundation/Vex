/**
 * `classifyEngineError` — the owner's complaint, pinned.
 *
 * Verbatim: three harness runs died on provider 429s, and in the desktop app
 * that user would have seen "Unable to process the message." and nothing else.
 * The real cause — a pinned endpoint turning a rate limit into a hard wall —
 * was invisible.
 *
 * So the bar here is behavioural, not structural: a 429 must produce specific,
 * actionable copy, and `internal.unexpected` must be reachable ONLY when
 * nothing at all is known. Both the wrapped (`MissionRunPausedError`-shaped)
 * and raw thrown shapes are covered, because which one reaches `chat.submit`
 * was an open question and the reader answers it by handling both.
 */

import { describe, expect, it } from "vitest";
import { classifyEngineError } from "../chat/engine-failure-copy.js";

const CORR = "corr-1";

/** A raw normalized provider error: lean own-properties, no `.cause`. */
function rawError(signals: Record<string, unknown>): Error {
  const err = new Error("OpenRouter chat completion failed: status=429 | rate limited");
  for (const [key, value] of Object.entries(signals)) {
    Object.defineProperty(err, key, { value, enumerable: false, configurable: true });
  }
  return err;
}

/** The wrapped shape: `MissionRunPausedError` re-copies the same field names. */
function wrappedError(signals: Record<string, unknown>): Error {
  const err = new Error("run paused");
  err.name = "MissionRunPausedError";
  Object.assign(err, signals);
  return err;
}

describe("classifyEngineError — the 429 that started this", () => {
  it("names the rate limit AND the provider's retry hint", () => {
    const vexError = classifyEngineError(
      rawError({ statusCode: 429, errorType: "rate_limit_exceeded", retryAfterSeconds: 41 }),
      CORR,
    );
    expect(vexError.code).toBe("provider.unavailable");
    expect(vexError.retryable).toBe(true);
    expect(vexError.message).toContain("41s");
    expect(vexError.message).not.toBe("Unable to process the message.");
  });

  it("falls back to generic transient copy when no hint was sent", () => {
    const vexError = classifyEngineError(rawError({ statusCode: 429 }), CORR);
    expect(vexError.code).toBe("provider.unavailable");
    expect(vexError.message).toContain("temporarily unavailable");
  });

  it("reads the same signals off the WRAPPED error shape", () => {
    const vexError = classifyEngineError(
      wrappedError({ statusCode: 429, errorType: "rate_limit_exceeded", retryAfterSeconds: 7 }),
      CORR,
    );
    expect(vexError.message).toContain("7s");
  });
});

describe("classifyEngineError — category copy", () => {
  it("separates out-of-credit from a bad key inside the account category", () => {
    expect(classifyEngineError(rawError({ statusCode: 402 }), CORR).code).toBe(
      "provider.insufficient_credits",
    );
    expect(
      classifyEngineError(rawError({ errorType: "payment_required" }), CORR).code,
    ).toBe("provider.insufficient_credits");
    expect(classifyEngineError(rawError({ statusCode: 401 }), CORR).code).toBe(
      "provider.invalid_api_key",
    );
    expect(
      classifyEngineError(rawError({ errorType: "permission_denied" }), CORR).code,
    ).toBe("provider.invalid_api_key");
  });

  it("points a context overflow at compaction, not at a generic failure", () => {
    const vexError = classifyEngineError(
      rawError({ errorType: "context_length_exceeded" }),
      CORR,
    );
    expect(vexError.message).toContain("Compact");
    expect(vexError.userActionable).toBe(true);
  });

  it("says a content refusal is a refusal", () => {
    const vexError = classifyEngineError(
      rawError({ errorType: "content_policy_violation" }),
      CORR,
    );
    expect(vexError.message).toContain("content-policy");
  });

  it("names an unusable image instead of blaming the request", () => {
    const vexError = classifyEngineError(rawError({ errorType: "image_too_large" }), CORR);
    expect(vexError.message).toContain("image");
  });

  it("distinguishes an unreadable response — its only signal is the class name", () => {
    const vexError = classifyEngineError(
      rawError({ errorClass: "SDKValidationError" }),
      CORR,
    );
    expect(vexError.code).toBe("provider.unavailable");
    expect(vexError.message).toContain("could not be read");
  });

  it("treats a status-less transport failure as transient", () => {
    expect(
      classifyEngineError(rawError({ errorClass: "ConnectionError" }), CORR).code,
    ).toBe("provider.unavailable");
    expect(classifyEngineError(rawError({ causeCode: "ECONNRESET" }), CORR).code).toBe(
      "provider.unavailable",
    );
  });

  it("still reports the provider-missing case unchanged", () => {
    const vexError = classifyEngineError(
      new Error("No inference provider available"),
      CORR,
    );
    expect(vexError.code).toBe("provider.unavailable");
    expect(vexError.message).toContain("provider setup");
  });
});

describe("classifyEngineError — the generic message is now a LAST resort", () => {
  it("is reached only when nothing at all is known", () => {
    expect(classifyEngineError(new Error("mystery"), CORR).message).toBe(
      "Unable to process the message.",
    );
    expect(classifyEngineError(rawError({ errorType: "unmapped" }), CORR).message).toBe(
      "Unable to process the message.",
    );
  });

  it("is NOT reached for any of the failures that used to land there", () => {
    const previouslyGeneric = [
      { errorType: "provider_overloaded" },
      { errorType: "invalid_prompt" },
      { errorType: "refusal" },
      { errorType: "token_limit_exceeded" },
      { errorClass: "ResponseValidationError" },
      { errorClass: "RequestTimeoutError" },
      { statusCode: 418 },
      { statusCode: 507 },
    ];
    for (const signals of previouslyGeneric) {
      const vexError = classifyEngineError(rawError(signals), CORR);
      expect(vexError.message, JSON.stringify(signals)).not.toBe(
        "Unable to process the message.",
      );
    }
  });

  it("never leaks the provider message into the user-facing copy", () => {
    const err = rawError({ statusCode: 429 });
    const vexError = classifyEngineError(err, CORR);
    expect(vexError.message).not.toContain("OpenRouter");
    expect(vexError.redacted).toBe(true);
  });
});
