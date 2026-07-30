/**
 * Backoff policy for capacity retries.
 *
 * The PARSING of `Retry-After` (ms-first precedence, the negative-ms
 * fall-through, HTTP-date, bounds) is already pinned by
 * `openrouter-error-taxonomy.test.ts`; this file pins what the failover DOES
 * with the parsed value — in particular the null case, which the live probe
 * showed is the common one on a real 429 (neither header spelling present).
 */

import { describe, it, expect } from "vitest";

import {
  BASE_RETRY_DELAY_MS,
  MAX_HONOURED_RETRY_AFTER_SECONDS,
  MAX_RETRY_DELAY_MS,
  nextRetryDelayMs,
} from "@vex-agent/inference/openrouter/endpoint-failover/retry-policy.js";

describe("nextRetryDelayMs — no provider hint (the LIVE 429 case)", () => {
  it("uses its own bounded exponential backoff rather than refusing to retry", () => {
    expect(nextRetryDelayMs(1, null)).toBe(BASE_RETRY_DELAY_MS);
    expect(nextRetryDelayMs(2, null)).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(nextRetryDelayMs(3, null)).toBe(BASE_RETRY_DELAY_MS * 4);
  });

  it("never grows past the ceiling", () => {
    expect(nextRetryDelayMs(50, null)).toBe(MAX_RETRY_DELAY_MS);
  });
});

describe("nextRetryDelayMs — provider hint present", () => {
  it("honours the hint verbatim in preference to the local schedule", () => {
    expect(nextRetryDelayMs(1, 4)).toBe(4_000);
    // Even when the local schedule would have waited LESS.
    expect(nextRetryDelayMs(1, MAX_HONOURED_RETRY_AFTER_SECONDS)).toBe(
      MAX_HONOURED_RETRY_AFTER_SECONDS * 1_000,
    );
  });

  it("returns null for a wait longer than we will hold a turn for", () => {
    // The caller reads null as "do not sleep on this endpoint" — a user waiting
    // on a chat turn is better served by an error (or a switch) than by a
    // 41-second stall, which is a real value this provider advertises.
    expect(nextRetryDelayMs(1, MAX_HONOURED_RETRY_AFTER_SECONDS + 1)).toBeNull();
    expect(nextRetryDelayMs(1, 41)).toBeNull();
  });
});
