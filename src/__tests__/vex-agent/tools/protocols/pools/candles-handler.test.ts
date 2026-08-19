/**
 * `pools.candles` - param bounds, the named-object projection, and the ORDER,
 * which is the finding this suite exists to pin.
 *
 * The tool spec drafted from the first probe said the server returns candles
 * newest-first. A recapture against two pools.fun tokens returned them
 * OLDEST-first. An echoed constant would therefore have been wrong half the
 * time, and an agent trusting `candles[0] is the latest` off a wrong constant
 * reads every trend backwards. The handler derives the order from the
 * timestamps; these cases hold it to that.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import { describeCandleOrder } from "@vex-agent/tools/protocols/pools/handlers/candles.js";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { validateCandles } from "@tools/pools-fun/validation.js";
import type { PoolsCandles } from "@tools/pools-fun/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { makeProtocolContext } from "../../_test-context.js";
import { captureResponse, CAPTURES } from "../../../../pools-fun/_captures.js";

const CTX: ProtocolExecutionContext = makeProtocolContext();
const TOKEN = "0x0ab8d01664d4bb625705f9f3c595a8a19b3dcfb0";

function captured(): PoolsCandles {
  return validateCandles(captureResponse(CAPTURES.ohlcvHour));
}

function stubCandles(result: PoolsCandles): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(getPoolsFunClient(), "candles").mockResolvedValue(result);
}

async function candles(params: Record<string, unknown>) {
  return POOLS_HANDLERS["pools.candles"]!(params, CTX);
}

afterEach(() => vi.restoreAllMocks());

describe("describeCandleOrder reads the order off the data", () => {
  const at = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volumeUsd: 1 });

  it("names the ascending case the real capture exhibits", () => {
    expect(describeCandleOrder(captured().candles)).toBe("oldest-first");
  });

  it("names the descending case", () => {
    expect(describeCandleOrder([at(3), at(2), at(1)])).toBe("newest-first");
  });

  it("refuses to label a series that is neither", () => {
    expect(describeCandleOrder([at(1), at(3), at(2)])).toBe("unordered");
  });

  it("does not claim an order for zero or one candle", () => {
    expect(describeCandleOrder([])).toBe("empty");
    expect(describeCandleOrder([at(1)])).toBe("single");
  });
});

describe("pools.candles params", () => {
  it("requires a tokenAddress", async () => {
    const res = await candles({});
    expect(res.success).toBe(false);
    expect(res.output).toContain("tokenAddress");
  });

  it("rejects an off-enum timeframe naming the accepted values", async () => {
    const res = await candles({ tokenAddress: TOKEN, timeframe: "week" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("minute");
    expect(res.output).toContain("day");
  });

  it("rejects an aggregate above the server cap", async () => {
    const res = await candles({ tokenAddress: TOKEN, aggregate: 25 });
    expect(res.success).toBe(false);
    expect(res.output).toContain("at most 24");
  });

  it("rejects a limit above the server cap", async () => {
    const res = await candles({ tokenAddress: TOKEN, limit: 1001 });
    expect(res.success).toBe(false);
    expect(res.output).toContain("at most 1000");
  });

  it("applies the measured server defaults when the caller omits them", async () => {
    const spy = stubCandles(captured());
    await candles({ tokenAddress: TOKEN });
    expect(spy).toHaveBeenCalledWith(
      { tokenAddress: TOKEN, timeframe: "hour", aggregate: 1, limit: 30 },
      // The turn's Operator-Stop signal is threaded to every read.
      { signal: CTX.abortSignal },
    );
  });
});

describe("pools.candles output", () => {
  it("emits named candle objects, the pair, and the derived order", async () => {
    stubCandles(captured());
    const res = await candles({ tokenAddress: TOKEN, timeframe: "hour", limit: 3 });
    expect(res.success).toBe(true);

    const data = JSON.parse(res.output) as {
      order: string;
      pair: { base: string; quote: string };
      priceUnit: string;
      candles: Record<string, unknown>[];
      count: number;
    };
    expect(data.order).toBe("oldest-first");
    expect(data.pair.quote).toBe("WETH");
    expect(data.priceUnit).toBe("WETH");
    expect(data.count).toBe(captured().candles.length);
    expect(Object.keys(data.candles[0]!).sort())
      .toEqual(["close", "high", "low", "open", "time", "volumeUsd"]);
  });

  it("surfaces the launchpad's named not-found rather than an empty chart", async () => {
    vi.spyOn(getPoolsFunClient(), "candles").mockRejectedValue(
      new VexError(
        ErrorCodes.POOLS_NOT_FOUND,
        "pools.fun knows no pool for this token address",
        "check the address",
      ),
    );
    const res = await candles({ tokenAddress: `0x${"0".repeat(39)}1` });
    expect(res.success).toBe(false);
    expect(res.output).toContain("no pool");
  });
});
