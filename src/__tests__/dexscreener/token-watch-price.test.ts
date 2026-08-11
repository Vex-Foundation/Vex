/**
 * `selectTokenWatchPrice` - the ONE canonical price rule shared by the
 * `token_price` wake watch's validation and its poller.
 *
 * The fixtures are REAL `/token-pairs/v1` captures (see the fixture header for
 * provenance), fed through the production validator first, so a provider shape
 * change breaks these tests instead of the live watch. The quote-side case is
 * the one the balances precedent already proved matters: DexScreener prices the
 * BASE token of a pool, so a pool where the watched token sits on the quote side
 * reports someone else's price until it is normalized.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateTokensPairsResponse } from "../../tools/dexscreener/validation.js";
import { selectTokenWatchPrice } from "../../tools/dexscreener/token-watch-price.js";
import {
  compareBoundedDecimals,
  divideBoundedDecimals,
  formatBoundedDecimal,
  parseBoundedDecimal,
} from "../../tools/dexscreener/token-watch-price/decimal.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function fixture(name: string) {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return validateTokensPairsResponse(JSON.parse(readFileSync(path, "utf8")));
}

describe("bounded decimal primitives", () => {
  it("compares exactly, without ever going through a float", () => {
    const a = parseBoundedDecimal("0.10000000000000000001");
    const b = parseBoundedDecimal("0.1");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 0.1 + 1e-20 === 0.1 in IEEE-754; exact decimal comparison must not agree.
    expect(compareBoundedDecimals(a!, b!)).toBe(1);
    expect(compareBoundedDecimals(b!, a!)).toBe(-1);
    expect(compareBoundedDecimals(b!, parseBoundedDecimal("0.100")!)).toBe(0);
  });

  it("compares magnitudes across differing scales", () => {
    expect(compareBoundedDecimals(
      parseBoundedDecimal("9.5")!,
      parseBoundedDecimal("10")!,
    )).toBe(-1);
    expect(compareBoundedDecimals(
      parseBoundedDecimal("1877.7630")!,
      parseBoundedDecimal("1877.763")!,
    )).toBe(0);
  });

  it("rejects everything that is not a plain positive decimal", () => {
    for (const raw of [
      "", " ", "abc", "-1", "1e9", "1E9", "Infinity", "NaN", "0x1", "1.2.3", "1,2", "+1",
      `1${"0".repeat(200)}`,
    ]) {
      expect(parseBoundedDecimal(raw), raw).toBeNull();
    }
  });

  it("parses zero but reports it as non-positive so a price cannot be zero", () => {
    const zero = parseBoundedDecimal("0.000");
    expect(zero).not.toBeNull();
    expect(compareBoundedDecimals(zero!, parseBoundedDecimal("0")!)).toBe(0);
  });

  it("divides with a bounded scale and refuses division by zero", () => {
    const one = divideBoundedDecimals(
      parseBoundedDecimal("0.4168")!,
      parseBoundedDecimal("0.4168")!,
    );
    expect(one).not.toBeNull();
    expect(formatBoundedDecimal(one!)).toBe("1");
    expect(divideBoundedDecimals(parseBoundedDecimal("1")!, parseBoundedDecimal("0")!)).toBeNull();
  });

  it("formats without exponent notation or trailing zeros", () => {
    expect(formatBoundedDecimal(parseBoundedDecimal("0.00000000012300")!)).toBe("0.000000000123");
    expect(formatBoundedDecimal(parseBoundedDecimal("1877.7630")!)).toBe("1877.763");
    expect(formatBoundedDecimal(parseBoundedDecimal("0")!)).toBe("0");
  });
});

describe("selectTokenWatchPrice", () => {
  it("normalizes a quote-side pool to the WATCHED token before choosing", () => {
    const pairs = fixture("token-pairs-usdc-base.json");
    const selected = selectTokenWatchPrice(pairs, { chainSlug: "base", tokenAddress: USDC_BASE });

    expect(selected).not.toBeNull();
    // The deepest pool is AERO/USDC: the provider prices AERO at 0.4168, and
    // USDC is worth 0.4168 / 0.4168 = 1 USD. Taking the raw priceUsd would
    // have watched AERO's price under USDC's name.
    expect(selected!.side).toBe("quote");
    expect(selected!.priceUsd).toBe("1");
    expect(selected!.candidateCount).toBe(3);
  });

  it("picks the deepest NON-OUTLIER candidate when the deepest pool is mispriced", () => {
    const pairs = fixture("token-pairs-usdc-base-outlier.json");
    const selected = selectTokenWatchPrice(pairs, { chainSlug: "base", tokenAddress: USDC_BASE });

    expect(selected).not.toBeNull();
    expect(selected!.outlierCount).toBe(1);
    // Deepest pool normalizes to 10000 USD per USDC, 10000x the median of the
    // token's other pools. The next-deepest sane pool wins instead.
    expect(selected!.priceUsd).toBe("1");
    expect(selected!.liquidityUsd).toBeLessThan(26_000_000);
  });

  it("is case-insensitive on the token address and ignores other chains", () => {
    const pairs = fixture("token-pairs-usdc-base.json");
    const lower = selectTokenWatchPrice(pairs, {
      chainSlug: "base",
      tokenAddress: USDC_BASE.toLowerCase(),
    });
    expect(lower?.priceUsd).toBe("1");
    expect(selectTokenWatchPrice(pairs, { chainSlug: "arbitrum", tokenAddress: USDC_BASE })).toBeNull();
  });

  it("returns null when the provider returned no pool holding the token", () => {
    expect(selectTokenWatchPrice([], { chainSlug: "base", tokenAddress: USDC_BASE })).toBeNull();
    const pairs = fixture("token-pairs-usdc-base.json");
    expect(selectTokenWatchPrice(pairs, {
      chainSlug: "base",
      tokenAddress: "0x0000000000000000000000000000000000000dead",
    })).toBeNull();
  });

  it("never lets a quote-side pool with a zero priceNative produce a price", () => {
    const pairs = fixture("token-pairs-usdc-base.json").map((pair) =>
      pair.baseToken.address.toLowerCase() === USDC_BASE.toLowerCase()
        ? pair
        : { ...pair, priceNative: "0" });
    const selected = selectTokenWatchPrice(pairs, { chainSlug: "base", tokenAddress: USDC_BASE });
    // Only the base-side USDC/USDbC pool survives.
    expect(selected!.side).toBe("base");
    expect(selected!.priceUsd).toBe("0.9999");
    expect(selected!.candidateCount).toBe(1);
  });
});

// ── Solana ─────────────────────────────────────────────────────────

/**
 * The selector claims to be chain-agnostic: it normalizes by pool SIDE, and
 * nothing in it reads a chain family. These tests are the proof, run against a
 * REAL Solana capture (BONK, 2026-07-27) that already carries the 13.8x
 * cross-pool outlier the price-sanity rule exists for. If the claim were wrong,
 * the token_price watch would be silently unusable on half its chain domain.
 */
