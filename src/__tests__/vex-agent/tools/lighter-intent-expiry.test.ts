import { describe, expect, it } from "vitest";
import { assertIntentUnexpired, LighterIntentRefusal } from "@vex-agent/tools/protocols/lighter/intent-expiry.js";

describe("Lighter human consent expiry", () => {
  it("accepts only a strictly future consent deadline", () => {
    expect(() => assertIntentUnexpired(new Date(1001), 1000, "consent_expired_before_plan")).not.toThrow();
    expect(() => assertIntentUnexpired(new Date(1000), 1000, "consent_expired_before_plan"))
      .toThrow(LighterIntentRefusal);
  });
  it.each(["invalid", "", new Date(NaN), new Date(999)])("fails closed for %s", (expiresAt) => {
    expect(() => assertIntentUnexpired(expiresAt, 1000, "consent_expired_after_signing"))
      .toThrow(expect.objectContaining({ reason: "consent_expired_after_signing" }));
  });
  it("refuses invalid clock input", () => {
    expect(() => assertIntentUnexpired(new Date(1001), NaN, "consent_expired_before_plan")).toThrow(LighterIntentRefusal);
  });
  it("does not substitute a wire deadline or ten-year integrator authorization for consent", () => {
    const deadlines = { consent: new Date(1000), wire: new Date(600000), integrator: new Date(315360000000) };
    expect(() => assertIntentUnexpired(deadlines.consent, 1000, "consent_expired_before_submission")).toThrow(LighterIntentRefusal);
    expect(deadlines.wire.getTime()).toBeGreaterThan(1000);
    expect(deadlines.integrator.getTime()).toBeGreaterThan(deadlines.wire.getTime());
  });
});
