/**
 * The input contract of the five Morpho Blue MARKET tools.
 *
 * These are not schema tests. Every case below is a MONEY-PATH refusal: an
 * amount key that names a different token at a different scale, a parameter that
 * would redirect where borrowed funds land, or two parameters that disagree
 * about how much debt to clear. Rules/90 requires each of them to be refused BY
 * NAME rather than dropped, because a silent drop hides an attempt to move
 * something the caller did not authorise.
 */

import { describe, expect, it } from "vitest";

import {
  MORPHO_MARKET_DIRECTIONS,
  morphoAmountKey,
  morphoEngineOperation,
  parseMorphoMarketExecuteParams,
  parseMorphoMarketQuoteParams,
  type MorphoMarketDirection,
} from "../../../../../vex-agent/tools/protocols/morpho/read-params.js";

const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";

function baseParams(direction: MorphoMarketDirection): Record<string, unknown> {
  return direction === "repay"
    ? { marketId: MARKET_ID, chain: "base", repayFullDebt: true }
    : { marketId: MARKET_ID, chain: "base", [morphoAmountKey(direction)]: "1000000" };
}

function rejectionOf(result: ReturnType<typeof parseMorphoMarketExecuteParams>): string {
  if (result.ok) throw new Error("expected a refusal, got an accepted query");
  return result.rejection.message;
}

describe("morpho market params: each operation's own amount key", () => {
  it("accepts every direction with its own key", () => {
    for (const direction of MORPHO_MARKET_DIRECTIONS) {
      const parsed = parseMorphoMarketExecuteParams(`morpho.market.${direction}`, direction, baseParams(direction));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.operation).toBe(morphoEngineOperation(direction));
        expect(parsed.value.marketId).toBe(MARKET_ID);
      }
    }
  });

  // The full cross product: 4 tools x 3 wrong keys. A collateral amount reaching
  // a borrow is a hundredfold error on a market pairing 8-decimal collateral
  // with 6-decimal debt, so every pairing is refused, not just the obvious one.
  it("REFUSES every other operation's amount key BY NAME, on all four tools", () => {
    for (const direction of MORPHO_MARKET_DIRECTIONS) {
      for (const other of MORPHO_MARKET_DIRECTIONS) {
        if (other === direction) continue;
        const params = { ...baseParams(direction), [morphoAmountKey(other)]: "999" };
        const message = rejectionOf(
          parseMorphoMarketExecuteParams(`morpho.market.${direction}`, direction, params),
        );
        expect(message).toContain(morphoAmountKey(other));
        expect(message).toContain(direction);
      }
    }
  });

  it("names the DIFFERENT TOKEN when the wrong key is denominated in the other one", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.borrow", "borrow", {
        ...baseParams("borrow"),
        supplyCollateralAmountRaw: "50000000",
      }),
    );
    expect(message).toMatch(/different tokens/);
    expect(message).toMatch(/decimal scale/);
  });

  it("refuses a human decimal amount rather than rounding it", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.borrow", "borrow", {
        marketId: MARKET_ID,
        chain: "base",
        borrowAmountRaw: "1.5",
      }),
    );
    expect(message).toMatch(/RAW base units/);
    expect(message).toMatch(/thousandfold/);
  });

  it("refuses a 40-hex CONTRACT ADDRESS where a 64-hex market id belongs", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.borrow", "borrow", {
        marketId: "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9",
        chain: "base",
        borrowAmountRaw: "1000000",
      }),
    );
    expect(message).toMatch(/CONTRACT ADDRESS/);
  });
});

describe("morpho market params: what an execute will never take from a model", () => {
  it("REFUSES walletAddress, so nothing can redirect where borrowed funds land", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.borrow", "borrow", {
        ...baseParams("borrow"),
        walletAddress: "0x33ef6673bd80cb11fcc41b82bc2181e65cc4d2fa",
      }),
    );
    expect(message).toContain("walletAddress");
    expect(message).toMatch(/session's selected wallet/);
  });

  it("REFUSES a direction param, so there is only one way to say which way money moves", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.borrow", "borrow", {
        ...baseParams("borrow"),
        direction: "repay",
      }),
    );
    expect(message).toContain("direction");
  });

  it("REFUSES repayFullDebt on an operation that is not a repayment", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.borrow", "borrow", {
        ...baseParams("borrow"),
        repayFullDebt: true,
      }),
    );
    expect(message).toContain("repayFullDebt");
  });
});

describe("morpho market params: the two repayment modes", () => {
  it("routes repayFullDebt to the shares path with NO amount of its own", () => {
    const parsed = parseMorphoMarketExecuteParams("morpho.market.repay", "repay", {
      marketId: MARKET_ID,
      chain: "base",
      repayFullDebt: true,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.repayFullDebt).toBe(true);
      // The size is the position's own share count, read from the chain later.
      expect(parsed.value.amountRaw).toBeNull();
    }
  });

  it("keeps a partial repayment denominated in assets", () => {
    const parsed = parseMorphoMarketExecuteParams("morpho.market.repay", "repay", {
      marketId: MARKET_ID,
      chain: "base",
      repayAmountRaw: "200000000",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.repayFullDebt).toBe(false);
      expect(parsed.value.amountRaw).toBe(200000000n);
    }
  });

  it("REFUSES both together rather than choosing how much debt to clear", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.repay", "repay", {
        marketId: MARKET_ID,
        chain: "base",
        repayFullDebt: true,
        repayAmountRaw: "200000000",
      }),
    );
    expect(message).toMatch(/disagree/);
  });

  it("requires a size: neither mode named is a refusal, not a default", () => {
    const message = rejectionOf(
      parseMorphoMarketExecuteParams("morpho.market.repay", "repay", {
        marketId: MARKET_ID,
        chain: "base",
      }),
    );
    expect(message).toContain("repayAmountRaw");
  });
});

describe("morpho.market.quote params", () => {
  it("requires a direction and names the four", () => {
    const parsed = parseMorphoMarketQuoteParams({ marketId: MARKET_ID, chain: "base" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      for (const direction of MORPHO_MARKET_DIRECTIONS) {
        expect(parsed.rejection.message).toContain(direction);
      }
    }
  });

  it("refuses a direction it does not have a tool for", () => {
    const parsed = parseMorphoMarketQuoteParams({
      marketId: MARKET_ID,
      chain: "base",
      direction: "liquidate",
      borrowAmountRaw: "1",
    });
    expect(parsed.ok).toBe(false);
  });

  it("ACCEPTS walletAddress, because a health factor has no meaning without a position", () => {
    const parsed = parseMorphoMarketQuoteParams({
      marketId: MARKET_ID,
      chain: "base",
      direction: "borrow",
      borrowAmountRaw: "500000000",
      walletAddress: "0x33EF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.walletAddress).toBe("0x33ef6673bd80cb11fcc41b82bc2181e65cc4d2fa");
    }
  });

  it("echoes the direction, so a recorded quote can be paired with ONE execute", () => {
    for (const direction of MORPHO_MARKET_DIRECTIONS) {
      const parsed = parseMorphoMarketQuoteParams({ ...baseParams(direction), direction });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.echo["direction"]).toBe(direction);
    }
  });

  it("refuses an unsupported chain by name rather than defaulting to one", () => {
    const parsed = parseMorphoMarketQuoteParams({
      marketId: MARKET_ID,
      chain: "dogecoin",
      direction: "borrow",
      borrowAmountRaw: "1000000",
    });
    expect(parsed.ok).toBe(false);
  });
});
