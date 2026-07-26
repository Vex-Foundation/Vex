import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import {
  assertClaimSafe,
  decodeClaimCall,
  type PendleClaimIntent,
} from "@vex-agent/tools/protocols/pendle/calldata.js";
import {
  PENDLE_CLAIM_ABI,
  PENDLE_SWAP_HELPER,
} from "@tools/pendle/constants.js";
import { ErrorCodes } from "../../../../../errors.js";
import { PENDLE_LIVE_FIXTURES as F } from "./fixtures.js";
import { mutableClaimFixture } from "./validated-fixtures.js";

// The populated fixture is a LIVE probe for a real SIERRA-YT holder (see
// fixtures.ts): tuple {yt, doRedeemInterest:true, doRedeemRewards:false,
// tokenRedeemSy == the market's underlyingAsset, minTokenRedeemOut > 0} and
// tokenApprovals == [the market's SY] (the Router pulls the freshly-redeemed SY
// interest — ActionMiscV3.sol:117-126).
const CLAIM_WALLET = getAddress("0x6a1372b4fb791a50f58f0249cf82ebbc69b1a6ac");
const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const YT_SIERRA = getAddress("0xdf0bd47a116be19f2d4a2577372bd773060a01dc");
const MARKET_SIERRA = getAddress("0x1f40b9a1d21afedbe3c49776e7790ed2139ec075");
const SIERRA_UNDERLYING = "0x6bf7788eaa948d9ffba7e9bb386e2d3c9810e0fc";
const SIERRA_SY = "0x399e426e6812943ac22976333698e16eaa80a209";
const ATTACKER = getAddress("0xdEAD000000000000000000000000000000000000");

function claimIntent(over: Partial<PendleClaimIntent> = {}): PendleClaimIntent {
  return {
    wallet: CLAIM_WALLET,
    intendedYts: new Map([[YT_SIERRA.toLowerCase(), { tokenRedeemSy: SIERRA_UNDERLYING, sy: SIERRA_SY }]]),
    intendedMarkets: new Set([MARKET_SIERRA.toLowerCase()]),
    ...over,
  };
}

/** Re-encode a claim call with mutated decoded args (still ABI-valid). */
function tamperClaim(data: string, mutate: (args: unknown[]) => void): string {
  const decoded = decodeFunctionData({ abi: PENDLE_CLAIM_ABI, data: data as Hex });
  const args = structuredClone(decoded.args) as unknown[];
  mutate(args);
  return encodeFunctionData({ abi: PENDLE_CLAIM_ABI, functionName: decoded.functionName, args: args as never });
}

/** The decoded YT tuple shape inside tamperClaim mutations. */
interface TamperYtTuple {
  yt: string;
  doRedeemInterest: boolean;
  doRedeemRewards: boolean;
  tokenRedeemSy: string;
  minTokenRedeemOut: bigint;
}

function expectUnsafe(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected PENDLE_UNSAFE_TX, but the call succeeded");
  } catch (err) {
    expect((err as { code?: string }).code).toBe(ErrorCodes.PENDLE_UNSAFE_TX);
  }
}

function firstTuple(args: unknown[]): TamperYtTuple {
  const tuples = args[1] as TamperYtTuple[];
  const tuple = tuples[0];
  if (tuple === undefined) {
    throw new Error("claim fixture must contain a YT tuple");
  }
  return tuple;
}

