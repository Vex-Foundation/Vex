/**
 * Spendability evaluation, its durable codec, and its card line (WP2-S).
 *
 * The location of risk here is a DECISION, not a chain read: given what a venue
 * observed, which member of the one eligibility union does this quote get. So
 * the experiments are table-driven over the real evaluator with no IO at all -
 * `spendability.ts` has none by construction.
 *
 * What each group pins, and what would break if it regressed:
 *
 *   - ORDER: a route that is already ineligible is returned unchanged, so a
 *     wallet short of funds never masks an excessive-impact route. Funding the
 *     wallet would not make that route safe, and an agent told the wrong reason
 *     retries the wrong fix.
 *   - FAIL CLOSED: an unreadable balance is `balance_unavailable`, never
 *     `insufficient_balance` and never `executable`; a `latest` read is not a
 *     `pending` read (contract C2.4).
 *   - THE TRIPLE: Required / Current / Missing are exact atomic integers, and
 *     `missing` is the arithmetic difference - the figure a person funds from.
 *   - NO GUESSING: without usable decimals or a symbol the human rendering is
 *     `null` and the raw value is what is shown (contract C1.2). 18 is never
 *     assumed and a symbol is never invented.
 */

import { describe, expect, it } from "vitest";

import {
  evaluateSpendability,
  formatShortfall,
  parseSpendabilityPreview,
  renderSpendability,
  shortfall,
  type SpendabilityAssetCheck,
} from "@vex-agent/tools/protocols/quote-authority/spendability.js";
import type { QuoteEligibility } from "@vex-agent/tools/protocols/quote-authority/eligibility.js";
import { buildBoundDebitPlan } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";
import {
  SPENDABILITY_CARD_VERSION,
  type AssetRef,
  type SourceBalanceObservation,
} from "@vex-agent/tools/protocols/quote-authority/spendability-contract.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OBSERVED_AT = "2026-08-31T12:00:00.000Z";

const USDC: AssetRef = { chainId: 8453, address: "0xUSDC", symbol: "USDC" };
const NATIVE: AssetRef = { chainId: 8453, address: "0xeeee", symbol: "ETH" };

const EXECUTABLE_ROUTE: QuoteEligibility = {
  kind: "executable",
  priceImpactFraction: 0.01,
  adverse: false,
};

function observation(
  asset: AssetRef,
  balanceRaw: string,
  decimals: number | null,
  blockTag: "pending" | "latest" = "pending",
): SourceBalanceObservation {
  return {
    wallet: WALLET,
    asset,
    blockTag,
    balanceRaw,
    decimals,
    balance: null,
    observedAt: OBSERVED_AT,
  };
}

function check(
  asset: AssetRef,
  balanceRaw: string,
  requiredRaw: string,
  decimals: number | null = 6,
  symbol: string | null = asset.symbol,
): SpendabilityAssetCheck {
  return {
    read: { ok: true, observation: observation(asset, balanceRaw, decimals) },
    requiredRaw,
    symbol,
  };
}

/** A native leg with plenty of headroom, so a test can isolate the source leg. */
const FUNDED_NATIVE = check(NATIVE, "1000000000000000000", "500000000000000", 18, "ETH");
/** A source leg with plenty of headroom, so a test can isolate the native leg. */
const FUNDED_SOURCE = check(USDC, "1000000000", "1000000");

describe("evaluateSpendability - order", () => {
  it("returns an ineligible ROUTE verdict unchanged, without judging balances", () => {
    const route: QuoteEligibility = {
      kind: "excessive_impact",
      priceImpactFraction: 0.4,
      ceilingFraction: 0.15,
    };
    const outcome = evaluateSpendability({
      routeEligibility: route,
      // Empty wallet on both legs: if the order were wrong this would win.
      source: check(USDC, "0", "1000000"),
      native: check(NATIVE, "0", "1", 18, "ETH"),
    });
    expect(outcome.eligibility).toEqual(route);
    expect(outcome.preview).toBeUndefined();
  });

  it("judges the SOURCE leg before the native leg", () => {
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: check(USDC, "0", "1000000"),
      native: check(NATIVE, "0", "500000000000000", 18, "ETH"),
    });
    expect(outcome.eligibility.kind).toBe("insufficient_balance");
  });
});

