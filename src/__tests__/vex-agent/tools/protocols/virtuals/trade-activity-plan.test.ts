/**
 * The `agent_activity` rows a curve trade plans BEFORE anything is signed, and
 * the order they are planned in.
 *
 * The order is a safety property, not a formatting choice:
 *
 *  - a leg that is SIGNED but never RECORDED is a transfer with no audit row, so
 *    every row a run might sign exists before the first broadcast;
 *  - a leg that is RECORDED but never SIGNED is terminalized as never-attempted,
 *    which is why the plan may over-provision rows and the caller aborts the
 *    tail;
 *  - the `vex_fee` row is a CHILD of the trade on the `swap` arm (migration 107,
 *    owner V1/V2), so the feed folds it under the action it charges for instead
 *    of showing a second money entry.
 *
 * `tradeLegCount` is the seam the executor slices on: everything before it is a
 * leg the trade itself signs, and the row at exactly that index is the fee. A
 * drift there would sign the fee inside the leg loop, which is the one ordering
 * this lane must never have.
 */

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import {
  VIRTUALS_CURVE_FEE_ACTIVITY_EVENT_ROLE,
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import {
  VIRTUALS_CURVE_VENUE,
  planCurveTradeEvents,
  type LegToken,
} from "@vex-agent/tools/protocols/virtuals/handlers/trade/activity.js";
import type { TradeParams } from "@vex-agent/tools/protocols/virtuals/handlers/trade/params.js";
import type { PricedCurveTrade } from "@vex-agent/tools/protocols/virtuals/handlers/trade/pricing.js";
import { definedValue } from "../../../../_test-value-guards.js";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const SESSION = "00000000-0000-4000-8000-000000000001";
const PAIR = getAddress("0x3e11e685a056048C2dFa1c0dc1E1D0F233DbA84a");

function deployment(key = "base"): VirtualsCurveDeployment {
  const d = virtualsCurveDeployment(key);
  if (d === undefined) throw new Error(`no Virtuals curve deployment for ${key}`);
  return d;
}

const AGENT: LegToken = {
  address: getAddress("0x1984edF491D3399FBc09E6d0856E01fF3721f952"),
  symbol: "CULTOS",
  decimals: 18,
};

const CURVE_AMOUNT = 498_750_000_000_000_000n;
const QUOTED_OUT = 5_646_592_476_387_574_784_133n;
const BUY_FEE = 1_250_000_000_000_000n;
const FLOOR = 5_589_126_551_623_699_036_291n;

function params(side: "buy" | "sell", d = deployment()): TradeParams {
  return {
    deployment: d,
    chainSlug: d.key,
    token: AGENT.address,
    side,
    amountInHuman: side === "buy" ? "0.5" : "1000",
    amountInRaw: side === "buy" ? CURVE_AMOUNT + BUY_FEE : CURVE_AMOUNT,
    slippageBps: 100,
    acceptAntiSniperTaxPct: null,
    simulateOnly: false,
  };
}

function priced(side: "buy" | "sell", d = deployment()): PricedCurveTrade {
  const shared = {
    totalInRaw: side === "buy" ? CURVE_AMOUNT + BUY_FEE : CURVE_AMOUNT,
    curveAmountRaw: CURVE_AMOUNT,
    quotedOutRaw: QUOTED_OUT,
    contractFloorRaw: FLOOR,
    protocolTaxPct: 1,
    antiSniper: {
      type: 0,
      appliesToThisSide: false,
      effectivePct: 0,
      windowActive: false,
      remainingSeconds: 0,
      acceptedPct: null,
      withinAcceptedBound: true,
      note: "no window",
    },
    feeDisclosure: { charged: false, bps: 0, reason: "test", netAmountRaw: "0", totalDebitedRaw: "0", collectedWhen: "separate_transfer_after_success", note: "test" },
  } as const;
  return side === "buy"
    ? {
        ...shared,
        side: "buy",
        taxedInRaw: 493_762_500_000_000_000n,
        walletNetMinRaw: null,
        walletNetQuotedRaw: null,
        feeRaw: BUY_FEE,
        spendTokenSymbol: "VIRTUAL",
        spendTokenDecimals: d.virtualDecimals,
        receiveTokenSymbol: AGENT.symbol,
        receiveTokenDecimals: AGENT.decimals,
      }
    : {
        ...shared,
        side: "sell",
        taxedInRaw: null,
        walletNetMinRaw: 5_533_235_286_107_462_045_928n,
        walletNetQuotedRaw: 5_590_126_551_623_699_036_291n,
        feeRaw: null,
        spendTokenSymbol: AGENT.symbol,
        spendTokenDecimals: AGENT.decimals,
        receiveTokenSymbol: "VIRTUAL",
        receiveTokenDecimals: d.virtualDecimals,
      };
}

function plan(o: {
  side: "buy" | "sell";
  currentAllowanceRaw: bigint;
  feePlannedRaw: bigint | null;
  chain?: string;
}) {
  const d = deployment(o.chain ?? "base");
  return planCurveTradeEvents({
    params: params(o.side, d),
    priced: priced(o.side, d),
    walletAddress: WALLET,
    sessionId: SESSION,
    agentToken: AGENT,
    pair: PAIR,
    currentAllowanceRaw: o.currentAllowanceRaw,
    contractFloorRaw: FLOOR,
    feePlannedRaw: o.feePlannedRaw,
  });
}

describe("the allowance legs appear only when the allowance is actually short", () => {
  it("plans NO approval when the wallet already allows the full curve amount", () => {
    const { events, tradeLegCount, hasFeeRow } = plan({
      side: "buy", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: BUY_FEE,
    });
    expect(events.map((e) => e.eventRole)).toEqual(["swap", "vex_fee"]);
    expect(tradeLegCount).toBe(1);
    expect(hasFeeRow).toBe(true);
  });

  it("plans ONE approval from a zero allowance - no pointless reset of nothing", () => {
    const { events, tradeLegCount } = plan({ side: "buy", currentAllowanceRaw: 0n, feePlannedRaw: BUY_FEE });
    expect(events.map((e) => e.eventRole)).toEqual(["allowance", "swap", "vex_fee"]);
    expect(tradeLegCount).toBe(2);
  });

  it("plans a RESET first when a non-zero allowance is short (the USDT-style rule)", () => {
    const { events, tradeLegCount } = plan({ side: "buy", currentAllowanceRaw: 1n, feePlannedRaw: BUY_FEE });
    expect(events.map((e) => e.eventRole)).toEqual(["allowance_reset", "allowance", "swap", "vex_fee"]);
    expect(tradeLegCount).toBe(3);
  });

  it("sizes the approval on the CURVE amount, which is what the router pulls in full", () => {
    // FRouterV3 splits `curveAmount` into taxedIn + two tax legs and pulls all
    // three from the wallet, so an allowance sized on `taxedIn` would revert.
    const { events } = plan({ side: "buy", currentAllowanceRaw: 0n, feePlannedRaw: BUY_FEE });
    const approval = events.find((e) => e.eventRole === "allowance");
    expect(approval?.tokenIn?.amountRaw).toBe(CURVE_AMOUNT.toString());
  });

  it("indexes every planned row contiguously from zero", () => {
    const { events } = plan({ side: "buy", currentAllowanceRaw: 1n, feePlannedRaw: BUY_FEE });
    expect(events.map((e) => e.eventIndex)).toEqual([0, 1, 2, 3]);
  });
});

describe("the trade row", () => {
  it("is a swap on the venue every Virtuals curve row is filed under", () => {
    const { events } = plan({ side: "buy", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: BUY_FEE });
    const swap = definedValue(events.find((e) => e.eventRole === "swap"), "the planned swap row");
    expect(swap.kind).toBe("swap");
    expect(swap.protocol).toBe("virtuals");
    expect(swap.chainId).toBe(deployment().chainId);
    expect(swap.walletAddress).toBe(WALLET);
    expect(swap.sessionId).toBe(SESSION);
    expect(VIRTUALS_CURVE_VENUE).toBe("virtuals-curve");
    expect(swap.routeProvenance).toMatchObject({
      venue: VIRTUALS_CURVE_VENUE,
      side: "buy",
      pair: PAIR,
      bondingV5: deployment().bondingV5,
      frouterV3: deployment().frouterV3,
      // The floor actually written into the calldata, so a post-crash sweep can
      // assess the fill without re-reading the prequote row.
      contractFloorRaw: FLOOR.toString(),
      protocolTaxPct: 1,
      antiSniperPct: 0,
    });
  });

  it("orients the legs by side: a buy spends VIRTUAL, a sell spends the agent token", () => {
    const buy = plan({ side: "buy", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: BUY_FEE });
    const buySwap = definedValue(buy.events.find((e) => e.eventRole === "swap"), "the buy swap row");
    expect(buySwap.tokenIn?.tokenSymbol).toBe("VIRTUAL");
    expect(buySwap.tokenOut?.tokenSymbol).toBe(AGENT.symbol);

    const sell = plan({ side: "sell", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: 1n });
    const sellSwap = definedValue(sell.events.find((e) => e.eventRole === "swap"), "the sell swap row");
    expect(sellSwap.tokenIn?.tokenSymbol).toBe(AGENT.symbol);
    expect(sellSwap.tokenOut?.tokenSymbol).toBe("VIRTUAL");
  });

  it("carries no settlementDecode hint, because no sweep-side decoder exists for this venue", () => {
    // Naming a decoder the repair lane cannot dispatch would be worse than an
    // absent hint, which is a supported state the reader already handles.
    const { events } = plan({ side: "buy", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: BUY_FEE });
    const swap = definedValue(events.find((e) => e.eventRole === "swap"), "the planned swap row");
    expect((swap.routeProvenance as Record<string, unknown>).settlementDecode).toBeUndefined();
  });
});

describe("the vex_fee row is a CHILD, planned last and never a second money entry", () => {
  it("uses the family role migration 107 folds on", () => {
    expect(VIRTUALS_CURVE_FEE_ACTIVITY_EVENT_ROLE).toBe("vex_fee");
    const { events, tradeLegCount } = plan({ side: "buy", currentAllowanceRaw: 0n, feePlannedRaw: BUY_FEE });
    expect(definedValue(events[tradeLegCount], "the row after the trade legs").eventRole).toBe("vex_fee");
  });

  it("sits on the SWAP arm, so the fold finds it under the trade it charges for", () => {
    const { events } = plan({ side: "buy", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: BUY_FEE });
    const fee = definedValue(events.find((e) => e.eventRole === "vex_fee"), "the planned vex_fee row");
    expect(fee.kind).toBe("swap");
    expect(fee.protocol).toBe("virtuals");
  });

  it("carries the fee in tokenIn and NOT in the vexFee columns - storing both books it twice", () => {
    const { events } = plan({ side: "buy", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: BUY_FEE });
    const fee = definedValue(events.find((e) => e.eventRole === "vex_fee"), "the planned vex_fee row") as Record<string, unknown>;
    expect((fee.tokenIn as { amountRaw: string }).amountRaw).toBe(BUY_FEE.toString());
    expect((fee.tokenIn as { tokenSymbol: string }).tokenSymbol).toBe("VIRTUAL");
    expect(fee.vexFee).toBeUndefined();
    expect(fee.vexFeeAmountRaw).toBeUndefined();
  });

  it("is always denominated in VIRTUAL, on a sell as much as on a buy", () => {
    const { events } = plan({ side: "sell", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw: 1_000n });
    const fee = definedValue(events.find((e) => e.eventRole === "vex_fee"), "the planned vex_fee row");
    expect(fee.tokenIn?.tokenAddress).toBe(deployment().virtual);
  });

  it("plans NO fee row at all when nothing would be charged", () => {
    for (const feePlannedRaw of [null, 0n]) {
      const { events, hasFeeRow, tradeLegCount } = plan({
        side: "buy", currentAllowanceRaw: CURVE_AMOUNT, feePlannedRaw,
      });
      expect(hasFeeRow).toBe(false);
      expect(events.map((e) => e.eventRole)).toEqual(["swap"]);
      expect(tradeLegCount).toBe(events.length);
    }
  });

  it("keeps tradeLegCount pointing at the fee, so the executor never signs it inside the leg loop", () => {
    for (const allowance of [0n, 1n, CURVE_AMOUNT]) {
      const { events, tradeLegCount, hasFeeRow } = plan({
        side: "buy", currentAllowanceRaw: allowance, feePlannedRaw: BUY_FEE,
      });
      expect(hasFeeRow).toBe(true);
      // Everything the leg loop walks is a trade leg, never the fee.
      expect(events.slice(0, tradeLegCount).map((e) => e.eventRole)).not.toContain("vex_fee");
      expect(events.slice(tradeLegCount).map((e) => e.eventRole)).toEqual(["vex_fee"]);
    }
  });
});

describe("the plan is chain-scoped", () => {
  it("files Robinhood rows under Robinhood's chain, slug and VIRTUAL", () => {
    const rh = deployment("robinhood");
    const { events } = plan({ side: "buy", currentAllowanceRaw: 0n, feePlannedRaw: BUY_FEE, chain: "robinhood" });
    for (const event of events) {
      expect(event.chainId).toBe(rh.chainId);
      expect(event.chainSlug).toBe("robinhood");
    }
    expect(events.find((e) => e.eventRole === "vex_fee")?.tokenIn?.tokenAddress).toBe(rh.virtual);
    expect(rh.virtual).not.toBe(deployment("base").virtual);
  });
});
