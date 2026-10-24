import { describe, expect, it } from "vitest";
import { compactUsd, hitDetail, looksLikeAddress, shortAddress } from "../token-search-format.js";

describe("token search format", () => {
  it("knows a pasted address from a ticker, per chain family", () => {
    expect(looksLikeAddress("0x532f27101965dd16442E59d40670FaF5eBB142E4", "evm")).toBe(true);
    expect(looksLikeAddress("BRETT", "evm")).toBe(false);
    expect(looksLikeAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "solana")).toBe(true);
    expect(looksLikeAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "evm")).toBe(false);
    expect(looksLikeAddress("BONK", "solana")).toBe(false);
  });

  it("shortens an address and compacts dollars", () => {
    expect(shortAddress("0x532f27101965dd16442E59d40670FaF5eBB142E4")).toBe("0x532f…42E4");
    expect(compactUsd(697_892)).toBe("$698k");
    expect(compactUsd(2_100_000)).toBe("$2.1M");
    expect(compactUsd(2)).toBe("$2");
    expect(compactUsd(null)).toBe("n/a");
  });

  it("reads a row's figures", () => {
    expect(
      hitDetail({
        address: "a",
        symbol: "BRETT",
        name: null,
        priceUsd: "0.004663",
        liquidityUsd: null,
        volume24hUsd: 222_297,
        poolCount: 14,
        dexId: "aerodrome",
        pairAddress: "p",
      }),
    ).toBe("$0.004663 · $222k 24h volume · 14 pools");
  });
});
