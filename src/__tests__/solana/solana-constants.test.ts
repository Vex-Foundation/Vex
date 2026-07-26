import { describe, expect, it } from "vitest";
import {
  SOL_MINT,
  SOL_DECIMALS,
  getWellKnownSolanaTokenBySymbol as getWellKnownBySymbol,
  getWellKnownSolanaTokenByMint as getWellKnownByMint,
} from "@tools/solana-ecosystem/shared/solana-constants.js";

describe("solana constants", () => {
  it("SOL_MINT is the wrapped SOL address", () => {
    expect(SOL_MINT).toBe("So11111111111111111111111111111111111111112");
  });

  it("SOL_DECIMALS is 9", () => {
    expect(SOL_DECIMALS).toBe(9);
  });

  describe("getWellKnownBySymbol", () => {
    it("returns SOL for 'SOL'", () => {
      const sol = getWellKnownBySymbol("SOL");
      expect(sol).toBeDefined();
      expect(sol!.symbol).toBe("SOL");
      expect(sol!.address).toBe(SOL_MINT);
      expect(sol!.decimals).toBe(9);
      expect(sol!.chain).toBe("solana");
    });

    it("is case-insensitive", () => {
      expect(getWellKnownBySymbol("usdc")).toBeDefined();
      expect(getWellKnownBySymbol("USDC")).toBeDefined();
      expect(getWellKnownBySymbol("Usdc")).toBeDefined();
    });

    it("returns undefined for unknown symbol", () => {
      expect(getWellKnownBySymbol("DOESNOTEXIST")).toBeUndefined();
    });
  });

  describe("getWellKnownByMint", () => {
    it("returns SOL for SOL_MINT", () => {
      const sol = getWellKnownByMint(SOL_MINT);
      expect(sol).toBeDefined();
      expect(sol!.symbol).toBe("SOL");
    });

    it("returns USDC for USDC mint", () => {
      const usdc = getWellKnownByMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(usdc).toBeDefined();
      expect(usdc!.symbol).toBe("USDC");
      expect(usdc!.decimals).toBe(6);
    });

    it("returns undefined for unknown mint", () => {
      expect(getWellKnownByMint("unknown_mint_address")).toBeUndefined();
    });
  });
});
