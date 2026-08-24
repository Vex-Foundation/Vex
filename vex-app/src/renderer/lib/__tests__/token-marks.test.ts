/**
 * resolveTokenMark — the chain-aware verified-brand-icon trust boundary.
 * Table-driven negative cases matter more here than the happy path: a wrong
 * chain, a wrong symbol, or a case mismatch must all fail closed to the
 * family mark, never silently borrow a brand.
 */

import { describe, expect, it } from "vitest";
import { Bnb, Ethereum, Polygon, Solana, Tether, Usdc } from "@thesvg/react";
import { SOLANA_CHAIN_ID } from "@shared/chains/display.js";
import { resolveTokenMark } from "../token-marks.js";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19d4A2e9Eb0cE3606eB48";
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const POLYGON_USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const NATIVE_EVM_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const BSC_PEG_USD = "0x55d398326f99059ff775485246999027b3197955";
const ARBITRUM_USDT = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";

describe("resolveTokenMark - verified brand matches", () => {
  it("grants the Usdc mark for mainnet USDC at the verified address (checksummed input)", () => {
    const mark = resolveTokenMark(1, MAINNET_USDC, "USDC");
    expect(mark).toEqual({ kind: "brand", icon: Usdc });
  });

  it("grants the Ethereum mark for mainnet WETH (EVM case normalization: checksummed matches lowercase row)", () => {
    const mark = resolveTokenMark(1, MAINNET_WETH, "WETH");
    expect(mark).toEqual({ kind: "brand", icon: Ethereum });
  });

  it("grants the Usdc mark for the verified Solana USDC mint", () => {
    const mark = resolveTokenMark(SOLANA_CHAIN_ID, SOL_USDC_MINT, "USDC");
    expect(mark).toEqual({ kind: "brand", icon: Usdc });
  });

  it("grants the local Jupiter mark for the verified JUP mint", () => {
    const mark = resolveTokenMark(SOLANA_CHAIN_ID, JUP_MINT, "JUP");
    expect(mark).toEqual({ kind: "local", src: "/logo/jupiter.png" });
  });
});

describe("resolveTokenMark - native EVM sentinel (per-chain, unspoofable address)", () => {
  it("resolves Ethereum for the sentinel on chains 1/10/8453/42161", () => {
    for (const chainId of [1, 10, 8453, 42161]) {
      expect(resolveTokenMark(chainId, NATIVE_EVM_SENTINEL, "ETH")).toEqual({
        kind: "brand",
        icon: Ethereum,
      });
    }
  });

  it("resolves Polygon for the sentinel on chain 137", () => {
    expect(resolveTokenMark(137, NATIVE_EVM_SENTINEL, "POL")).toEqual({
      kind: "brand",
      icon: Polygon,
    });
  });

  it("resolves Bnb for the sentinel on chain 56", () => {
    expect(resolveTokenMark(56, NATIVE_EVM_SENTINEL, "BNB")).toEqual({
      kind: "brand",
      icon: Bnb,
    });
  });

  it("falls back to the EVM family mark for the sentinel on an uncatalogued chain (Robinhood 4663)", () => {
    expect(resolveTokenMark(4663, NATIVE_EVM_SENTINEL, "ETH")).toEqual({
      kind: "family",
      family: "evm",
    });
  });
});

describe("resolveTokenMark - table-driven negative cases", () => {
  it("correct address, WRONG chain - never matches across chains", () => {
    // Mainnet USDC's address is NOT Polygon's USDC address; claiming it on
    // chain 137 must fail closed to the family mark, not the Usdc brand.
    const mark = resolveTokenMark(137, MAINNET_USDC, "USDC");
    expect(mark).toEqual({ kind: "family", family: "evm" });
  });

  it("correct address, WRONG symbol - never matches on a symbol lie", () => {
    const mark = resolveTokenMark(1, MAINNET_USDC, "USDT");
    expect(mark).toEqual({ kind: "family", family: "evm" });
  });

  it("Solana case sensitivity - a case-variant mint does NOT match", () => {
    const caseVariant = SOL_USDC_MINT.toLowerCase();
    const mark = resolveTokenMark(SOLANA_CHAIN_ID, caseVariant, "USDC");
    expect(mark).toEqual({ kind: "family", family: "solana" });
  });

  it("unknown chain/address - falls back to the family mark", () => {
    expect(
      resolveTokenMark(999999, "0x000000000000000000000000000000000000ff", "FOO"),
    ).toEqual({ kind: "family", family: "evm" });
    expect(resolveTokenMark(1, null, "ETH")).toEqual({
      kind: "family",
      family: "evm",
    });
  });

  it("unknown family (no chain to resolve at all) - monogram, never a mark", () => {
    expect(resolveTokenMark(null, null, null)).toEqual({ kind: "monogram" });
    expect(resolveTokenMark(null, MAINNET_USDC, "USDC")).toEqual({
      kind: "monogram",
    });
  });

  it("a hostile symbol at a verified address never earns the brand mark", () => {
    // Control character spliced into the claimed symbol — sanitizeTokenSymbol
    // rejects it to null, so the row's expected-symbol comparison can never
    // match, regardless of address correctness.
    const mark = resolveTokenMark(1, MAINNET_USDC, "USD\nC");
    expect(mark).toEqual({ kind: "family", family: "evm" });
  });

  it("the post-USDT0-migration on-chain symbol does not fire the legacy USDT row (intended conservative behavior)", () => {
    // "USD₮0" - non-ASCII TUGRIK SIGN - sanitizeTokenSymbol rejects it.
    const mark = resolveTokenMark(42161, ARBITRUM_USDT, "USD₮0");
    expect(mark).toEqual({ kind: "family", family: "evm" });
  });

  it("the deliberately-excluded BSC-USD address never wears the Tether mark", () => {
    const mark = resolveTokenMark(56, BSC_PEG_USD, "BSC-USD");
    expect(mark).toEqual({ kind: "family", family: "evm" });
  });

  it("a genuine-but-uncatalogued EVM token gets the family mark, not a monogram", () => {
    expect(
      resolveTokenMark(1, "0x000000000000000000000000000000000000ff", "PEPE"),
    ).toEqual({ kind: "family", family: "evm" });
  });

  it("Polygon's own verified USDC row still requires the Polygon chain id", () => {
    const mark = resolveTokenMark(1, POLYGON_USDC, "USDC");
    expect(mark).toEqual({ kind: "family", family: "evm" });
  });

  it("grants Usdc on Polygon at Polygon's own verified USDC address", () => {
    const mark = resolveTokenMark(137, POLYGON_USDC, "USDC");
    expect(mark).toEqual({ kind: "brand", icon: Usdc });
  });

  it("a Solana holding with no tokenAddress at all falls back to family, not brand", () => {
    expect(resolveTokenMark(SOLANA_CHAIN_ID, null, "SOL")).toEqual({
      kind: "family",
      family: "solana",
    });
  });

  it("Tether address on the wrong Solana-vs-EVM family never crosses over", () => {
    // The verified mainnet USDT address, claimed on the Solana synthetic
    // chain id — family mismatch means the EVM row can never be reached.
    const mark = resolveTokenMark(
      SOLANA_CHAIN_ID,
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "USDT",
    );
    expect(mark).toEqual({ kind: "family", family: "solana" });
    expect(mark).not.toEqual({ kind: "brand", icon: Tether });
  });
});
