/**
 * The `token_price` wake-watch evaluator.
 *
 * Everything expensive happens ONCE, at validation: chain resolution, address
 * bounds, the decimal threshold, the budget check, and one provider call that
 * proves the token actually has a price we could ever trigger on. The trigger
 * predicate is then pure, because it runs on every poll tick for every session.
 *
 * The three outcomes are the whole contract:
 *   accepted  - armed, the defer parks with the watch attached;
 *   rejected  - named warning, and THE DEFER STILL PARKS on its timer;
 *   satisfied - the threshold is already crossed, so sleeping would be wrong.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateTokensPairsResponse } from "@tools/dexscreener/validation.js";
import {
  createTokenPriceEvaluator,
  TOKEN_PRICE_WATCH_BUDGET,
  TOKEN_PRICE_WATCH_TYPE,
} from "@vex-agent/engine/wake/watch/token-price.js";
import { isWakeWatchSatisfied } from "@vex-agent/engine/wake/watch-registry.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const CONTEXT = {} as InternalToolContext;

function usdcPools() {
  const path = fileURLToPath(
    new URL("../../../dexscreener/fixtures/token-pairs-usdc-base.json", import.meta.url),
  );
  return validateTokensPairsResponse(JSON.parse(readFileSync(path, "utf8")));
}

/** The real BONK capture: base-side base58 token, ~0.0000031 USD. */
function solanaPools() {
  const path = fileURLToPath(new URL(
    "../../../dexscreener/fixtures/live-captures/token-pairs-v1-solana-bonk-price-outlier.json",
    import.meta.url,
  ));
  const capture = JSON.parse(readFileSync(path, "utf8")) as { response: unknown };
  return validateTokensPairsResponse(capture.response);
}

const getTokenPairs = vi.fn();
const listPendingPriceWatchPairs = vi.fn();

function evaluator() {
  return createTokenPriceEvaluator({
    getTokenPairs: (chain: string, token: string) => getTokenPairs(chain, token),
    listPendingPriceWatchPairs: () => listPendingPriceWatchPairs(),
  });
}

/** The observed USDC price in the fixture is exactly 1. */
function condition(overrides: Record<string, unknown> = {}) {
  return {
    type: TOKEN_PRICE_WATCH_TYPE,
    chain: "base",
    tokenAddress: USDC_BASE,
    direction: "above",
    priceUsd: "1.5",
    ...overrides,
  };
}

beforeEach(() => {
  getTokenPairs.mockReset().mockResolvedValue(usdcPools());
  listPendingPriceWatchPairs.mockReset().mockResolvedValue([]);
});

describe("token_price validation - acceptance", () => {
  it("resolves the chain, normalizes the address and canonicalizes the threshold", async () => {
    const canonical = await evaluator().validate(condition({ priceUsd: "1.500" }), CONTEXT);

    expect(canonical).toMatchObject({
      type: TOKEN_PRICE_WATCH_TYPE,
      chain: "base",
      tokenAddress: USDC_BASE.toLowerCase(),
      direction: "above",
      priceUsd: "1.5",
    });
    // The reference price is captured so a later poll disagreement is
    // diagnosable, and it is the NORMALIZED (watched-token) price.
    expect(canonical.referencePriceUsd).toBe("1");
    expect(getTokenPairs).toHaveBeenCalledWith("base", USDC_BASE.toLowerCase());
  });

  it("accepts a numeric chain id, because token_find hands the model one", async () => {
    const canonical = await evaluator().validate(condition({ chain: "8453" }), CONTEXT);
    expect(canonical.chain).toBe("base");
  });
});

