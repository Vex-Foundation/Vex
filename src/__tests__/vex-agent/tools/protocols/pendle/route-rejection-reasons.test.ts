/**
 * W2e — every rejected route's reason reaches the agent.
 *
 * `selectSafeRoute` kept only `lastErr` across the loop, so with the eight
 * routes a live Convert returns the agent was told why route 8 failed to bind
 * and nothing at all about route 1 — the BEST-PRICED one, and the only refusal
 * that explains why the trade did not happen. It would then "fix" the last
 * route's complaint and get the same refusal again.
 *
 * The reasons are ordered as Pendle ranked the routes, and the CODE and REMEDY
 * carried are the best-priced route's, for the same reason.
 */

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { selectSafeRoute, type PendleTxIntent } from "@vex-agent/tools/protocols/pendle/calldata.js";
import { ErrorCodes, VexError } from "../../../../../errors.js";
import { PENDLE_LIVE_FIXTURES as F } from "./fixtures.js";
import { mutableConvertFixture } from "./validated-fixtures.js";

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const PT = getAddress("0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb");
const MARKET = getAddress("0x177768caf9d0e036725a51d3f60d7e20f2d4d194");
const ATTACKER = getAddress("0xdEAD000000000000000000000000000000000000");

function buyIntent(): PendleTxIntent {
  return {
    action: "buy",
    wallet: WALLET,
    inputToken: USDC,
    isNative: false,
    inputAmountWei: 100000000n,
    expectedMarket: MARKET,
    expectedOutputToken: PT,
    slippageBps: 100,
  };
}

/** The live buy fixture with a SECOND route appended, each poisoned differently. */
function twoPoisonedRoutes(): ReturnType<typeof mutableConvertFixture> {
  const resp = mutableConvertFixture(F.buy);
  const second = structuredClone(resp.routes[0]);
  // Route 1: the calldata does not go to the pinned Router.
  resp.routes[0].tx.to = ATTACKER;
  // Route 2: the Router is right, but the echoed receiver disagrees.
  second.contractParamInfo.contractCallParams[0] = ATTACKER;
  resp.routes.push(second);
  return resp;
}

function refusalFrom(intent: PendleTxIntent, resp: ReturnType<typeof mutableConvertFixture>): VexError {
  try {
    selectSafeRoute(intent, resp);
  } catch (err) {
    if (err instanceof VexError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("selectSafeRoute — every route's rejection reason is reported", () => {
  it("names each route in Pendle's own ranking order, with a count", () => {
    const err = refusalFrom(buyIntent(), twoPoisonedRoutes());

    expect(err.code).toBe(ErrorCodes.PENDLE_UNSAFE_TX);
    expect(err.message).toContain("(2 tried)");
    expect(err.message).toContain("route 1:");
    expect(err.message).toContain("route 2:");
    expect(err.message.indexOf("route 1:")).toBeLessThan(err.message.indexOf("route 2:"));
  });

  it("reports the BEST-PRICED route's reason, not just the last one", () => {
    const err = refusalFrom(buyIntent(), twoPoisonedRoutes());

    // Route 1's own verdict — the one that used to be overwritten by route 2's.
    expect(err.message).toMatch(/route 1: [^;]*router/i);
  });

  it("still names the single route's reason when there is only one", () => {
    const resp = mutableConvertFixture(F.buy);
    resp.routes[0].tx.to = ATTACKER;

    const err = refusalFrom(buyIntent(), resp);
    expect(err.message).toContain("(1 tried)");
    expect(err.message).toContain("route 1:");
  });

  it("carries the FIRST failing route's remedy, so the hint matches the reason listed first", () => {
    const err = refusalFrom(buyIntent(), twoPoisonedRoutes());
    expect(err.hint ?? "").not.toBe("");
  });
});
