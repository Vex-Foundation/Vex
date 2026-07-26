/**
 * getEvmNativeCurrency — per-chain native currency resolution for agent-facing
 * labels.
 *
 * The rule this suite defends: the resolver must be RIGHT or ABSENT, never
 * confidently wrong. `toViemChain` (kyberswap/evm/config.ts) hardcodes
 * `symbol: "ETH"` for every non-Robinhood chain, so wiring a label to it would
 * say ETH on BSC/Polygon/Avalanche. These tests pin the real per-chain symbol
 * and pin `undefined` (never a guess) for anything unresolvable.
 */

import { describe, it, expect } from "vitest";

import {
  getEvmNativeCurrency,
  annotateNativeSymbol,
  NATIVE_SENTINEL_SYMBOL,
} from "@tools/evm-chains/native-currency.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";

describe("getEvmNativeCurrency", () => {
  it("resolves the REAL symbol for non-ETH natives (the toViemChain trap)", () => {
    // Every one of these would read "ETH" if the label were wired to
    // `toViemChain`. That is the specific bug this module exists to prevent.
    expect(getEvmNativeCurrency(56)?.symbol).toBe("BNB"); // BSC
    expect(getEvmNativeCurrency(137)?.symbol).toBe("POL"); // Polygon
    expect(getEvmNativeCurrency(43114)?.symbol).toBe("AVAX"); // Avalanche
    expect(getEvmNativeCurrency(5000)?.symbol).toBe("MNT"); // Mantle
    expect(getEvmNativeCurrency(146)?.symbol).toBe("S"); // Sonic
    expect(getEvmNativeCurrency(80094)?.symbol).toBe("BERA"); // Berachain
    expect(getEvmNativeCurrency(2020)?.symbol).toBe("RON"); // Ronin
    expect(getEvmNativeCurrency(9745)?.symbol).toBe("XPL"); // Plasma
    expect(getEvmNativeCurrency(42793)?.symbol).toBe("XTZ"); // Etherlink
    expect(getEvmNativeCurrency(143)?.symbol).toBe("MON"); // Monad
    expect(getEvmNativeCurrency(999)?.symbol).toBe("HYPE"); // HyperEVM
  });

  it("resolves ETH for the genuinely-ETH chains", () => {
    for (const chainId of [1, 42161, 10, 8453, 59144, 130, 4326]) {
      expect(getEvmNativeCurrency(chainId)?.symbol).toBe("ETH");
    }
  });

  it("resolves Robinhood (4663) from the local evm-chains registry, not viem", () => {
    // viem/chains has NO entry for 4663 — the local registry is the only source.
    const native = getEvmNativeCurrency(4663);
    expect(native).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
  });

  it("disambiguates chain id 999 to HyperEVM, never a testnet sharing the id", () => {
    // viem exports THREE chains claiming id 999: hyperEvm (HYPE),
    // wanchainTestnet (WANt) and zoraTestnet (ETH). A scan-by-id would be a
    // coin flip between them; the explicit map must pick HyperEVM.
    const native = getEvmNativeCurrency(999);
    expect(native?.symbol).toBe("HYPE");
    expect(native?.symbol).not.toBe("WANt");
    expect(native?.symbol).not.toBe("ETH");
  });

  it("resolves EVERY KyberSwap aggregator chain — no chain degrades today", () => {
    for (const chain of getKyberChains()) {
      const native = getEvmNativeCurrency(chain.chainId);
      expect(native, `chain ${chain.slug} (${chain.chainId}) must resolve`).toBeDefined();
      expect(native?.symbol.length).toBeGreaterThan(0);
    }
  });

  it("reports 18 decimals for every KyberSwap chain (money-path invariant)", () => {
    // `decimals` feeds parseUnits/formatUnits on a real swap leg. It used to be
    // hardcoded to 18; it is now SOURCED. This test is the tripwire: if a chain
    // is ever added whose native is not 18 decimals, this fails loudly instead
    // of silently mis-parsing an amount by orders of magnitude.
    for (const chain of getKyberChains()) {
      expect(
        getEvmNativeCurrency(chain.chainId)?.decimals,
        `chain ${chain.slug} native decimals`,
      ).toBe(18);
    }
  });

  it("returns undefined for an unknown chain rather than guessing ETH", () => {
    expect(getEvmNativeCurrency(1337)).toBeUndefined();
    expect(getEvmNativeCurrency(0)).toBeUndefined();
    expect(getEvmNativeCurrency(-1)).toBeUndefined();
    expect(getEvmNativeCurrency(Number.NaN)).toBeUndefined();
  });
});

describe("annotateNativeSymbol", () => {
  it("annotates the canonical sentinel with the chain's real symbol", () => {
    expect(annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, 56)).toBe("NATIVE (BNB)");
    expect(annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, 137)).toBe("NATIVE (POL)");
    expect(annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, 8453)).toBe("NATIVE (ETH)");
    expect(annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, 4663)).toBe("NATIVE (ETH)");
  });

  it("degrades to bare NATIVE when the chain cannot be resolved", () => {
    expect(annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, 1337)).toBe("NATIVE");
    expect(annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, null)).toBe("NATIVE");
    expect(annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, undefined)).toBe("NATIVE");
  });

  it("leaves every non-sentinel symbol untouched", () => {
    // The history projection runs this over EVERY row of a fused multi-venue
    // feed. It must be an exact no-op for real tickers and for the address
    // fallback the query COALESCEs in when a symbol is null.
    expect(annotateNativeSymbol("USDC", 8453)).toBe("USDC");
    expect(annotateNativeSymbol("ETH", 8453)).toBe("ETH");
    expect(annotateNativeSymbol("POL", 137)).toBe("POL");
    expect(annotateNativeSymbol("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", 1)).toBe(
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    );
    expect(annotateNativeSymbol(null, 1)).toBeNull();
    expect(annotateNativeSymbol(undefined, 1)).toBeUndefined();
  });

  it("is case-sensitive on the sentinel — a token literally named 'native' is not it", () => {
    // The sentinel is a value WE mint in uppercase. A lowercase lookalike is an
    // ordinary (possibly hostile) ERC-20 symbol and must not be dressed up as
    // the chain's native asset.
    expect(annotateNativeSymbol("native", 56)).toBe("native");
    expect(annotateNativeSymbol("Native", 56)).toBe("Native");
  });

  it("is idempotent — re-annotating an annotated label does not nest", () => {
    const once = annotateNativeSymbol(NATIVE_SENTINEL_SYMBOL, 56);
    expect(annotateNativeSymbol(once, 56)).toBe("NATIVE (BNB)");
  });
});
