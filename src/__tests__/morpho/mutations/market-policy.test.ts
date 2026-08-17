/**
 * The Blue MARKET gate and the health-factor floor.
 *
 * These are the two predicates standing between the agent and a permissionless
 * lending market, so every case below is a REFUSAL case except the ones that
 * prove an honest market still passes. The refusals are asserted on their code
 * AND on the words they name, because "unsupported market" teaches an agent
 * nothing and the owner's error discipline requires the real cause.
 */

import { describe, it, expect } from "vitest";

import { VexError, ErrorCodes } from "../../../errors.js";
import {
  assertMorphoHealthFactorFloor,
  assertMorphoMarketExecutable,
  formatWad,
  MORPHO_MIN_HEALTH_FACTOR_DECIMAL,
  MORPHO_MIN_HEALTH_FACTOR_WAD,
} from "../../../tools/morpho/mutations/market-policy.js";
import type { MorphoActionClient } from "../../../tools/morpho/mutations/client.js";

/** Base's real pinned values, so a drift in the constants table fails here. */
const BASE = 8453;
const ADAPTIVE_CURVE_IRM = "0x46415998764C29aB2a25CbeA6254146D50D22687" as const;
const REAL_ORACLE = "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9" as const;
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";

const LOAN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const COLLATERAL = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;
const LLTV_86 = 860_000_000_000_000_000n;

/**
 * A client whose ONLY behaviour is the factory answer. The gate must not need
 * anything else, and a stub this small proves it does not.
 */
function clientAnswering(minted: boolean | Error): MorphoActionClient {
  return {
    readContract: async () => {
      if (minted instanceof Error) throw minted;
      return minted;
    },
  } as unknown as MorphoActionClient;
}

function params(overrides: Partial<{ oracle: string; irm: string; lltv: bigint }> = {}) {
  return {
    loanToken: LOAN,
    collateralToken: COLLATERAL,
    oracle: (overrides.oracle ?? REAL_ORACLE) as typeof REAL_ORACLE,
    irm: (overrides.irm ?? ADAPTIVE_CURVE_IRM) as typeof ADAPTIVE_CURVE_IRM,
    lltv: overrides.lltv ?? LLTV_86,
  };
}

