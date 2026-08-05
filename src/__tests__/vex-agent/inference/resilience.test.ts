import { describe, it, expect } from "vitest";
import {
  retryWithBackoff,
  isRetryableError,
} from "../../../vex-agent/inference/resilience.js";

describe("retryWithBackoff", () => {
  it("returns on first success", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => { calls++; return "ok"; },
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on failure and succeeds", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "recovered";
      },
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("throws after exhausting retries", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => { calls++; throw new Error("persistent"); },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("persistent");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("respects shouldRetry predicate", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => { calls++; throw new Error("non-retryable"); },
        {
          maxRetries: 5,
          baseDelayMs: 1,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("non-retryable");
    expect(calls).toBe(1); // no retries
  });

  it("applies jitter when enabled", async () => {
    let calls = 0;
    const start = Date.now();
    await expect(
      retryWithBackoff(
        async () => { calls++; throw new Error("fail"); },
        { maxRetries: 1, baseDelayMs: 10, jitter: true },
      ),
    ).rejects.toThrow("fail");
    const elapsed = Date.now() - start;
    // With jitter, delay should be at least baseDelayMs but bounded
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect(calls).toBe(2);
  });
});

describe("isRetryableError", () => {
  it("returns false for AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isRetryableError(err)).toBe(false);
  });

  it("returns true for ETIMEDOUT", () => {
    const err = new Error("timeout") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    const err = new Error("reset") as NodeJS.ErrnoException;
    err.code = "ECONNRESET";
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    const err = new Error("refused") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for 502", () => {
    expect(isRetryableError(new Error("returned 502"))).toBe(true);
  });

  it("returns true for 503", () => {
    expect(isRetryableError(new Error("returned 503"))).toBe(true);
  });

  it("returns true for 429", () => {
    expect(isRetryableError(new Error("returned 429"))).toBe(true);
  });

  it("returns true for generic 5xx", () => {
    expect(isRetryableError(new Error("returned 500"))).toBe(true);
  });

  it("returns false for 400", () => {
    expect(isRetryableError(new Error("returned 400"))).toBe(false);
  });

  it("returns false for 401", () => {
    expect(isRetryableError(new Error("returned 401"))).toBe(false);
  });

  it("returns false for 404", () => {
    expect(isRetryableError(new Error("returned 404"))).toBe(false);
  });

  it("returns true for unknown errors (conservative)", () => {
    expect(isRetryableError(new Error("something unexpected"))).toBe(true);
  });
});