describe("token_price validation - named rejections (the defer still parks)", () => {
  // Pin updated 2026-08-10: solana joined the chain domain, so these two now
  // pin the CLOSED SET and the CROSS-FAMILY rule instead of "EVM only".
  it("rejects a chain outside the supported set by name", async () => {
    await expect(evaluator().validate(condition({ chain: "bitcoin" }), CONTEXT))
      .rejects.toThrow(/not a supported chain/i);
  });

  it("rejects a Solana mint address on an EVM chain by name", async () => {
    await expect(evaluator().validate(
      condition({ tokenAddress: "So11111111111111111111111111111111111111112" }),
      CONTEXT,
    )).rejects.toThrow(/0x/);
  });

  it("rejects a malformed threshold rather than guessing at it", async () => {
    for (const priceUsd of ["", "abc", "-1", "1e9", "1,5"]) {
      await expect(evaluator().validate(condition({ priceUsd }), CONTEXT), priceUsd)
        .rejects.toThrow();
    }
  });

  it("rejects a zero threshold: a price can never cross it downward", async () => {
    await expect(evaluator().validate(condition({ priceUsd: "0", direction: "below" }), CONTEXT))
      .rejects.toThrow(/greater than zero/i);
  });

  it("rejects a token with no priced pool, naming the provider that said so", async () => {
    getTokenPairs.mockResolvedValue([]);
    await expect(evaluator().validate(condition(), CONTEXT))
      .rejects.toThrow(/no priced pool/i);
  });

  it("rejects when the provider call fails, without claiming the token is unpriced", async () => {
    getTokenPairs.mockRejectedValue(new Error("HTTP 429: Too Many Requests"));
    await expect(evaluator().validate(condition(), CONTEXT))
      .rejects.toThrow(/429/);
  });

  it("rejects over budget, by name, counting only PENDING watches", async () => {
    listPendingPriceWatchPairs.mockResolvedValue(
      Array.from({ length: TOKEN_PRICE_WATCH_BUDGET }, (_v, index) => ({
        chain: "base",
        tokenAddress: `0x${String(index).padStart(40, "0")}`,
      })),
    );
    await expect(evaluator().validate(condition(), CONTEXT))
      .rejects.toThrow(new RegExp(`${TOKEN_PRICE_WATCH_BUDGET} `));
  });

  // Ordering matters: the budget bounds ACTIVE WATCHES, and a condition that is
  // already true never becomes one. Checking the budget first would answer "come
  // back later" to a model whose trade is available right now.
  it("reports SATISFIED, not over-budget, when the price has already crossed", async () => {
    listPendingPriceWatchPairs.mockResolvedValue(
      Array.from({ length: TOKEN_PRICE_WATCH_BUDGET }, (_v, index) => ({
        chain: "base",
        tokenAddress: `0x${String(index).padStart(40, "0")}`,
      })),
    );
    const error = await evaluator().validate(condition({ priceUsd: "0.5" }), CONTEXT)
      .then(() => null, (err: unknown) => err);

    expect(isWakeWatchSatisfied(error)).toBe(true);
    expect((error as Error).message).not.toMatch(/budget/i);
  });

  it("admits a token that is ALREADY watched even at budget - it costs no new poll", async () => {
    listPendingPriceWatchPairs.mockResolvedValue(
      Array.from({ length: TOKEN_PRICE_WATCH_BUDGET }, (_v, index) => ({
        chain: "base",
        tokenAddress: index === 0 ? USDC_BASE.toLowerCase() : `0x${String(index).padStart(40, "0")}`,
      })),
    );
    await expect(evaluator().validate(condition(), CONTEXT)).resolves.toMatchObject({
      chain: "base",
    });
  });
});

describe("token_price validation - already satisfied", () => {
  it("refuses to arm when the price is ALREADY above the threshold", async () => {
    const error = await evaluator().validate(condition({ priceUsd: "0.5" }), CONTEXT)
      .then(() => null, (err: unknown) => err);
    expect(isWakeWatchSatisfied(error)).toBe(true);
    expect((error as Error).message).toMatch(/already/i);
    expect((error as Error).message).toContain("1");
  });

  it("refuses to arm when the price is ALREADY below the threshold", async () => {
    const error = await evaluator().validate(condition({ direction: "below", priceUsd: "2" }), CONTEXT)
      .then(() => null, (err: unknown) => err);
    expect(isWakeWatchSatisfied(error)).toBe(true);
  });

  it("treats an exact touch as satisfied, matching the trigger predicate", async () => {
    const error = await evaluator().validate(condition({ priceUsd: "1" }), CONTEXT)
      .then(() => null, (err: unknown) => err);
    expect(isWakeWatchSatisfied(error)).toBe(true);
  });
});