describe("Morpho Blue market policy", () => {
  it("accepts a market whose IRM is pinned and whose oracle the factory minted", async () => {
    const verdict = await assertMorphoMarketExecutable(clientAnswering(true), BASE, MARKET_ID, params());

    expect(verdict.oracleProvenance).toBe("chainlink-oracle-factory");
    expect(verdict.irm).toBe(ADAPTIVE_CURVE_IRM.toLowerCase());
    expect(verdict.oracle).toBe(REAL_ORACLE.toLowerCase());
    expect(verdict.lltvDecimal).toBe("0.86");
    expect(verdict.marketId).toBe(MARKET_ID);
  });

  it("refuses a market whose IRM is not the chain's AdaptiveCurveIRM, naming the predicate", async () => {
    const hostileIrm = "0x00000000000000000000000000000000deadbeef";
    await expect(
      assertMorphoMarketExecutable(clientAnswering(true), BASE, MARKET_ID, params({ irm: hostileIrm })),
    ).rejects.toMatchObject({ code: ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION });

    const error = await assertMorphoMarketExecutable(
      clientAnswering(true), BASE, MARKET_ID, params({ irm: hostileIrm }),
    ).catch((caught: VexError) => caught);

    expect(error).toBeInstanceOf(VexError);
    expect((error as VexError).message).toContain('FAILING PREDICATE "irm"');
    expect((error as VexError).message).toContain(hostileIrm);
    expect((error as VexError).message).toContain(ADAPTIVE_CURVE_IRM.toLowerCase());
  });

  it("refuses an oracle the factory did not mint, and says the allowlist is empty", async () => {
    const hostileOracle = "0x000000000000000000000000000000000badc0de";
    const error = await assertMorphoMarketExecutable(
      clientAnswering(false), BASE, MARKET_ID, params({ oracle: hostileOracle }),
    ).catch((caught: VexError) => caught);

    expect(error).toBeInstanceOf(VexError);
    expect((error as VexError).code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect((error as VexError).message).toContain('FAILING PREDICATE "oracle"');
    expect((error as VexError).message).toContain("did not mint it");
    expect((error as VexError).message).toContain("which is empty");
  });

  it("refuses a market on a chain with no pinned policy contracts", async () => {
    const error = await assertMorphoMarketExecutable(clientAnswering(true), 12345, MARKET_ID, params())
      .catch((caught: VexError) => caught);

    expect((error as VexError).code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect((error as VexError).message).toContain("no pinned Morpho market-policy contracts for chain 12345");
  });

  it("treats an UNREACHABLE factory as unknown, not as a refusal or an acceptance", async () => {
    // Rules/90: a definitive refusal and an ambiguous transport failure must not
    // be collapsed. A market whose oracle could not be checked is neither
    // accepted nor branded hostile.
    const error = await assertMorphoMarketExecutable(
      clientAnswering(new Error("connection reset")), BASE, MARKET_ID, params(),
    ).catch((caught: VexError) => caught);

    expect((error as VexError).code).toBe(ErrorCodes.MORPHO_RPC_ERROR);
    expect((error as VexError).code).not.toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect((error as VexError).message).toContain("UNKNOWN rather than false");
    // The REAL cause survives to the agent rather than being flattened into a
    // generic failure, per the owner's tool-error decree.
    expect((error as VexError).hint).toContain("connection reset");
  });
});

describe("Morpho health factor floor", () => {
  it("is 1.25 in WAD, and the decimal label agrees with the number", () => {
    expect(MORPHO_MIN_HEALTH_FACTOR_WAD).toBe(1_250_000_000_000_000_000n);
    expect(formatWad(MORPHO_MIN_HEALTH_FACTOR_WAD)).toBe(MORPHO_MIN_HEALTH_FACTOR_DECIMAL);
  });

  it("passes a position with no debt, which cannot be liquidated", () => {
    expect(() => assertMorphoHealthFactorFloor(null, "borrow")).not.toThrow();
  });

  it("passes exactly at the floor", () => {
    expect(() => assertMorphoHealthFactorFloor(MORPHO_MIN_HEALTH_FACTOR_WAD, "borrow")).not.toThrow();
  });

  it("refuses one wei below the floor, so the boundary is not a rounding opinion", () => {
    expect(() => assertMorphoHealthFactorFloor(MORPHO_MIN_HEALTH_FACTOR_WAD - 1n, "borrow"))
      .toThrow(VexError);
  });

  it("refuses a health factor the CHAIN would accept, and names both numbers", () => {
    // 1.0275, the value the fork measured at 90% of remaining borrow capacity:
    // above 1.0, so Morpho would allow it, and below Vex's floor.
    const chainWouldAllow = 1_027_531_177_813_067_305n;
    let thrown: VexError | undefined;
    try {
      assertMorphoHealthFactorFloor(chainWouldAllow, "borrow");
    } catch (error) {
      thrown = error as VexError;
    }

    expect(thrown?.code).toBe(ErrorCodes.MORPHO_HEALTH_FACTOR_FLOOR);
    expect(thrown?.message).toContain("1.027531177813067305");
    expect(thrown?.message).toContain(MORPHO_MIN_HEALTH_FACTOR_DECIMAL);
    expect(thrown?.message).toContain("no close factor");
    expect(thrown?.message).toContain("above 1.0");
    expect(thrown?.hint).toContain("Borrow less");
  });

  it("says a sub-1.0 projection would be liquidatable on landing", () => {
    let thrown: VexError | undefined;
    try {
      assertMorphoHealthFactorFloor(950_000_000_000_000_000n, "borrow");
    } catch (error) {
      thrown = error as VexError;
    }
    expect(thrown?.message).toContain("liquidatable the moment the transaction lands");
  });

  it("names the operation it refused, so the agent knows which leg to resize", () => {
    let thrown: VexError | undefined;
    try {
      assertMorphoHealthFactorFloor(1_000_000_000_000_000_000n, "withdraw collateral");
    } catch (error) {
      thrown = error as VexError;
    }
    expect(thrown?.message).toContain("Refusing this withdraw collateral");
    expect(thrown?.hint).toContain("supply more collateral");
  });
});
