import { describe, it, expect } from "vitest";
import { getAddress } from "viem";
import {
  readCurveTokenSymbol,
  normalizeCurveTokenSymbol,
  CURVE_TOKEN_SYMBOL_MAX_LENGTH,
} from "../../vex-agent/tools/protocols/trench/handlers/trade/token-symbol.js";

const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");

function clientReturning(value: unknown) {
  return { readContract: async () => value } as never;
}

describe("normalizeCurveTokenSymbol", () => {
  it("keeps a normal ticker, trimmed", () => {
    expect(normalizeCurveTokenSymbol("  PEPE ")).toBe("PEPE");
  });

  it("rejects a non-string, an empty symbol, and control characters", () => {
    expect(normalizeCurveTokenSymbol(42)).toBeNull();
    expect(normalizeCurveTokenSymbol("   ")).toBeNull();
    expect(normalizeCurveTokenSymbol("PE\nPE")).toBeNull();
  });

  it("rejects an oversized symbol rather than trimming it to a wrong ticker", () => {
    expect(normalizeCurveTokenSymbol("A".repeat(CURVE_TOKEN_SYMBOL_MAX_LENGTH + 1))).toBeNull();
  });
});

describe("readCurveTokenSymbol", () => {
  it("returns the token's normalized symbol", async () => {
    expect(await readCurveTokenSymbol(clientReturning("PEPE"), TOKEN)).toBe("PEPE");
  });

  it("returns null instead of failing the trade when the token has no readable symbol", async () => {
    const failing = { readContract: async () => { throw new Error("execution reverted"); } } as never;
    expect(await readCurveTokenSymbol(failing, TOKEN)).toBeNull();
  });
});
