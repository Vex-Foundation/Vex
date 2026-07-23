/**
 * `amountDisplay` — pins the `trustedHuman` contract added by Codex final
 * review round 1 finding 10 / coordinator contract C27: a legacy/untrusted
 * amount still requires a literal "." to be treated as human; an
 * agent_activity-sourced amount (typed provenance already proven upstream)
 * is trusted verbatim, including a whole-number result with no decimal
 * point. `tokenDisplay`'s brand-gating behavior is pinned separately by
 * `appShell/__tests__/MovesBlock.test.tsx` (pre-existing, unchanged here).
 */

import { describe, expect, it } from "vitest";
import { amountDisplay } from "../token-leg-display.js";

describe("amountDisplay — default (legacy/untrusted) source", () => {
  it("renders a dotted decimal that parses to a finite positive number", () => {
    expect(amountDisplay("1.5")).toBe("1.5");
  });

  it("renders nothing for a whole-number string with no decimal point (untrusted — could be raw atomic)", () => {
    expect(amountDisplay("50")).toBeNull();
  });

  it("renders nothing for a raw base-unit integer (wei-scale, no dot)", () => {
    expect(amountDisplay("1500000000000000000")).toBeNull();
  });

  it("renders nothing for null", () => {
    expect(amountDisplay(null)).toBeNull();
  });

  it("renders nothing for zero or negative", () => {
    expect(amountDisplay("0.0")).toBeNull();
    expect(amountDisplay("-1.5")).toBeNull();
  });

  it("defaults to untrusted when trustedHuman is omitted", () => {
    expect(amountDisplay("50")).toBe(amountDisplay("50", false));
  });
});

describe("amountDisplay — trustedHuman: true (agent_activity-sourced)", () => {
  it("renders a whole-number string with no decimal point (C27)", () => {
    expect(amountDisplay("50", true)).toBe("50");
  });

  it("still renders a dotted decimal normally", () => {
    expect(amountDisplay("1.5", true)).toBe("1.5");
  });

  it("still renders nothing for null", () => {
    expect(amountDisplay(null, true)).toBeNull();
  });

  it("still renders nothing for zero or negative even when trusted", () => {
    expect(amountDisplay("0", true)).toBeNull();
    expect(amountDisplay("-5", true)).toBeNull();
  });

  it("still renders nothing for a non-numeric string even when trusted", () => {
    expect(amountDisplay("not-a-number", true)).toBeNull();
  });

  it("compacts to at most 6 significant digits the same way as the untrusted path", () => {
    expect(amountDisplay("1.693990018868617600", true)).toBe(
      amountDisplay("1.693990018868617600", false),
    );
  });
});
