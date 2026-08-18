/**
 * The Blue MARKET gate and the health-factor floor.
 *
 * These are the two predicates standing between the agent and a permissionless
 * lending market, so every case below is a REFUSAL case except the ones that
 * prove an honest market still passes. The refusals are asserted on their code
 * AND on the words they name, because "unsupported market" teaches an agent
 * nothing and the owner's error discipline requires the real cause.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { getAddress } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import {
  MORPHO_MANUAL_ORACLE_ALLOWLIST,
  MORPHO_MARKET_POLICY_CONTRACTS,
} from "../../../tools/morpho/constants.js";

/**
 * LAYER 1, the curation read, stubbed at the module boundary.
 *
 * The gate asks Morpho's API whether it lists the market before it touches the
 * chain at all. `listedAnswer` is what that read returns; setting it to an
 * Error is how a test makes the API unreachable, which must REFUSE rather than
 * fall through to the on-chain layers.
 */
let listedAnswer: boolean | Error = true;
vi.mock("@tools/morpho/client.js", () => ({
  getMorphoClient: () => ({
    getMarketCuration: async ({ marketId }: { marketId: string }) => {
      if (listedAnswer instanceof Error) throw listedAnswer;
      return { marketId, listed: listedAnswer };
    },
  }),
}));
import {
  assertMorphoHealthFactorFloor,
  assertMorphoMarketExecutable,
  formatWad,
  MORPHO_MIN_HEALTH_FACTOR_DECIMAL,
  MORPHO_MIN_HEALTH_FACTOR_WAD,
} from "../../../tools/morpho/mutations/market-policy.js";
import {
  getMorphoActionClient,
  type MorphoActionClient,
} from "../../../tools/morpho/mutations/client.js";

/** Base's real pinned values, so a drift in the constants table fails here. */
const BASE = 8453;
const ADAPTIVE_CURVE_IRM = "0x46415998764C29aB2a25CbeA6254146D50D22687" as const;
const REAL_ORACLE = "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9" as const;
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";

const LOAN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const COLLATERAL = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;
const LLTV_86 = 860_000_000_000_000_000n;

const ZERO = `0x${"0".repeat(40)}`;
/** BTC / USD, the real BASE_FEED_1 of the cbBTC/USDC oracle, and on the list. */
const VERIFIED_FEED = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F";

/**
 * A client that answers the factory question AND the oracle's own leg getters.
 *
 * IT HAS TO ANSWER BOTH, and that is the point of the change these tests cover:
 * the factory's `true` proves only that the implementation is Morpho's audited
 * one, so the gate goes on to read which feeds the oracle actually uses. A stub
 * that answered only the factory would no longer be enough.
 */
const NOW_SECONDS = () => BigInt(Math.floor(Date.now() / 1000));
/** A healthy round: positive answer, reported a minute ago. */
const FRESH_ROUND = () => [1n, 6_400_000_000_000n, NOW_SECONDS(), NOW_SECONDS(), 1n];

