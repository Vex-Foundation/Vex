import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DexPair } from "@tools/dexscreener/types.js";
import { readTokenPools, readTokensPairs } from "@tools/dexscreener/price-read.js";
import { readSwapPriceReference } from "@tools/evm-chains/swap-price-reference-read.js";
import { valueSwapAtReference } from "@tools/evm-chains/swap-price-reference.js";
import { classifyMeasuredImpact } from "@vex-agent/tools/protocols/quote-authority/eligibility.js";
import { mapActivityToEvent } from "@vex-agent/agentscan/mapper.js";
import { validateTokensPairsResponse } from "@tools/dexscreener/validation/pairs.js";
import fixture from "../../fixtures/swap-quality/dex-base.json" with { type: "json" };

vi.mock("@tools/dexscreener/price-read.js", () => ({ readTokenPools: vi.fn(), readTokensPairs: vi.fn() }));
const IN = "0x1111111111111111111111111111111111111111";
const OUT = "0x2222222222222222222222222222222222222222";
const template = validateTokensPairsResponse(fixture)[0];
if (template === undefined) throw new Error("Pair fixture missing");
function pool(price: string, id: string, usd: number): DexPair {
  return { ...template, chainId: "base", pairAddress: id,
    baseToken: { address: OUT, symbol: "OUT", name: "Output" },
    quoteToken: { address: IN, symbol: "IN", name: "Input" },
    priceUsd: price, priceNative: price, liquidity: { usd, base: 1, quote: 1 } };
}
const input = { chainId: 8453, chainSlug: "base", tokenIn: { address: IN, isNative: false }, tokenOut: { address: OUT, isNative: false } };
beforeEach(() => vi.resetAllMocks());

describe("swap reference pool population", () => {
  it("screens a misleading representative and refuses a genuine 47% loss in both quote and reporting valuations", async () => {
    const stale = pool("20", "stale", 1_000_000);
    vi.mocked(readTokensPairs).mockResolvedValue([stale]);
    vi.mocked(readTokenPools).mockResolvedValue([pool("1", "fair1", 10000), pool("1", "fair2", 12000), stale]);
    const reference = await readSwapPriceReference(input);
    if (reference === null) throw new Error("Reference missing");
    const values = valueSwapAtReference(reference, { amountInRaw: "10000000", amountOutRaw: "5300000", inputDecimals: 6, outputDecimals: 6 });
    expect(values).toMatchObject({ amountInUsd: "10", amountOutUsd: "5.3", priceImpactFraction: 0.47 });
    expect(classifyMeasuredImpact(values.priceImpactFraction).kind).toBe("excessive_impact");
    expect(mapActivityToEvent({ chain_id: 8453, chain_family: "eip155", event_role: "swap",
      token_in_address: IN, token_out_address: OUT, token_in_decimals: 6, token_out_decimals: 6,
      amount_in_raw: "10000000", amount_out_raw: "5300000", usd_out_est: "106",
      route_provenance: { swapPriceReference: reference } }, { status: "pending" }).usdOutEst).toBe("5.3");
    expect(readTokensPairs).not.toHaveBeenCalled();
    expect(readTokenPools).toHaveBeenCalledTimes(2);
  });

  it("does not infer input population coverage merely because it occurs on an output pool", async () => {
    vi.mocked(readTokensPairs).mockResolvedValue([pool("1", "representative", 1000)]);
    vi.mocked(readTokenPools).mockImplementation(async (_chain, address) => address === OUT
      ? [pool("1", "output-pool", 1000)]
      : [{ ...pool("20", "input-deep", 100000), baseToken: { address: IN, symbol: "IN", name: "Input" }, quoteToken: { address: OUT, symbol: "OUT", name: "Output" } }]);
    expect(await readSwapPriceReference(input)).toMatchObject({ inputPriceUsd: "20", outputPriceUsd: "1" });
    expect(readTokenPools).toHaveBeenNthCalledWith(2, "base", IN);
  });

  it("reuses a population only for the same resolved pricing asset", async () => {
    vi.mocked(readTokenPools).mockResolvedValue([pool("1", "same", 1000)]);
    const result = await readSwapPriceReference({ ...input, tokenIn: input.tokenOut });
    expect(result).not.toBeNull();
    expect(readTokenPools).toHaveBeenCalledTimes(1);
  });

  it("returns no independent reference for an unpriced chain without exceeding two reads", async () => {
    vi.mocked(readTokenPools).mockResolvedValue([]);
    expect(await readSwapPriceReference(input)).toBeNull();
    expect(vi.mocked(readTokenPools).mock.calls.length).toBeLessThanOrEqual(2);
  });
});
