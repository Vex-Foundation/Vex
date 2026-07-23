/**
 * Relay-fallback reveal eligibility seam (bridge factory W5; plan R7/R9/R10).
 *
 * `shouldRevealRelayFallback` is the thin, fail-closed decision that turns W1's
 * Khalani failure verdict into a reveal decision. W1 owns the closed
 * externalName/empty-routes classifier (`khalani-failure-mapping.ts`); this suite
 * drives the seam directly with the minimal `KhalaniFailureClassification` shape
 * it consumes (W1 not yet logged — see the module's COORDINATION NOTE).
 */
import { describe, it, expect } from "vitest";

import { shouldRevealRelayFallback } from "../../../vex-agent/tools/registry/relay-reveal-eligibility.js";

describe("shouldRevealRelayFallback (Relay reveal eligibility seam)", () => {
  it("a W1 reveal-eligible verdict reveals", () => {
    expect(shouldRevealRelayFallback({ revealEligible: true })).toBe(true);
  });

  it("a W1 not-eligible verdict does NOT reveal", () => {
    expect(shouldRevealRelayFallback({ revealEligible: false })).toBe(false);
  });

  it("an absent verdict is fail-closed (not eligible)", () => {
    expect(shouldRevealRelayFallback(undefined)).toBe(false);
  });

  it("a non-boolean-true value is fail-closed (guards a loose/any-typed verdict)", () => {
    // A truthy-but-not-`true` value must NOT widen eligibility.
    expect(
      shouldRevealRelayFallback({
        // @ts-expect-error — deliberately the wrong type for this guard test.
        revealEligible: "true",
      }),
    ).toBe(false);
    expect(
      shouldRevealRelayFallback({
        // @ts-expect-error — deliberately the wrong type for this guard test.
        revealEligible: 1,
      }),
    ).toBe(false);
  });
});