describe("selectTokenWatchPrice on Solana", () => {
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const WSOL = "So11111111111111111111111111111111111111112";

  function solanaPools() {
    const path = fileURLToPath(new URL(
      "./fixtures/live-captures/token-pairs-v1-solana-bonk-price-outlier.json",
      import.meta.url,
    ));
    const capture = JSON.parse(readFileSync(path, "utf8")) as { response: unknown };
    return validateTokensPairsResponse(capture.response);
  }

  it("prices a base-side base58 token and FLAGS the documented 13.8x outlier", () => {
    const selected = selectTokenWatchPrice(solanaPools(), {
      chainSlug: "solana",
      tokenAddress: BONK,
    });

    expect(selected).not.toBeNull();
    expect(selected!.side).toBe("base");
    expect(selected!.poolCount).toBe(30);
    // The mispriced pool is excluded from selection, not silently averaged in.
    expect(selected!.outlierCount).toBeGreaterThan(0);
    expect(Number(selected!.priceUsd)).toBeGreaterThan(0.000003);
    expect(Number(selected!.priceUsd)).toBeLessThan(0.0000032);
  });

  it("derives a SOL-quoted price from the quote side, the same rule as WETH pairs", () => {
    const selected = selectTokenWatchPrice(solanaPools(), {
      chainSlug: "solana",
      tokenAddress: WSOL,
    });

    expect(selected).not.toBeNull();
    expect(selected!.side).toBe("quote");
    // BONK priced 0.000003093 USD at 0.00000004045 SOL puts SOL near $76.
    expect(Number(selected!.priceUsd)).toBeGreaterThan(70);
    expect(Number(selected!.priceUsd)).toBeLessThan(85);
  });

  it("matches a base58 mint EXACTLY when the caller asks for case sensitivity", () => {
    const pools = solanaPools();
    // Same string, one letter re-cased: on base58 that is a DIFFERENT mint, and
    // an EVM-style case-folded compare would silently price the wrong asset.
    const recased = `dezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`;

    expect(selectTokenWatchPrice(pools, {
      chainSlug: "solana",
      tokenAddress: recased,
      caseSensitiveAddress: true,
    })).toBeNull();

    // The real mint still resolves under the same flag.
    expect(selectTokenWatchPrice(pools, {
      chainSlug: "solana",
      tokenAddress: BONK,
      caseSensitiveAddress: true,
    })).not.toBeNull();
  });

  it("keeps case-insensitive matching as the default, so EVM callers are unchanged", () => {
    const pairs = fixture("token-pairs-usdc-base.json");
    expect(selectTokenWatchPrice(pairs, {
      chainSlug: "base",
      tokenAddress: USDC_BASE.toUpperCase().replace("0X", "0x"),
    })).not.toBeNull();
  });

  it("ignores the capture entirely when asked for another chain", () => {
    expect(selectTokenWatchPrice(solanaPools(), {
      chainSlug: "base",
      tokenAddress: BONK,
    })).toBeNull();
  });
});
