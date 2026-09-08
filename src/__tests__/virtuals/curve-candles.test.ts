/**
 * The two curve candle builders, over REAL captured provider and chain bytes.
 *
 * These are the sources that answer a bonding agent, which is the population
 * `virtuals__agent_candles_list` used to refuse outright, so the things that
 * can go wrong here are the things a chart hides best: a pair read upside down,
 * a price rounded a second time, a bucket whose open followed arrival order
 * instead of time, and a partial history presented as a complete one.
 *
 * The faked boundary is the NETWORK and nothing below it. `buildChainCandles`
 * runs its real viem client against a scripted JSON-RPC transport carrying the
 * exact bytes read from Base on 2026-09-05, so the event decode, the token
 * orientation, the de-duplication and the arithmetic are all the product's own.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { buildChainCandles } from "@tools/virtuals/candles/curve-chain.js";
import { buildTapeCandles } from "@tools/virtuals/candles/curve-tape.js";
import {
  bucketTradesIntoCandles,
  formatScaled,
  parseDecimalToScaled,
  priceFromRawAmounts,
  PRICE_DECIMALS,
} from "@tools/virtuals/candles/bucketing.js";
import CAPTURE from "./fixtures/curve-swap-logs-base-cultos.json" with { type: "json" };
import { definedValue } from "../_test-value-guards.js";

vi.mock("@tools/virtuals/trades/vp-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/virtuals/trades/vp-api.js")>()),
  readVpApiTrades: vi.fn(),
}));
const { readVpApiTrades } = await import("@tools/virtuals/trades/vp-api.js");

const PAIR = CAPTURE._provenance.pair;
const AGENT_TOKEN = CAPTURE._provenance.agentToken;
const QUOTE_TOKEN = CAPTURE._provenance.quoteToken;

/** The newest captured block, used as `latest` so the walk starts at the data. */
const LATEST_NUMBER = 50_872_200;
const LATEST_TIMESTAMP = 1_788_533_800;

function word(value: string): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

/**
 * A JSON-RPC transport carrying the captured bytes.
 *
 * `tokenA` and `tokenB` answer the ORIENTATION reads, and a test can swap them
 * to prove the builder refuses rather than inverting the series.
 */
function scriptTransport(options: { tokenA?: string; tokenB?: string } = {}) {
  const tokenA = options.tokenA ?? AGENT_TOKEN;
  const tokenB = options.tokenB ?? QUOTE_TOKEN;
  const blocks = new Map(
    CAPTURE.blocks.map((b) => [BigInt(b.number).toString(), b] as const),
  );
  const calls: string[] = [];

  const answer = (request: { method: string; params?: unknown[]; id?: number }): unknown => {
    calls.push(request.method);
    const id = request.id ?? 1;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (request.method === "eth_chainId") return reply("0x2105");
    if (request.method === "eth_call") {
      const data = (request.params?.[0] as { data: string }).data;
      // tokenA() and tokenB(), the two selectors the pair is oriented with.
      if (data.startsWith("0x0fc63d10")) return reply(`0x${tokenA.slice(2).toLowerCase().padStart(64, "0")}`);
      if (data.startsWith("0x5f64b55b")) return reply(`0x${tokenB.slice(2).toLowerCase().padStart(64, "0")}`);
      throw new Error(`unscripted eth_call ${data}`);
    }
    if (request.method === "eth_getBlockByNumber") {
      const tag = request.params?.[0] as string;
      if (tag === "latest") {
        return reply({ number: `0x${LATEST_NUMBER.toString(16)}`, timestamp: `0x${LATEST_TIMESTAMP.toString(16)}`, transactions: [] });
      }
      const asNumber = BigInt(tag);
      const captured = blocks.get(asNumber.toString());
      if (captured !== undefined) {
        return reply({ number: captured.number, timestamp: captured.timestamp, transactions: [] });
      }
      // Any other header is only used to MEASURE average block time, so a
      // uniform 2 s Base cadence is a faithful stand-in for it.
      const behind = BigInt(LATEST_NUMBER) - asNumber;
      return reply({
        number: tag,
        timestamp: `0x${(BigInt(LATEST_TIMESTAMP) - behind * 2n).toString(16)}`,
        transactions: [],
      });
    }
    if (request.method === "eth_getLogs") {
      const filter = request.params?.[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      return reply(
        CAPTURE.logs.filter((l) => {
          const n = BigInt(l.blockNumber);
          return n >= from && n <= to;
        }),
      );
    }
    throw new Error(`unscripted method ${request.method}`);
  };

  const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as
      | { method: string; params?: unknown[]; id?: number }
      | { method: string; params?: unknown[]; id?: number }[];
    const result = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchMock, calls };
}