describe("evaluateSpendability - fail closed", () => {
  it("an unreadable source balance is balance_unavailable, never insufficient_balance", () => {
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: { read: { ok: false, asset: USDC, cause: "rpc_unavailable" }, requiredRaw: "1000000", symbol: "USDC" },
      native: FUNDED_NATIVE,
    });
    expect(outcome.eligibility).toEqual({
      kind: "balance_unavailable",
      asset: USDC,
      cause: "rpc_unavailable",
    });
    expect(outcome.preview).toBeUndefined();
  });

  it("a retained `latest` value stays advisory: the verdict is still balance_unavailable", () => {
    // Contract C2.4. MetaMask's own helper silently falls back from `pending`
    // to `latest` and treats the result as authoritative
    // (`transaction-pay-controller/src/utils/token.ts:381-390`); a `latest`
    // balance does not subtract in-flight spending, so Vex refuses instead.
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: {
        read: {
          ok: false,
          asset: USDC,
          cause: "pending_tag_unsupported",
          advisoryLatest: observation(USDC, "999999999999", 6, "latest"),
        },
        requiredRaw: "1000000",
        symbol: "USDC",
      },
      native: FUNDED_NATIVE,
    });
    // The advisory figure is enormous - if it were consulted, this would pass.
    expect(outcome.eligibility.kind).toBe("balance_unavailable");
  });

  it("an `ok` read that is not at the `pending` tag is refused, not trusted", () => {
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: {
        read: { ok: true, observation: observation(USDC, "999999999", 6, "latest") },
        requiredRaw: "1000000",
        symbol: "USDC",
      },
      native: FUNDED_NATIVE,
    });
    expect(outcome.eligibility).toMatchObject({
      kind: "balance_unavailable",
      cause: "balance_block_tag_not_pending",
    });
  });

  it("a non-integer atomic amount is balance_unavailable, never a coerced comparison", () => {
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: { ...check(USDC, "1000000", "1.5"), requiredRaw: "1.5" },
      native: FUNDED_NATIVE,
    });
    expect(outcome.eligibility).toMatchObject({
      kind: "balance_unavailable",
      cause: "amount_not_atomic_integer",
    });
  });

  it("an unreadable NATIVE balance fails closed even when the source leg is funded", () => {
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: FUNDED_SOURCE,
      native: { read: { ok: false, asset: NATIVE, cause: "rpc_unavailable" }, requiredRaw: "1", symbol: "ETH" },
    });
    expect(outcome.eligibility).toMatchObject({ kind: "balance_unavailable", asset: NATIVE });
  });
});

describe("evaluateSpendability - the Required / Current / Missing triple", () => {
  it("insufficient_balance states all three, with `missing` the exact difference", () => {
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: check(USDC, "400000", "1000000"),
      native: FUNDED_NATIVE,
    });
    expect(outcome.eligibility).toEqual({
      kind: "insufficient_balance",
      required: { raw: "1000000", human: "1", decimals: 6, symbol: "USDC" },
      current: { raw: "400000", human: "0.4", decimals: 6, symbol: "USDC" },
      missing: { raw: "600000", human: "0.6", decimals: 6, symbol: "USDC" },
    });
  });

  it("a native balance covering the principal but not the fee debit is gas_reserve_insufficient", () => {
    // The source leg is an ERC-20 and is fully funded: a token swap still pays
    // its gas in native, which is why the native leg exists at all (C2.5).
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: FUNDED_SOURCE,
      native: check(NATIVE, "100000000000000", "500000000000000", 18, "ETH"),
    });
    expect(outcome.eligibility).toEqual({
      kind: "gas_reserve_insufficient",
      required: { raw: "500000000000000", human: "0.0005", decimals: 18, symbol: "ETH" },
      current: { raw: "100000000000000", human: "0.0001", decimals: 18, symbol: "ETH" },
      missing: { raw: "400000000000000", human: "0.0004", decimals: 18, symbol: "ETH" },
    });
  });

  it("exactly enough is enough: held == required stays executable", () => {
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: check(USDC, "1000000", "1000000"),
      native: check(NATIVE, "500000000000000", "500000000000000", 18, "ETH"),
    });
    expect(outcome.eligibility).toEqual(EXECUTABLE_ROUTE);
    expect(outcome.preview).toBeDefined();
  });

  it("compares exactly at uint256 scale - no float rounding decides a swap", () => {
    const held = "115792089237316195423570985008687907853269984665640564039457584007913129639934";
    const required = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const outcome = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: { ...check(USDC, held, required, 0, "USDC") },
      native: FUNDED_NATIVE,
    });
    expect(outcome.eligibility).toMatchObject({
      kind: "insufficient_balance",
      missing: { raw: "1" },
    });
  });
});

describe("shortfall - metadata degradation (contract C1.2)", () => {
  it("shows the raw value and NO human amount when decimals are unavailable", () => {
    expect(shortfall("1234567", null, "USDC")).toEqual({
      raw: "1234567",
      human: null,
      decimals: null,
      symbol: "USDC",
    });
  });

  it("rejects a non-integer decimals value rather than scaling by it", () => {
    expect(shortfall("1000", Number.POSITIVE_INFINITY, "X").human).toBeNull();
    expect(shortfall("1000", 1.5, "X").decimals).toBeNull();
    expect(shortfall("1000", 37, "X").decimals).toBeNull();
  });

  it("treats 0 decimals as legal, not as missing", () => {
    expect(shortfall("1000", 0, "X")).toEqual({
      raw: "1000",
      human: "1000",
      decimals: 0,
      symbol: "X",
    });
  });

  it("never invents a symbol", () => {
    const amount = shortfall("1000000", 6, null);
    expect(amount.symbol).toBeNull();
    expect(formatShortfall(amount)).toBe("1000000 raw units");
  });

  it("falls back to raw units in the rendering when the human amount is unknown", () => {
    expect(formatShortfall(shortfall("1234567", null, "USDC"))).toBe("1234567 raw units");
    expect(formatShortfall(shortfall("1234567", 6, "USDC"))).toBe("1.234567 USDC");
  });
});

