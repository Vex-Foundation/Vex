/**
 * Khalani concise token/chain projectors (P0-4).
 *
 * Pins the keep/drop/lift contract:
 *  - projectToken keeps identity, lifts priceUsd/balance/isRiskToken out of the
 *    open `extensions` bag, DERIVES the human amount and USD estimate for a
 *    balance row, and drops `logoURI` + the rest of the bag.
 *  - projectChain keeps id/name/type + native symbol/decimals and drops
 *    rpcUrls/blockExplorers.
 * Plus a capture-safety fence: every Khalani read tool the projectors wire into
 * is `mutating:false` / `actionKind:"read"`, so projecting the output (which
 * trims the unused `data` too) can never strip a `_tradeCapture` payload.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  projectChain,
  projectChains,
  projectToken,
  projectTokens,
} from "../../../vex-agent/tools/protocols/khalani/projectors.js";
import { KHALANI_TOOLS } from "../../../vex-agent/tools/protocols/khalani/manifest.js";
import type { KhalaniChain, KhalaniToken } from "@tools/khalani/types.js";

/** A fully-populated token with the noise fields the projector drops. */
function fullToken(): KhalaniToken {
  return {
    address: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    chainId: 1,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    logoURI: "https://img.example/usdc.png",
    extensions: {
      balance: "1500000",
      isRiskToken: false,
      price: { usd: "1.0001" },
      // Open passthrough noise — must not survive projection.
      coingeckoId: "usd-coin",
      someProviderBlob: { nested: "x" },
    },
  };
}

/** A fully-populated chain with the provider metadata the projector drops. */
function fullChain(): KhalaniChain {
  return {
    type: "eip155",
    id: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
    blockExplorers: { default: { name: "Basescan", url: "https://basescan.org", apiUrl: "https://api.basescan.org" } },
  };
}

