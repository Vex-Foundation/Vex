/**
 * A2 — the bounded ladder that ends the permanent 60s warn loop.
 *
 * Live evidence: `launch_form_expiry.resume_failed status=400` for one
 * intent, every sweep, forever, because the sweep had no memory of having
 * already tried. Each case below uses its own intent id — the policy's memory
 * is deliberately process-wide, exactly as it is in production.
 */

import { describe, expect, it } from "vitest";

import {
  forgetContinuation,
  isContinuationDue,
  noteContinuationFailure,
  type ContinuationPromptFacts,
} from "@vex-agent/sync/launch-form-expiry/continuation-retry.js";

const PROMPT: ContinuationPromptFacts = { resultMessageId: 42, status: "expired" };
const TRANSIENT = { deterministic: false, signature: "busy" } as const;
const REFUSAL = { deterministic: true, signature: "invalid_request/400" } as const;

describe("the retry ladder", () => {
  it("treats a continuation it has never failed on as due", () => {
    expect(isContinuationDue("never-tried", 1_000)).toBe(true);
  });

  it("escalates 60s → 5min → dormant until the next app start", () => {
    const id = "ladder";
    const first = noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 0 });
    expect(first).toEqual({ kind: "retry_after", delayMs: 60_000 });

    const second = noteContinuationFailure({
      intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 60_000,
    });
    expect(second).toEqual({ kind: "retry_after", delayMs: 300_000 });

    const third = noteContinuationFailure({
      intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 360_000,
    });
    expect(third).toEqual({ kind: "dormant_until_restart" });
  });

  it("holds the row back until its rung comes round — the sweep does not retry every minute", () => {
    const id = "not-due-yet";
    noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 0 });

    expect(isContinuationDue(id, 59_999)).toBe(false);
    expect(isContinuationDue(id, 60_000)).toBe(true);
  });

  it("never becomes due again once dormant", () => {
    const id = "dormant";
    noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 0 });
    noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 60_000 });
    noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 360_000 });

    expect(isContinuationDue(id, 10 * 360_000)).toBe(false);
  });

  it("parks on the SAME deterministic refusal twice with an unchanged prompt", () => {
    const id = "deterministic";
    expect(
      noteContinuationFailure({ intentId: id, failure: REFUSAL, prompt: PROMPT, now: 0 }),
    ).toEqual({ kind: "retry_after", delayMs: 60_000 });

    expect(
      noteContinuationFailure({ intentId: id, failure: REFUSAL, prompt: PROMPT, now: 60_000 }),
    ).toEqual({ kind: "park", reason: "resume_failed_deterministic" });
  });

  it("does NOT park when the second refusal is a different one", () => {
    const id = "different-refusal";
    noteContinuationFailure({ intentId: id, failure: REFUSAL, prompt: PROMPT, now: 0 });

    const second = noteContinuationFailure({
      intentId: id,
      failure: { deterministic: true, signature: "auth/401" },
      prompt: PROMPT,
      now: 60_000,
    });

    // A new refusal is new evidence, not a confirmed dead end.
    expect(second).toEqual({ kind: "retry_after", delayMs: 300_000 });
  });

  it("does NOT park a repeated TRANSIENT failure — only the ladder applies", () => {
    const id = "repeat-transient";
    noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 0 });

    expect(
      noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 60_000 }),
    ).toEqual({ kind: "retry_after", delayMs: 300_000 });
  });

  it("restarts the ladder when the prompt changed — those refusals were a different request", () => {
    const id = "prompt-changed";
    noteContinuationFailure({ intentId: id, failure: REFUSAL, prompt: PROMPT, now: 0 });

    const second = noteContinuationFailure({
      intentId: id,
      failure: REFUSAL,
      prompt: { resultMessageId: 99, status: "expired" },
      now: 60_000,
    });

    expect(second).toEqual({ kind: "retry_after", delayMs: 60_000 });
  });

  it("forgets a delivered continuation so a later one starts clean", () => {
    const id = "forgotten";
    noteContinuationFailure({ intentId: id, failure: TRANSIENT, prompt: PROMPT, now: 0 });
    expect(isContinuationDue(id, 0)).toBe(false);

    forgetContinuation(id);

    expect(isContinuationDue(id, 0)).toBe(true);
  });
});
