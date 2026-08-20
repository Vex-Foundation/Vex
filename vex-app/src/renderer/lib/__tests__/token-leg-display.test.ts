/**
 * `amountDisplay` — pins the `trustedHuman` contract added by Codex final
 * review round 1 finding 10 / coordinator contract C27: a legacy/untrusted
 * amount still requires a literal "." to be treated as human; an
 * agent_activity-sourced amount (typed provenance already proven upstream)
 * is trusted verbatim, including a whole-number result with no decimal
 * point; and the STRICT decimal audit (Codex review round 2 finding 1) — the
 * whole string must be a canonical unsigned decimal, so `parseFloat`'s
 * prefix-matching can no longer print `"240.31garbage"` as `240.31`.
 *
 * `tokenDisplay`'s brand-gating behavior used to be pinned by
 * `appShell/__tests__/MovesBlock.test.tsx`, which the session-UI redesign
 * deleted along with `MovesBlock`. That coverage now lives HERE, next to the
 * module that survived and is consumed by the transcript tool cards, the
 * agent-scan rows and the token-history screen.
 */

import { describe, expect, it } from "vitest";
import { amountDisplay, tokenDisplay } from "../token-leg-display.js";

describe("amountDisplay - default (legacy/untrusted) source", () => {
  it("renders a dotted decimal that parses to a finite positive number", () => {
    expect(amountDisplay("1.5")).toBe("1.5");
  });

  it("renders nothing for a whole-number string with no decimal point (untrusted - could be raw atomic)", () => {
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

describe("amountDisplay - trustedHuman: true (agent_activity-sourced)", () => {
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

describe("amountDisplay - the whole string must be a canonical decimal", () => {
  it.each([
    ["a valid prefix with trailing junk", "240.31garbage"],
    ["markup smuggled after the number", "1.5<script>alert(1)</script>"],
    ["a leading space", " 1.5"],
    ["a trailing space", "1.5 "],
    ["exponent notation", "1.5e21"],
    ["a thousands separator", "1,234.5"],
    ["a leading plus", "+1.5"],
    ["a bare decimal point", "."],
    ["a trailing decimal point", "1."],
    ["hex", "0x1.5"],
  ])("renders nothing for %s (untrusted)", (_label, amount) => {
    expect(amountDisplay(amount)).toBeNull();
  });

  it.each([
    ["trailing junk", "50garbage"],
    ["exponent notation", "5e3"],
    ["whitespace padding", " 50 "],
  ])("renders nothing for %s even when trusted", (_label, amount) => {
    expect(amountDisplay(amount, true)).toBeNull();
  });
});

// ── tokenDisplay brand gating (inherited from the deleted MovesBlock suite) ──

describe("tokenDisplay - only a known mint may borrow a brand", () => {
  const SOL_MINT = "So11111111111111111111111111111111111111112";

  it("grants ticker AND brand mark to a KNOWN mint, with the full mint on hover", () => {
    expect(tokenDisplay(SOL_MINT, null, null)).toEqual({
      text: "SOL",
      full: SOL_MINT,
      iconSymbol: "SOL",
    });
  });

  it("ignores a scam mint's captured brand claim - the known mint wins", () => {
    expect(tokenDisplay(SOL_MINT, "USDC", null).text).toBe("SOL");
  });

  it("DROPS a captured brand-ticker claim an unknown mint cannot prove", () => {
    const scam = "5cAmM1nTaddre55aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const display = tokenDisplay(scam, "SOL", null);
    // Falls through to the address rule: no borrowed ticker, no borrowed mark.
    expect(display.text).not.toBe("SOL");
    expect(display.iconSymbol).toBeNull();
    expect(display.full).toBe(scam);
  });

  it("allows a NON-brand captured symbol, which can only ever take a monogram", () => {
    const display = tokenDisplay(null, "BONK", null);
    expect(display.text).toBe("BONK");
    expect(display.iconSymbol).toBe("BONK");
  });

  it("gives the local balances-derived symbol TEXT ONLY - never even a monogram", () => {
    const display = tokenDisplay(null, null, "BONK");
    expect(display.text).toBe("BONK");
    expect(display.iconSymbol).toBeNull();
  });

  it("drops a local symbol that claims a brand", () => {
    expect(tokenDisplay(null, null, "USDC").text).toBe("?");
  });

  it("shows a brand-matching RAW token as text but withholds the logo", () => {
    expect(tokenDisplay("ETH", null, null)).toEqual({
      text: "ETH",
      full: null,
      iconSymbol: null,
    });
  });

  it("falls back to `?` for a null / empty / unicode-bearing token", () => {
    expect(tokenDisplay(null, null, null).text).toBe("?");
    expect(tokenDisplay("", null, null).text).toBe("?");
    expect(tokenDisplay("USDC​", null, null).iconSymbol).toBeNull();
  });
});