describe("khalani projectToken (P0-4 concise)", () => {
  it("keeps the identity set with correct values", () => {
    const out = projectToken(fullToken());
    expect(out.address).toBe("0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(out.chainId).toBe(1);
    expect(out.name).toBe("USD Coin");
    expect(out.symbol).toBe("USDC");
    expect(out.decimals).toBe(6);
  });

  it("lifts priceUsd/balance/isRiskToken and derives the human amount + USD estimate", () => {
    const out = projectToken(fullToken());
    expect(out.priceUsd).toBe("1.0001");
    // The atomic amount is preserved VERBATIM under its own name...
    expect(out.balanceRaw).toBe("1500000");
    // ...and the human amount is derived here, so the model never divides.
    expect(out.balance).toBe("1.5");
    expect(out.valueUsd).toBe("1.50015");
    expect(out.priceUnavailable).toBeUndefined();
    expect(out.unprojectableReason).toBeUndefined();
    expect(out.isRiskToken).toBe(false);
  });

  it("drops logoURI and the open extensions passthrough bag", () => {
    const out = projectToken(fullToken());
    expect(out).not.toHaveProperty("logoURI");
    expect(out).not.toHaveProperty("extensions");
    // The bag's free-form keys must not leak onto the concise row either.
    expect(out).not.toHaveProperty("coingeckoId");
    expect(out).not.toHaveProperty("someProviderBlob");
  });

  it("omits absent signals (no extensions) rather than emitting null/undefined keys", () => {
    const minimal: KhalaniToken = {
      address: "0x0000000000000000000000000000000000000001",
      chainId: 137,
      name: "Minimal",
      symbol: "MIN",
      decimals: 18,
    };
    const out = projectToken(minimal);
    expect(out).toEqual({
      address: "0x0000000000000000000000000000000000000001",
      chainId: 137,
      name: "Minimal",
      symbol: "MIN",
      decimals: 18,
    });
    expect(out).not.toHaveProperty("priceUsd");
    expect(out).not.toHaveProperty("balance");
    expect(out).not.toHaveProperty("balanceRaw");
    expect(out).not.toHaveProperty("valueUsd");
    expect(out).not.toHaveProperty("isRiskToken");
  });

  it("is defensive against malformed extensions (wrong-typed / partial bag)", () => {
    const weird: KhalaniToken = {
      address: "0x0000000000000000000000000000000000000002",
      chainId: 1,
      name: "Weird",
      symbol: "WRD",
      decimals: 8,
      extensions: {
        // price present but `usd` is not a string → not lifted.
        price: { usd: undefined },
        // balance is the wrong type → not lifted.
        balance: undefined,
        isRiskToken: true,
      },
    };
    const out = projectToken(weird);
    expect(out).not.toHaveProperty("priceUsd");
    expect(out).not.toHaveProperty("balance");
    expect(out).not.toHaveProperty("balanceRaw");
    expect(out.isRiskToken).toBe(true);
  });

  it("projectTokens tolerates a non-array input and maps arrays", () => {
    expect(projectTokens(null)).toEqual([]);
    expect(projectTokens(undefined)).toEqual([]);
    const arr = projectTokens([fullToken(), fullToken()]);
    expect(arr).toHaveLength(2);
    expect(arr[0]!.symbol).toBe("USDC");
    expect(arr[0]).not.toHaveProperty("logoURI");
  });
});

describe("khalani projectChain (P0-4 concise)", () => {
  it("keeps id/name/type and lifts native symbol/decimals", () => {
    const out = projectChain(fullChain());
    expect(out.id).toBe(8453);
    expect(out.name).toBe("Base");
    expect(out.type).toBe("eip155");
    expect(out.nativeSymbol).toBe("ETH");
    expect(out.nativeDecimals).toBe(18);
  });

  it("drops rpcUrls and blockExplorers", () => {
    const out = projectChain(fullChain());
    expect(out).not.toHaveProperty("rpcUrls");
    expect(out).not.toHaveProperty("blockExplorers");
    expect(out).not.toHaveProperty("nativeCurrency");
  });

  it("normalises a missing native block to null fields", () => {
    const noNative = {
      type: "solana" as const,
      id: 20011000000,
      name: "Solana",
      // nativeCurrency intentionally omitted to exercise the defensive path.
    } as unknown as KhalaniChain;
    const out = projectChain(noNative);
    expect(out.id).toBe(20011000000);
    expect(out.type).toBe("solana");
    expect(out.nativeSymbol).toBeNull();
    expect(out.nativeDecimals).toBeNull();
  });

  it("projectChains tolerates a non-array input and maps arrays", () => {
    expect(projectChains(null)).toEqual([]);
    expect(projectChains(undefined)).toEqual([]);
    const arr = projectChains([fullChain(), fullChain()]);
    expect(arr).toHaveLength(2);
    expect(arr[0]!.name).toBe("Base");
    expect(arr[0]).not.toHaveProperty("rpcUrls");
  });
});

/**
 * Capture-safety fence (CC-4 / P0-4): the concise projection is only safe on
 * NON-mutating handlers — projecting the result trims the unused `data` too, so
 * on a MUTATING handler it would strip `_tradeCapture` and break the capture
 * pipeline. The projectors wire into the five Khalani read tools below; this pins
 * that all are `mutating:false` reads.
 */
describe("capture-safety — projected khalani handlers are non-mutating reads", () => {
  it("every projected tool manifest is mutating:false reads", () => {
    for (const toolId of [
      "khalani.chains.list",
      "khalani.tokens.top",
      "khalani.tokens.search",
      "khalani.tokens.autocomplete",
      "khalani.tokens.balances",
    ]) {
      const manifest = KHALANI_TOOLS.find((t) => t.toolId === toolId);
      expect(manifest, `manifest for ${toolId}`).toBeDefined();
      expect(manifest?.mutating).toBe(false);
      expect(manifest?.actionKind).toBe("read");
    }
  });

  it("read.ts wires the projectors into the read handlers", () => {
    const readPath = fileURLToPath(
      new URL(
        "../../../vex-agent/tools/protocols/khalani/handlers/read.ts",
        import.meta.url,
      ),
    );
    const source = readFileSync(readPath, "utf8");
    expect(source).toContain("projectChains");
    expect(source).toContain("projectTokens");
    expect(source).toContain("projectChain");
    expect(source).toContain("projectToken");
  });
});