describe("token_price trigger predicate", () => {
  const armed = {
    type: TOKEN_PRICE_WATCH_TYPE,
    chain: "base",
    tokenAddress: USDC_BASE.toLowerCase(),
    direction: "above",
    priceUsd: "1.5",
  };
  const signal = (values: Record<string, string>) => ({ type: TOKEN_PRICE_WATCH_TYPE, values });

  it("fires when the observed price crosses upward, including an exact touch", () => {
    const isTriggered = evaluator().isTriggered;
    for (const observed of ["1.5", "1.50", "1.6", "9999"]) {
      expect(isTriggered(armed, signal({
        chain: "base", tokenAddress: USDC_BASE, priceUsd: observed,
      })), observed).toBe(true);
    }
  });

  it("does not fire below the threshold, at any decimal length", () => {
    const isTriggered = evaluator().isTriggered;
    for (const observed of ["1.4999999999999999999", "0.0001"]) {
      expect(isTriggered(armed, signal({
        chain: "base", tokenAddress: USDC_BASE, priceUsd: observed,
      })), observed).toBe(false);
    }
  });

  it("fires downward only for the below direction", () => {
    const below = { ...armed, direction: "below" };
    const isTriggered = evaluator().isTriggered;
    expect(isTriggered(below, signal({
      chain: "base", tokenAddress: USDC_BASE, priceUsd: "1.4",
    }))).toBe(true);
    expect(isTriggered(below, signal({
      chain: "base", tokenAddress: USDC_BASE, priceUsd: "1.6",
    }))).toBe(false);
  });

  it("fails closed on another token, another chain, another signal type or junk", () => {
    const isTriggered = evaluator().isTriggered;
    expect(isTriggered(armed, signal({
      chain: "arbitrum", tokenAddress: USDC_BASE, priceUsd: "9",
    }))).toBe(false);
    expect(isTriggered(armed, signal({
      chain: "base", tokenAddress: `0x${"1".repeat(40)}`, priceUsd: "9",
    }))).toBe(false);
    expect(isTriggered(armed, { type: "bridge_order_status", values: { activityId: "1" } })).toBe(false);
    expect(isTriggered(armed, signal({
      chain: "base", tokenAddress: USDC_BASE, priceUsd: "not-a-number",
    }))).toBe(false);
    expect(isTriggered({ ...armed, priceUsd: "junk" }, signal({
      chain: "base", tokenAddress: USDC_BASE, priceUsd: "9",
    }))).toBe(false);
    expect(isTriggered({ ...armed, direction: "sideways" }, signal({
      chain: "base", tokenAddress: USDC_BASE, priceUsd: "9",
    }))).toBe(false);
  });
});


// ── Solana (chain domain is a CLOSED set of two families) ──────────

describe("token_price validation - Solana", () => {
  function solanaCondition(overrides: Record<string, unknown> = {}) {
    return {
      type: TOKEN_PRICE_WATCH_TYPE,
      chain: "solana",
      tokenAddress: BONK,
      direction: "above",
      priceUsd: "0.00001",
      ...overrides,
    };
  }

  beforeEach(() => {
    getTokenPairs.mockReset().mockResolvedValue(solanaPools());
    listPendingPriceWatchPairs.mockReset().mockResolvedValue([]);
  });

  it("arms a base58 mint on solana and PRESERVES its case", async () => {
    const canonical = await evaluator().validate(solanaCondition(), CONTEXT);

    expect(canonical).toMatchObject({
      chain: "solana",
      // Base58 is case-SENSITIVE: lowercasing it would name a different mint.
      tokenAddress: BONK,
      direction: "above",
      priceUsd: "0.00001",
    });
    expect(getTokenPairs).toHaveBeenCalledWith("solana", BONK);
  });

  it("accepts the repo's canonical spellings of the Solana chain", async () => {
    for (const chain of ["solana", "sol", "SOL", "Solana", "20011000000"]) {
      const canonical = await evaluator().validate(solanaCondition({ chain }), CONTEXT);
      expect(canonical.chain, chain).toBe("solana");
    }
  });

  it("still reports the satisfied outcome on Solana", async () => {
    const error = await evaluator().validate(solanaCondition({ priceUsd: "0.000001" }), CONTEXT)
      .then(() => null, (err: unknown) => err);
    expect(isWakeWatchSatisfied(error)).toBe(true);
  });

  it("rejects an EVM address on solana, by name", async () => {
    await expect(evaluator().validate(solanaCondition({ tokenAddress: USDC_BASE }), CONTEXT))
      .rejects.toThrow(/base58/i);
    expect(getTokenPairs).not.toHaveBeenCalled();
  });

  it("rejects a base58 mint on an EVM chain, by name", async () => {
    await expect(evaluator().validate(
      solanaCondition({ chain: "base", tokenAddress: BONK }),
      CONTEXT,
    )).rejects.toThrow(/0x/);
    expect(getTokenPairs).not.toHaveBeenCalled();
  });

  it("rejects a chain outside the closed set, naming both families", async () => {
    for (const chain of ["bitcoin", "sui", "999999", "tron"]) {
      const error = await evaluator().validate(solanaCondition({ chain }), CONTEXT)
        .then(() => null, (err: unknown) => err);
      expect((error as Error).message, chain).toMatch(/solana/i);
    }
    expect(getTokenPairs).not.toHaveBeenCalled();
  });

  it("rejects a base58-shaped string that is too short or too long to be a mint", async () => {
    for (const tokenAddress of ["abc", "1".repeat(45), "0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O"]) {
      await expect(
        evaluator().validate(solanaCondition({ tokenAddress }), CONTEXT),
        tokenAddress,
      ).rejects.toThrow();
    }
    expect(getTokenPairs).not.toHaveBeenCalled();
  });
});