describe("pendle claim (income sweep) — decode + clean", () => {
  it("decodes the live EMPTY claim (pure sweep — SYs/YTs/markets/swaps empty; pinned pendleSwap)", () => {
    const call = decodeClaimCall(F.claim.tx.data);
    expect(call.yts).toEqual([]);
    expect(call.markets).toEqual([]);
    expect(call.pendleSwap).toBe(PENDLE_SWAP_HELPER);
  });

  it("accepts the LIVE populated claim (tuple + SY approval bound)", () => {
    const call = assertClaimSafe(claimIntent(), mutableClaimFixture(F.claimPopulated));
    const yt = call.yts[0];
    if (yt === undefined) {
      throw new Error("populated claim should include a YT tuple");
    }
    expect(call.yts).toHaveLength(1);
    expect(yt.yt).toBe(YT_SIERRA);
    expect(yt.doRedeemInterest).toBe(true);
    expect(yt.tokenRedeemSy.toLowerCase()).toBe(SIERRA_UNDERLYING);
    // The SDK's slippage floor is decoded but NOT value-bound (it is protection).
    expect(yt.minTokenRedeemOut > 0n).toBe(true);
    expect(call.markets).toEqual([]);
  });

  it("accepts the empty live claim (server pruned nothing in)", () => {
    const call = assertClaimSafe(claimIntent({ wallet: WALLET }), mutableClaimFixture(F.claim));
    expect(call.yts).toEqual([]);
    expect(call.markets).toEqual([]);
  });
});

describe("pendle claim — poisoned matrix (each rejects, no sign)", () => {
  it("wrong tx.to (not the Router)", () => {
    const resp = mutableClaimFixture(F.claimPopulated); resp.tx.to = ATTACKER;
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("wrong tx.from (not the wallet)", () => {
    const resp = mutableClaimFixture(F.claimPopulated); resp.tx.from = ATTACKER;
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("non-zero native value", () => {
    const resp = mutableClaimFixture(F.claimPopulated); resp.tx.value = "1";
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("foreign YT (outside the intended positions)", () => {
    expectUnsafe(() => assertClaimSafe(claimIntent({ intendedYts: new Map() }), mutableClaimFixture(F.claimPopulated)));
  });
  it("foreign market smuggled into the markets list", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tx.data = tamperClaim(resp.tx.data, (args) => { (args[2] as unknown[]).push(ATTACKER); });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("populated swaps (the only external-call surface) is rejected", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tx.data = tamperClaim(resp.tx.data, (args) => {
      (args[4] as unknown[]).push({
        tokenIn: ATTACKER, tokenOut: ATTACKER, minOut: 0n,
        swapData: { swapType: 0, extRouter: ATTACKER, extCalldata: "0x", needScale: false },
      });
    });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("non-empty SYs leg is rejected", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tx.data = tamperClaim(resp.tx.data, (args) => { (args[0] as unknown[]).push(ATTACKER); });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("FOREIGN pendleSwap helper is rejected (defense-in-depth over the source-proven inert arg)", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tx.data = tamperClaim(resp.tx.data, (args) => { args[3] = ATTACKER; });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("WRONG tokenRedeemSy (interest redeemed into an unexpected token)", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tx.data = tamperClaim(resp.tx.data, (args) => { firstTuple(args).tokenRedeemSy = ATTACKER; });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("no-op YT tuple (both redeem flags false) is rejected", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tx.data = tamperClaim(resp.tx.data, (args) => {
      firstTuple(args).doRedeemInterest = false; // doRedeemRewards is false in the live tuple
    });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("FOREIGN approval token (outside the intended SYs)", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tokenApprovals[0].token = ATTACKER;
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("duplicate approval token is rejected", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tokenApprovals.push({ ...resp.tokenApprovals[0] });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("non-positive approval amount is rejected", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    resp.tokenApprovals[0].amount = "0";
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("an SY approval without a matching doRedeemInterest tuple is rejected", () => {
    const resp = mutableClaimFixture(F.claimPopulated);
    // Flip the tuple to rewards-only (NOT a no-op) — the SY approval then has no
    // interest leg to justify it, so the allowed set is empty.
    resp.tx.data = tamperClaim(resp.tx.data, (args) => {
      const tuple = firstTuple(args);
      tuple.doRedeemInterest = false;
      tuple.doRedeemRewards = true;
    });
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
  it("unknown selector is rejected", () => {
    const resp = mutableClaimFixture(F.claimPopulated); resp.tx.data = "0xdeadbeef" + resp.tx.data.slice(10);
    expectUnsafe(() => assertClaimSafe(claimIntent(), resp));
  });
});
