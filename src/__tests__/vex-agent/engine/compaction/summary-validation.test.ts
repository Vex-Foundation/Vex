/**
 * Branch-A output acceptance.
 *
 * This is the only barrier between model text and durable prompt content, so
 * every rejection it makes is a rejection nothing downstream repeats.
 */

import { describe, it, expect } from "vitest";

import { SUMMARY_MAX_CHARS } from "@vex-agent/engine/compaction/policy.js";
import { validateSummaryOutput } from "@vex-agent/engine/compaction/summary-validation.js";

describe("validateSummaryOutput", () => {
  it("accepts an ordinary summary", () => {
    const result = validateSummaryOutput(
      "  The user wants conservative swaps and asked to avoid bridges.  ",
    );
    expect(result).toMatchObject({ ok: true, hardRedactCount: 0 });
    if (result.ok) {
      expect(result.summary).toBe(
        "The user wants conservative swaps and asked to avoid bridges.",
      );
    }
  });

  it("rejects empty and whitespace-only output", () => {
    expect(validateSummaryOutput("")).toEqual({ ok: false, reason: "empty" });
    expect(validateSummaryOutput("   \n\t ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects output over the bound", () => {
    expect(validateSummaryOutput("a".repeat(SUMMARY_MAX_CHARS + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("measures the bound on the STORED bytes, i.e. after redaction", () => {
    // The bound governs what lands in `sessions.summary`. This raw string is
    // over the limit, but the secret in it collapses to a short placeholder, so
    // the stored form fits — and rejecting it would reject a summary that was
    // never going to be stored at that size.
    const seed =
      "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const filler = "x".repeat(SUMMARY_MAX_CHARS - 20);
    const result = validateSummaryOutput(`${seed} ${filler}`);

    expect(`${seed} ${filler}`.length).toBeGreaterThan(SUMMARY_MAX_CHARS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
      expect(result.hardRedactCount).toBe(1);
    }
  });

  it("reports redaction when secret material appears in model output", () => {
    const result = validateSummaryOutput(
      "The user shared a wallet 0x1234567890abcdef1234567890abcdef12345678 during the session and we discussed swap routing preferences at length.",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hardRedactCount + result.maskCount).toBeGreaterThan(0);
      expect(result.summary).not.toContain(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
    }
  });

  it("rejects output that is dominated by live state", () => {
    const result = validateSummaryOutput(
      "balance 12.5 SOL price $143.22 gas 0.00021 balance 3.1 ETH price $2411.10 gas 0.0004 balance 900 USDC price $1.00",
    );
    expect(result).toEqual({ ok: false, reason: "live_state_dominated" });
  });
});
