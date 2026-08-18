/**
 * The shares verdict, after the coordinator's tolerance ruling of 2026-08-17.
 *
 * The old bound was a FIXED 1e-9 of one share, and the fork run measured an
 * ordinary 1 USDC deposit landing just outside it. These tests pin the two
 * properties the ruling actually bought: the verdict now uses the bound the
 * approved slippage allows (the same one the on-chain `maxSharePrice` guard
 * enforces), and the raw quoted-vs-settled difference survives as DATA labelled
 * accrual drift rather than as a verdict.
 *
 * WHAT THESE TESTS DO NOT CLAIM. The bound is proportional to the quoted size -
 * the third test below measures exactly that, and it is the honest reading of a
 * per-share price bound, which is what the chain enforces too. The property
 * that matters is narrower and is the one asserted: the bound is fixed from the
 * QUOTE before the settlement is known, so nothing about what settles can widen
 * it.
 */

import { describe, it, expect } from "vitest";

import { compareMorphoShares, morphoShareBoundRaw } from "@tools/morpho/mutations.js";
import { sanitizeMorphoCause } from "@tools/morpho/errors.js";

const WHOLE_SHARE = 10n ** 18n;

describe("morphoShareBoundRaw", () => {
  it("floors a deposit at the worst share count the approved maxSharePrice can return", () => {
    // maxSharePrice is the current price raised by the bps, so the worst legal
    // share count is quoted * 10000 / (10000 + bps).
    expect(morphoShareBoundRaw(10_000n * WHOLE_SHARE, 100, "deposit")).toBe(
      (10_000n * WHOLE_SHARE * 10_000n) / 10_100n,
    );
  });

  it("mirrors the bound into a CEILING on a withdrawal, because a burn is the other direction", () => {
    // Fewer shares burned is better, so a floor would flag every good
    // withdrawal. The worse-than-approved outcome is burning MORE.
    expect(morphoShareBoundRaw(10_000n * WHOLE_SHARE, 100, "withdraw")).toBe(
      (10_000n * WHOLE_SHARE * 10_100n) / 10_000n,
    );
  });

  it("scales linearly with the quoted size, as a per-share price bound must", () => {
    // STATED PLAINLY BECAUSE THIS IS WHAT THE NUMBERS DO: double the quote and
    // the bound doubles. It is a per-share price bound, so it applies to
    // whatever size is traded, exactly as the on-chain `maxSharePrice` guard
    // does. What rule 90 forbids is a tolerance that stretches to cover a
    // bigger loss, and this cannot: it is computed ONCE from the quote and the
    // approved bps, before the settlement is known, so the shortfall it permits
    // is exactly the bps the user agreed to and nothing about what settles can
    // widen it. Integer division truncates, so the two sizes agree to within one
    // raw unit rather than exactly, and the bound is always rounded in the
    // user's favour.
    const small = morphoShareBoundRaw(1_000n * WHOLE_SHARE, 50, "deposit");
    const large = morphoShareBoundRaw(2_000n * WHOLE_SHARE, 50, "deposit");

    expect(large - small * 2n).toBeLessThanOrEqual(1n);
    expect(large - small * 2n).toBeGreaterThanOrEqual(0n);
  });

  it("treats a zero slippage as an exact-quote bound rather than an unbounded one", () => {
    expect(morphoShareBoundRaw(500n * WHOLE_SHARE, 0, "deposit")).toBe(500n * WHOLE_SHARE);
  });
});

describe("compareMorphoShares", () => {
  const QUOTED = 1_000n * WHOLE_SHARE;

  it("passes an ordinary deposit whose accrual drift would have tripped the old fixed tolerance", () => {
    // 1.01e-9 of a share away from the quote: outside the retired 1e-9 bound,
    // far inside the approved 100 bps.
    const actual = QUOTED - 1_010_000_000n;
    const verdict = compareMorphoShares(QUOTED, actual, 18, 100, "deposit");

    expect(verdict.withinApprovedBound).toBe(true);
    expect(verdict.accrualDriftRaw).toBe("1010000000");
    expect(verdict.boundSide).toBe("minimum_shares_received");
  });

  it("fails a deposit that came back below the approved floor", () => {
    const verdict = compareMorphoShares(QUOTED, (QUOTED * 9_000n) / 10_000n, 18, 100, "deposit");

    expect(verdict.withinApprovedBound).toBe(false);
    expect(verdict.approvedBoundRaw).toBe(((QUOTED * 10_000n) / 10_100n).toString());
  });

  it("passes a withdrawal that burned FEWER shares than quoted", () => {
    const verdict = compareMorphoShares(QUOTED, QUOTED - 5_000_000_000n, 18, 100, "withdraw");

    expect(verdict.withinApprovedBound).toBe(true);
    expect(verdict.boundSide).toBe("maximum_shares_burned");
  });

  it("fails a withdrawal that burned more shares than the approved ceiling", () => {
    const verdict = compareMorphoShares(QUOTED, (QUOTED * 10_500n) / 10_000n, 18, 100, "withdraw");

    expect(verdict.withinApprovedBound).toBe(false);
  });

  it("always reports the PROVEN share count, bound or no bound", () => {
    const actual = (QUOTED * 8_000n) / 10_000n;
    const verdict = compareMorphoShares(QUOTED, actual, 18, 100, "deposit");

    expect(verdict.actualRaw).toBe(actual.toString());
    expect(verdict.quotedRaw).toBe(QUOTED.toString());
  });

  it("names the on-chain guard on a deposit and declines to claim one on a withdrawal", () => {
    expect(compareMorphoShares(QUOTED, QUOTED, 18, 100, "deposit").note).toContain("ON CHAIN");
    expect(compareMorphoShares(QUOTED, QUOTED, 18, 100, "withdraw").note).toContain(
      "no on-chain share-price leg",
    );
  });
});

/**
 * D8 (live read-only test, 2026-08-17): viem stamps its own version into every
 * error it raises, and it was reaching the agent through the preflight's revert
 * reason and the gas unavailability note.
 *
 * The fix is at the ONE owner of the scrubbing, so these cases pin both halves:
 * the version goes, and the actual cause beside it stays. Sanitize, do not hide.
 */
describe("sanitizeMorphoCause strips our own library version and keeps the cause", () => {
  it("removes the viem version stamp", () => {
    const scrubbed = sanitizeMorphoCause(
      "execution reverted: ERC20: transfer amount exceeds allowance Version: viem@2.54.3",
    );

    expect(scrubbed).not.toContain("viem@");
    expect(scrubbed).not.toContain("2.54.3");
  });

  it("keeps every word of the REAL cause, which is what the agent must act on", () => {
    const scrubbed = sanitizeMorphoCause(
      "execution reverted: ERC20: transfer amount exceeds allowance Version: viem@2.54.3",
    );

    expect(scrubbed).toContain("transfer amount exceeds allowance");
  });

  it("still strips urls and long hex blobs beside it", () => {
    const scrubbed = sanitizeMorphoCause(
      `insufficient funds Docs: https://viem.sh/docs/errors 0x${"a".repeat(40)} viem@2.54.3`,
    );

    expect(scrubbed).toContain("insufficient funds");
    expect(scrubbed).toContain("[url]");
    expect(scrubbed).toContain("[hex]");
    expect(scrubbed).not.toContain("viem@");
  });
});