beforeEach(() => {
  (readVpApiTrades as ReturnType<typeof vi.fn>).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("curve candles from the pair's own Swap logs", () => {
  it("decodes, orients, prices and buckets the real captured window", async () => {
    const { fetchMock } = scriptTransport();
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildChainCandles({
      chain: "BASE",
      pairAddress: PAIR,
      agentTokenAddress: AGENT_TOKEN,
      timeframe: "hour",
      aggregate: 1,
      limit: 10,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;

    // Two hour buckets, oldest first, computed from the four real swaps.
    expect(result.candles.map((c) => c.timestampSeconds)).toEqual([1_788_526_800, 1_788_530_400]);

    // The single-trade bucket: one buy of 33767.493061878284864434 tokens for
    // 2.97 VIRTUAL. Every digit here is exact BigInt arithmetic on the log's
    // own integers, not a float.
    expect(result.candles[0]).toMatchObject({
      open: "0.000087954412089684355117233421603575",
      high: "0.000087954412089684355117233421603575",
      low: "0.000087954412089684355117233421603575",
      close: "0.000087954412089684355117233421603575",
      volumeVirtual: "2.97",
      volumeToken: "33767.493061878284864434",
      tradeCount: 1,
      buyCount: 1,
      sellCount: 0,
    });

    // The three-trade bucket. OPEN follows TIME, and the close is the newest
    // trade in it - the same trade the provider's own feed carried as its
    // newest row, at full precision here.
    expect(result.candles[1]).toMatchObject({
      open: "0.000087819498515991180030675262687412",
      close: "0.000087664728528257192",
      high: "0.000087819498515991180030675262687412",
      low: "0.000087664728528257192",
      volumeVirtual: "45.914538833935558289",
      volumeToken: "522867.85962825280162244",
      tradeCount: 3,
      buyCount: 0,
      sellCount: 3,
    });

    expect(result.coverage.source).toBe("curve_swap_logs");
    expect(result.coverage.swapsInWindow).toBe(4);
    expect(result.coverage.truncated).toBe(false);
    expect(result.coverage.stopReason).toBe("window_covered");
  });

  it("REFUSES a pair it cannot orient instead of inverting the series", async () => {
    // The footgun this guard exists for: a series priced against the wrong side
    // of a pair is not an error anywhere downstream, it is just wrong, and it
    // looks exactly as authoritative as a correct one.
    const { fetchMock } = scriptTransport({ tokenA: "0x00000000000000000000000000000000DeaDBeef" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildChainCandles({
      chain: "BASE",
      pairAddress: PAIR,
      agentTokenAddress: AGENT_TOKEN,
      timeframe: "hour",
      aggregate: 1,
      limit: 10,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/neither of which is the agent's bonding token/);
    expect(result.reason).toMatch(/cannot be oriented/);
  });

  it("names a chain that runs no EVM curve rather than returning an empty chart", async () => {
    const result = await buildChainCandles({
      chain: "SOLANA",
      pairAddress: PAIR,
      agentTokenAddress: AGENT_TOKEN,
      timeframe: "hour",
      aggregate: 1,
      limit: 10,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/base and robinhood/);
  });
});

describe("curve candles from the provider's trade feed", () => {
  const tapeRow = (timestampSeconds: number, price: string, virtualAmount: string) => ({
    txHash: `0x${timestampSeconds.toString(16)}`,
    txSender: "0x0",
    tokenAddress: AGENT_TOKEN,
    isBuy: true,
    agentTokenAmount: "100",
    virtualTokenAmount: virtualAmount,
    price,
    timestampSeconds,
  });

  it("asks for the provider's full ceiling, because the feed has no cursor", async () => {
    (readVpApiTrades as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: true,
      chainId: 0,
      trades: [tapeRow(3_600, "0.01", "1")],
    });
    await buildTapeCandles({
      chain: "BASE",
      tokenAddress: AGENT_TOKEN,
      timeframe: "hour",
      aggregate: 1,
      limit: 5,
    });
    const firstTapeCall = definedValue(
      (readVpApiTrades as ReturnType<typeof vi.fn>).mock.calls[0],
      "the first readVpApiTrades call",
    );
    expect(firstTapeCall[0]).toMatchObject({ limit: 1000 });
  });

  it("passes a chain with no feed through by name, never as an empty chart", async () => {
    (readVpApiTrades as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: false,
      reason: "no chain id for ROBINHOOD",
    });
    const result = await buildTapeCandles({
      chain: "ROBINHOOD",
      tokenAddress: AGENT_TOKEN,
      timeframe: "hour",
      aggregate: 1,
      limit: 5,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/no chain id/);
  });

  it("applies the backwards cursor without skipping or repeating a bucket", async () => {
    // Three hour buckets. Paging before the middle one must yield exactly the
    // older ones, with no bucket appearing on both pages.
    (readVpApiTrades as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: true,
      chainId: 0,
      trades: [
        tapeRow(3_600, "0.01", "1"),
        tapeRow(7_200, "0.02", "2"),
        tapeRow(10_800, "0.03", "3"),
      ],
    });
    const params = { chain: "BASE" as const, tokenAddress: AGENT_TOKEN, timeframe: "hour" as const, aggregate: 1, limit: 2 };
    const page1 = await buildTapeCandles(params);
    expect(page1.available).toBe(true);
    if (!page1.available) return;
    expect(page1.candles.map((c) => c.timestampSeconds)).toEqual([7_200, 10_800]);
    // The newest bucket was withheld by `limit`, so the answer must say so.
    expect(page1.coverage.truncated).toBe(true);

    const page2 = await buildTapeCandles({ ...params, beforeTimestampSeconds: 7_200 });
    expect(page2.available).toBe(true);
    if (!page2.available) return;
    expect(page2.candles.map((c) => c.timestampSeconds)).toEqual([3_600]);
    // No overlap with page 1 and no gap between them.
    expect(page2.candles.some((c) => c.timestampSeconds >= 7_200)).toBe(false);
  });
});

describe("bucketing arithmetic", () => {
  it("renders and parses decimals exactly, without exponent notation", () => {
    expect(formatScaled(1n, 36)).toBe("0.000000000000000000000000000000000001");
    expect(formatScaled(0n, 18)).toBe("0");
    expect(formatScaled(-2_500_000_000_000_000_000n, 18)).toBe("-2.5");
    expect(parseDecimalToScaled("0.5", 18)).toBe(500_000_000_000_000_000n);
    // Exponent notation is REFUSED rather than reinterpreted, so a source that
    // starts sending it is seen to change.
    expect(parseDecimalToScaled("1e-20", 18)).toBeNull();
  });

  it("has no price for a swap that moved no agent token", () => {
    // A fabricated price would sit in the chart looking exactly like a real one.
    expect(priceFromRawAmounts(10n ** 18n, 0n)).toBeNull();
    expect(priceFromRawAmounts(10n ** 18n, 10n ** 18n)).toBe(10n ** BigInt(PRICE_DECIMALS));
  });

  it("omits empty buckets rather than zero-filling them", () => {
    const trade = (timestampSeconds: number) => ({
      timestampSeconds,
      priceScaled: 10n ** BigInt(PRICE_DECIMALS),
      baseAmountScaled: 10n ** 18n,
      quoteAmountScaled: 10n ** 18n,
      isBuy: true,
    });
    // Two trades three hours apart: the two silent hours between them have no
    // price, and a zero bar would assert one.
    const candles = bucketTradesIntoCandles([trade(3_600), trade(14_400)], 3_600);
    expect(candles.map((c) => c.timestampSeconds)).toEqual([3_600, 14_400]);
  });
});
