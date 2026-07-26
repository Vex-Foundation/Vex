/**
 * Pendle PY (mint/redeem) two-item capture pipeline (P4, Codex-required).
 *
 * (a) py.mint emits EXACTLY two capture items (a PT leg + a YT leg) → two
 *     protocol_capture_items → two proj_activity rows with DISTINCT instrument
 *     keys. (Lot-opening projection retired with the PnL teardown — capture
 *     itself is unaffected: agent_activity is the trade-truth store now.)
 * (b) FAIL-CLOSED GUARD: a fanOut:"items" pnl_spot result with MISSING/EMPTY
 *     `_tradeCaptureItems` must NOT silently project its summary `_tradeCapture`
 *     (which carries a single instrumentKey — projecting it would collapse the
 *     two legs into one mislabeled row).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseUnits } from "viem";

type CaptureItemsModule = typeof import("@vex-agent/db/repos/capture-items.js");
type ActivityPopulatorModule = typeof import("@vex-agent/sync/activity-populator.js");

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ── capture-pipeline repo mocks (part a + guard) ──
const mockRecordCaptureItems = vi.fn<CaptureItemsModule["recordCaptureItems"]>(async () => [10, 11]);
vi.mock("@vex-agent/db/repos/capture-items.js", () => ({
  recordCaptureItems: (...args: Parameters<CaptureItemsModule["recordCaptureItems"]>) => mockRecordCaptureItems(...args),
}));
const mockPopulateActivity = vi.fn<ActivityPopulatorModule["populateActivity"]>(async () => {});
vi.mock("@vex-agent/sync/activity-populator.js", () => ({
  populateActivity: (...args: Parameters<ActivityPopulatorModule["populateActivity"]>) => mockPopulateActivity(...args),
}));

const { populateCaptureItems } = await import("../../../vex-agent/tools/protocols/capture-pipeline.js");
const { validateCaptureContract } = await import("../../../vex-agent/tools/protocols/capture-validator.js");

const CHAIN = "ethereum";
const PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const YT = "0x04b7fa1e727d7290d6e24fa9b426d0c940283a95";
const WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
const WALLET = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
const PT_OUT = parseUnits("1.238752308022314553", 18).toString();
const YT_OUT = PT_OUT; // mint outputs an EQUAL PT and YT amount

/** One PY-mint capture item (PT or YT leg) as the handler emits it. */
function mintItem(leg: "pt" | "yt"): Record<string, unknown> {
  const instrument = leg === "pt" ? PT : YT;
  return {
    type: "swap",
    chain: CHAIN,
    status: "executed",
    inputTokenAddress: WSTETH,
    outputTokenAddress: instrument,
    inputAmount: parseUnits("0.5", 18).toString(),
    outputAmount: leg === "pt" ? PT_OUT : YT_OUT,
    inputValueUsd: "2000",
    outputValueUsd: "2000",
    valuationSource: "pendle",
    signature: "0xminthash",
    walletAddress: WALLET,
    tradeSide: "buy",
    instrumentKey: `${CHAIN}:${instrument.toLowerCase()}`,
    settlementAssetKey: WSTETH,
    meta: { protocol: "pendle", side: "mint", leg },
  };
}

const MINT_SUMMARY: Record<string, unknown> = {
  type: "swap",
  chain: CHAIN,
  status: "executed",
  walletAddress: WALLET,
  tradeSide: "buy",
  instrumentKey: `${CHAIN}:${PT.toLowerCase()}`,
  inputTokenAddress: WSTETH,
  outputTokenAddress: PT,
  inputAmount: parseUnits("1", 18).toString(),
  outputAmount: PT_OUT,
  inputValueUsd: "4000",
  outputValueUsd: "4000",
  valuationSource: "pendle",
  signature: "0xminthash",
  settlementAssetKey: WSTETH,
};