describe("the durable preview", () => {
  /**
   * The transaction set an ERC-20 swap with no allowance yet plans, with the
   * swap's units unmeasurable until the approve lands - the ratified
   * lower-bound case, which the card must state rather than hide.
   */
  const PLAN = buildBoundDebitPlan({
    legs: [
      { role: "allowance", pricing: "measured" as const },
      { role: "swap", pricing: "conservative" as const },
      { role: "swap_fee", pricing: "measured" as const },
    ],
    feeCap: { mode: "eip1559", maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
  });

  const outcome = evaluateSpendability({
    routeEligibility: EXECUTABLE_ROUTE,
    source: check(USDC, "5000000", "1000000"),
    native: check(NATIVE, "1000000000000000000", "500000000000000", 18, "ETH"),
    debitPlan: PLAN,
  });

  it("is produced only on the executable path and carries both legs", () => {
    const preview = outcome.preview;
    expect(preview).toBeDefined();
    expect(preview?.cardVersion).toBe(SPENDABILITY_CARD_VERSION);
    expect(preview?.source.required.raw).toBe("1000000");
    expect(preview?.source.current.raw).toBe("5000000");
    expect(preview?.native.required.raw).toBe("500000000000000");
    expect(preview?.debitPlan).toEqual(PLAN);
  });

  it("carries no plan for a venue that seals none, rather than an empty one", () => {
    const noPlan = evaluateSpendability({
      routeEligibility: EXECUTABLE_ROUTE,
      source: check(USDC, "5000000", "1000000"),
      native: check(NATIVE, "1000000000000000000", "500000000000000", 18, "ETH"),
    });

    expect(noPlan.preview?.debitPlan).toBeUndefined();
    // And it still round-trips: a Solana preview is not a broken EVM one.
    expect(parseSpendabilityPreview(JSON.parse(JSON.stringify(noPlan.preview)) as unknown))
      .toEqual(noPlan.preview);
  });

  it("refuses a payload whose bound plan is not a shape this build can enforce", () => {
    const preview = outcome.preview;
    if (preview === undefined) throw new Error("preview missing");

    expect(parseSpendabilityPreview({ ...preview, debitPlan: { legs: [], reserve: PLAN.reserve } }))
      .toBeUndefined();
  });

  it("round-trips through the codec unchanged", () => {
    const persisted = JSON.parse(JSON.stringify(outcome.preview)) as unknown;
    expect(parseSpendabilityPreview(persisted)).toEqual(outcome.preview);
  });

  it("refuses a payload written under a different card version", () => {
    const stale = { ...outcome.preview, cardVersion: "spendability-v0" };
    expect(parseSpendabilityPreview(stale)).toBeUndefined();
  });

  it("refuses a payload whose raw amount is not an atomic integer", () => {
    const preview = outcome.preview;
    if (preview === undefined) throw new Error("preview missing");
    const tampered = {
      ...preview,
      source: { ...preview.source, current: { ...preview.source.current, raw: "-1" } },
    };
    expect(parseSpendabilityPreview(tampered)).toBeUndefined();
  });

  it("refuses an over-long symbol rather than shortening it", () => {
    const preview = outcome.preview;
    if (preview === undefined) throw new Error("preview missing");
    const tampered = {
      ...preview,
      source: { ...preview.source, current: { ...preview.source.current, symbol: "S".repeat(65) } },
    };
    expect(parseSpendabilityPreview(tampered)).toBeUndefined();
  });

  it("renders a line that states the numbers are quote-time, not sign-time", () => {
    const preview = outcome.preview;
    if (preview === undefined) throw new Error("preview missing");
    const line = renderSpendability(preview);
    expect(line).toContain(SPENDABILITY_CARD_VERSION);
    expect(line).toContain("required 1 USDC");
    expect(line).toContain("held 5 USDC");
    expect(line).toContain("pending");
    expect(line).toContain(OBSERVED_AT);
    expect(line).toContain("re-read before signing");
    // The PLAN the binding will enforce, in the same line: the transaction set,
    // the ceiling, and the caveat naming which leg was priced CONSERVATIVELY
    // rather than measured. It is no longer a lower bound - a leg with no
    // figure at all cannot reach a sealed plan since 2026-09-01 - and the card
    // must therefore not say the total is one.
    expect(line).toContain("will send allowance -> swap -> swap_fee");
    expect(line).toContain("at most 11210000 wei/gas");
    expect(line).toContain("zero_value_self_transfer");
    expect(line).toContain("swap gas could not be simulated yet");
    expect(line).toContain("CONSERVATIVELY");
    expect(line).not.toContain("LOWER BOUND");
  });
});