function clientAnswering(
  minted: boolean | Error,
  legs: Partial<Record<string, string>> = {},
  roundError: Error | null = null,
  round: readonly bigint[] = FRESH_ROUND(),
  legReadError: Error | null = null,
  onRead: () => void = () => undefined,
): MorphoActionClient {
  // The REAL action client with `readContract` alone replaced. A one-key object
  // literal is not a `MorphoActionClient`, so a hand-built double could only be
  // passed through a type escape - and an escaped double keeps compiling after
  // the client's contract moves. Its transport is never reached: `readContract`
  // is the only action the market gate calls. Same idiom as `gas-bound.test.ts`.
  return Object.assign(getMorphoActionClient(BASE), {
    readContract: async ({ functionName }: { functionName: string }) => {
      onRead();
      if (functionName === "isMorphoChainlinkOracleV2") {
        if (minted instanceof Error) throw minted;
        return minted;
      }
      // THREE DISTINCT READS, kept distinct in the stub because the gate treats
      // their failures differently: which feed the oracle names (a transport
      // failure, so UNKNOWN), and whether that feed answers (a dead feed, so a
      // named policy refusal).
      if (functionName === "latestRoundData") {
        if (roundError !== null) throw roundError;
        return round;
      }
      if (legReadError !== null) throw legReadError;
      // The captured cbBTC/USDC shape: one feed leg, no vault legs.
      return legs[functionName] ?? (functionName === "BASE_FEED_1" ? VERIFIED_FEED : ZERO);
    },
  });
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

    expect(verdict.oracleProvenance).toBe("curated-standard-live");
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

  it("refuses a market that declares NO oracle at all, by its own name", async () => {
    // OBSERVED LIVE 2026-08-18: Morpho's API returned `oracle: null` for market
    // 0x85da4c8b...c648 on chain 4663, a market that HAS a collateral asset. On
    // chain the same absence reads as the zero address. Neither may reach the
    // factory question: there is nothing to ask about, and a null dereference
    // would surface as a TypeError instead of a refusal an agent can act on.
    for (const missing of [ZERO, "0x0", ""]) {
      const error = await assertMorphoMarketExecutable(
        clientAnswering(true), BASE, MARKET_ID, params({ oracle: missing }),
      ).catch((caught: VexError) => caught);

      expect(error).toBeInstanceOf(VexError);
      expect((error as VexError).code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
      expect((error as VexError).message).toContain('FAILING PREDICATE "oracle"');
      expect((error as VexError).message).toContain("declares NO ORACLE at all");
      // NOT the unvouched-oracle refusal: a market with no oracle and a market
      // with an oracle nobody vouched for are different facts.
      expect((error as VexError).message).not.toContain("did not mint it");
    }
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

/**
 * LAYER 1: does Morpho actually curate this market?
 *
 * The main filter, and the one measurement justified it. The two ruinous
 * markets found in the 2026-08-17 survey - K/USDC on Arbitrum (4.89B USD
 * reported, feed 335 days stale) and sdeUSD/USDC on Ethereum (2.97B USD, feed
 * reverting) - are both `listed: false`. Morpho Blue lets anyone open a market;
 * `listed` is the difference between one a curator stands behind and one that
 * merely exists.
 */
describe("Morpho market curation", () => {
  afterEach(() => { listedAnswer = true; });

  it("REFUSES an uncurated market by name, saying Morpho does not curate it", async () => {
    listedAnswer = false;
    const error = await assertMorphoMarketExecutable(clientAnswering(true), BASE, MARKET_ID, params())
      .catch((caught: VexError) => caught) as VexError;

    expect(error.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "listed"');
    expect(error.message).toContain("does not curate");
    // The reason must be curation, NOT "no such market": the market is real.
    expect(error.message).toContain("The market EXISTS");
  });

  it("REFUSES rather than falling through when the curation read fails", async () => {
    // The critical negative: an unreachable API must NOT be treated as a pass
    // on the strength of the on-chain layers alone.
    listedAnswer = new Error("morpho api unreachable");
    const error = await assertMorphoMarketExecutable(clientAnswering(true), BASE, MARKET_ID, params())
      .catch((caught: VexError) => caught) as VexError;

    expect(error.code).toBe(ErrorCodes.MORPHO_RPC_ERROR);
    expect(error.message).toContain("UNKNOWN rather than acceptable");
    expect(error.hint).toContain("morpho api unreachable");
  });

  it("checks curation BEFORE spending any chain reads on the oracle", async () => {
    // Cheapest-and-broadest first: an uncurated market costs one API call, not
    // a round trip per feed leg.
    listedAnswer = false;
    let chainReads = 0;
    const counting = clientAnswering(true, {}, null, FRESH_ROUND(), null, () => { chainReads += 1; });

    await assertMorphoMarketExecutable(counting, BASE, MARKET_ID, params()).catch(() => undefined);
    expect(chainReads).toBe(0);
  });
});

/**
 * LAYER 3: is every price leg still answering?
 *
 * The only layer that sees the present moment. Curation is a judgement made
 * once and the factory check is about bytecode; neither notices a feed that
 * went silent afterwards, and the survey found feeds 25, 76, 149, 241 and 335
 * days stale still pricing funded markets.
 */
describe("Morpho oracle feed liveness", () => {
  const DAY = 86_400n;
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  async function refuse(round: readonly bigint[]): Promise<VexError> {
    try {
      await assertMorphoMarketExecutable(
        clientAnswering(true, { BASE_FEED_1: VERIFIED_FEED }, null, round), BASE, MARKET_ID, params(),
      );
    } catch (caught) {
      return caught as VexError;
    }
    throw new Error("expected the gate to refuse a feed that is not answering");
  }

  it("accepts a feed reporting a fresh, positive round", async () => {
    const verdict = await assertMorphoMarketExecutable(
      clientAnswering(true, { BASE_FEED_1: VERIFIED_FEED }, null, [1n, 6_400_000_000_000n, now(), now(), 1n]),
      BASE, MARKET_ID, params(),
    );
    expect(verdict.oracleProvenance).toBe("curated-standard-live");
  });

  it("REFUSES a feed whose round has gone stale, naming the age", async () => {
    // The 335-day Arbitrum corpse, in miniature.
    const stale = now() - 335n * DAY;
    const error = await refuse([1n, 6_400_000_000_000n, stale, stale, 1n]);

    expect(error.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "oracle-feed-live"');
    expect(error.message).toContain("335");
    expect(error.message).toContain("stopped tracking reality");
  });

  it("REFUSES a feed answering zero or a negative price", async () => {
    expect((await refuse([1n, 0n, now(), now(), 1n])).message).toContain("not a positive price");
    expect((await refuse([1n, -5n, now(), now(), 1n])).message).toContain("not a positive price");
  });

  it("REFUSES a REVERTING feed by name rather than skipping the check", async () => {
    // sdeUSD/USDC's failure mode. A feed that will not answer cannot be shown
    // to price the collateral at all, so it is a refusal and not a pass.
    let error: VexError | null = null;
    try {
      await assertMorphoMarketExecutable(
        clientAnswering(true, { BASE_FEED_1: VERIFIED_FEED }, new Error("execution reverted")),
        BASE, MARKET_ID, params(),
      );
    } catch (caught) {
      error = caught as VexError;
    }
    expect(error?.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error?.message).toContain("did not answer latestRoundData");
  });

  it("ADMITS an exchange-rate adapter reporting no round, on a positive answer alone", async () => {
    // wstETH/stETH and weETH/ETH class: derived from live chain state, so
    // updatedAt is structurally 0 and there is no round to be stale. Safe here
    // only because layers 1 and 2 already established a curated market behind a
    // factory-minted oracle.
    const verdict = await assertMorphoMarketExecutable(
      clientAnswering(true, { BASE_FEED_1: VERIFIED_FEED }, null, [0n, 1_100_000_000_000_000_000n, 0n, 0n, 0n]),
      BASE, MARKET_ID, params(),
    );
    expect(verdict.oracleProvenance).toBe("curated-standard-live");
  });

  it("still requires a POSITIVE answer from a no-round adapter", async () => {
    expect((await refuse([0n, 0n, 0n, 0n, 0n])).message).toContain("not a positive price");
  });

  it("checks EVERY feed getter, not just the first", async () => {
    // A dead second leg behind a healthy first is the obvious way past a check
    // that stopped at BASE_FEED_1. The stub returns the same stale round for
    // whichever feed is read, so a pass here would mean QUOTE_FEED_2 was skipped.
    const stale = now() - 200n * DAY;
    let error: VexError | null = null;
    try {
      await assertMorphoMarketExecutable(
        clientAnswering(true, { BASE_FEED_1: ZERO, QUOTE_FEED_2: VERIFIED_FEED }, null,
          [1n, 6_400_000_000_000n, stale, stale, 1n]),
        BASE, MARKET_ID, params(),
      );
    } catch (caught) {
      error = caught as VexError;
    }
    expect(error?.message).toContain("QUOTE_FEED_2");
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

/**
 * THE OWNER'S MANUAL ORACLE ALLOWLIST, and the exact size of the hole it opens.
 *
 * An entry there is a human standing in for LAYER 2 and for nothing else. The
 * tests that matter here are therefore the two INDEPENDENCE ones: an allowlisted
 * oracle on a market Morpho does not curate is still refused, and an allowlisted
 * oracle whose feed has gone stale is still refused. If either of those ever
 * passes, the allowlist stopped being an implementation exception and became a
 * way to put real funds behind an unpriced position.
 */
describe("Morpho owner-vouched oracle allowlist", () => {
  const ETHEREUM = 1;
  const ETHEREUM_IRM = "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC" as const;
  const VOUCHED = MORPHO_MANUAL_ORACLE_ALLOWLIST[ETHEREUM]?.[0];
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  afterEach(() => { listedAnswer = true; });

  /**
   * The chain-1 twin of `clientAnswering`, with the factory answering FALSE.
   * That is the whole premise: these oracles exist precisely because the pinned
   * V2 factory does not vouch for them.
   */
  function ethereumClient(round: readonly bigint[] = FRESH_ROUND()): MorphoActionClient {
    return Object.assign(getMorphoActionClient(ETHEREUM), {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "isMorphoChainlinkOracleV2") return false;
        if (functionName === "latestRoundData") return round;
        return functionName === "BASE_FEED_1" ? VERIFIED_FEED : ZERO;
      },
    });
  }

  function vouchedParams() {
    return {
      loanToken: LOAN,
      collateralToken: COLLATERAL,
      oracle: (VOUCHED?.oracle ?? ZERO) as typeof LOAN,
      irm: ETHEREUM_IRM,
      lltv: LLTV_86,
    };
  }

  it("carries the WBTC/USDC entry the owner vouched for, with re-verifiable evidence", () => {
    expect(VOUCHED?.oracle).toBe("0xDddd770BADd886dF3864029e4B377B5F6a2B6b83");
    expect(VOUCHED?.marketId).toBe("0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49");
    expect(VOUCHED?.vouchedBy).toBe("owner");
    expect(VOUCHED?.verifiedOn).toBe("2026-08-17");
    // The evidence must name the implementation and the reason the factory abstains,
    // or a future reader cannot re-verify it without re-deriving the whole check.
    expect(VOUCHED?.evidence).toContain("ChainlinkOracle");
    expect(VOUCHED?.evidence).toContain("Sourcify");
  });

  it("admits the vouched oracle end to end, as owner-allowlist provenance", async () => {
    const verdict = await assertMorphoMarketExecutable(
      ethereumClient(), ETHEREUM, VOUCHED?.marketId ?? MARKET_ID, vouchedParams(),
    );

    expect(verdict.oracleProvenance).toBe("owner-allowlist");
    expect(verdict.oracle).toBe(VOUCHED?.oracle.toLowerCase());
    // The verdict must still claim curation and liveness, because both were checked.
    expect(verdict.explanation).toContain("owner-vouched allowlist");
    expect(verdict.explanation).toContain("live positive price");
  });

  it("LAYER 1 STILL APPLIES: an allowlisted oracle on an UNCURATED market is refused", async () => {
    listedAnswer = false;
    const error = await assertMorphoMarketExecutable(
      ethereumClient(), ETHEREUM, VOUCHED?.marketId ?? MARKET_ID, vouchedParams(),
    ).catch((caught: VexError) => caught) as VexError;

    expect(error.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "listed"');
  });

  it("LAYER 3 STILL APPLIES: an allowlisted oracle with a STALE feed is refused", async () => {
    const stale = now() - 300n * 86_400n;
    const error = await assertMorphoMarketExecutable(
      ethereumClient([1n, 6_400_000_000_000n, stale, stale, 1n]),
      ETHEREUM, VOUCHED?.marketId ?? MARKET_ID, vouchedParams(),
    ).catch((caught: VexError) => caught) as VexError;

    expect(error.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "oracle-feed-live"');
    expect(error.message).toContain("300");
  });

  it("LAYER 3 STILL APPLIES: an allowlisted oracle whose feed answers zero is refused", async () => {
    const error = await assertMorphoMarketExecutable(
      ethereumClient([1n, 0n, now(), now(), 1n]),
      ETHEREUM, VOUCHED?.marketId ?? MARKET_ID, vouchedParams(),
    ).catch((caught: VexError) => caught) as VexError;

    expect(error.message).toContain("not a positive price");
  });

  it("refuses an oracle NOT on the list even on a chain whose list is non-empty", async () => {
    const stranger = "0x000000000000000000000000000000000badc0de";
    const error = await assertMorphoMarketExecutable(
      ethereumClient(), ETHEREUM, MARKET_ID, { ...vouchedParams(), oracle: stranger as typeof LOAN },
    ).catch((caught: VexError) => caught) as VexError;

    expect(error.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "oracle"');
    // The message must not still claim the list is empty once it is not.
    expect(error.message).not.toContain("which is empty");
    expect(error.message).toContain("1 other oracle(s)");
  });

  it("holds a well-formed list: checksummed, unique, and only on chains Vex pins", () => {
    const seen = new Set<string>();
    for (const [rawChainId, entries] of Object.entries(MORPHO_MANUAL_ORACLE_ALLOWLIST)) {
      const chainId = Number(rawChainId);
      // A chain with no pinned policy contracts has no IRM to check either, so
      // an entry there could never be reached and would be a silent dead rule.
      expect(MORPHO_MARKET_POLICY_CONTRACTS[chainId]).toBeDefined();
      for (const entry of entries) {
        // Checksummed, so an entry can be pasted into an explorer as written and
        // a typo shows up as a checksum failure rather than as a wrong contract.
        expect(getAddress(entry.oracle)).toBe(entry.oracle);
        expect(entry.marketId).toMatch(/^0x[0-9a-f]{64}$/);
        expect(entry.vouchedBy.length).toBeGreaterThan(0);
        expect(entry.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(entry.evidence.length).toBeGreaterThan(80);
        const key = `${chainId}:${entry.oracle.toLowerCase()}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