/** One PY-redeem SELL capture item (PT or YT leg) as the handler emits it. */
function redeemItem(leg: "pt" | "yt"): Record<string, unknown> {
  const instrument = leg === "pt" ? PT : YT;
  return {
    type: "swap",
    chain: CHAIN,
    status: "closed",
    inputTokenAddress: instrument,
    outputTokenAddress: WSTETH,
    inputAmount: parseUnits("1", 18).toString(),
    outputAmount: parseUnits("0.4", 18).toString(),
    inputValueUsd: "2000",
    outputValueUsd: "2000",
    valuationSource: "pendle",
    signature: "0xredeemhash",
    walletAddress: WALLET,
    tradeSide: "sell",
    instrumentKey: `${CHAIN}:${instrument.toLowerCase()}`,
    settlementAssetKey: WSTETH,
    meta: { protocol: "pendle", side: "redeem-py", leg },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("pendle.py mint/redeem capture items pass the runtime validator (projectable spot legs)", () => {
  it("both mint items validate against the pnl_spot contract for pendle.py.mint", () => {
    for (const leg of ["pt", "yt"] as const) {
      expect(validateCaptureContract("pendle.py.mint", mintItem(leg))).toBe(true);
    }
  });
  it("both redeem items validate against the pnl_spot contract for pendle.py.redeem", () => {
    for (const leg of ["pt", "yt"] as const) {
      expect(validateCaptureContract("pendle.py.redeem", redeemItem(leg))).toBe(true);
    }
  });
});

describe("pendle.py.mint — two capture items → two activity rows", () => {
  it("records EXACTLY two capture items and populates two activity rows with DISTINCT instrument keys", async () => {
    const items = [mintItem("pt"), mintItem("yt")];
    await populateCaptureItems(42, "pendle.py.mint", "pendle", MINT_SUMMARY, items, { signature: "0xminthash" });

    // Two protocol_capture_items recorded from the two legs (NOT the summary).
    expect(mockRecordCaptureItems).toHaveBeenCalledTimes(1);
    const recorded = mockRecordCaptureItems.mock.calls[0]![1] as { tradeCapture: Record<string, unknown> }[];
    expect(recorded).toHaveLength(2);

    // Two proj_activity rows, one per item, with DISTINCT instrument keys.
    expect(mockPopulateActivity).toHaveBeenCalledTimes(2);
    const keys = mockPopulateActivity.mock.calls.map(
      (c) => (c[4] as { instrumentKey: string }).instrumentKey,
    );
    expect(new Set(keys)).toEqual(new Set([`${CHAIN}:${PT.toLowerCase()}`, `${CHAIN}:${YT.toLowerCase()}`]));
  });
});

describe("pendle.py.mint — fail-closed guard (no items → summary NOT projected)", () => {
  it("skips projection entirely when a spot fanOut:items result carries a summary but NO items", async () => {
    // Summary present, items MISSING — the old fallback would project the summary
    // (one mislabeled lot). The guard must skip instead.
    await populateCaptureItems(43, "pendle.py.mint", "pendle", MINT_SUMMARY, undefined, { signature: "0xminthash" });
    expect(mockRecordCaptureItems).not.toHaveBeenCalled();
    expect(mockPopulateActivity).not.toHaveBeenCalled();
  });

  it("also skips when items is an EMPTY array (still no per-leg identity)", async () => {
    await populateCaptureItems(44, "pendle.py.mint", "pendle", MINT_SUMMARY, [], { signature: "0xminthash" });
    expect(mockRecordCaptureItems).not.toHaveBeenCalled();
    expect(mockPopulateActivity).not.toHaveBeenCalled();
  });

  it("a single-fanOut spot tool (pendle.pt.buy) still projects its summary (guard is scoped to items tools)", async () => {
    await populateCaptureItems(45, "pendle.pt.buy", "pendle", MINT_SUMMARY, undefined, { signature: "0xminthash" });
    expect(mockRecordCaptureItems).toHaveBeenCalledTimes(1);
    expect(mockPopulateActivity).toHaveBeenCalledTimes(1);
  });
});
