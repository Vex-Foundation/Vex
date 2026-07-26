/**
 * Pre-quote bridge route guard (W1, R9). The pure classifier is exercised with
 * the REAL Khalani + local resolvers (so alias/numeric/slug resolution and the
 * tron-alias trap are genuinely covered); the async wrapper is exercised against
 * the real cached registry driven by a fetch mock (happy path + fail-closed
 * propagation).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyKhalaniPrequoteRoute,
  resolveKhalaniPrequoteRoute,
} from "@tools/khalani/prequote-route-guard.js";
import { clearKhalaniChainsCache } from "@tools/khalani/chains.js";
import type { KhalaniChain } from "@tools/khalani/types.js";

// Family-filtered live registry (eip155 + solana only — bitcoin/tron are skipped
// by validateChainsResponse, so they never appear here).
const CHAINS: KhalaniChain[] = [
  {
    type: "eip155",
    id: 1,
    name: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://eth.example"] } },
  },
  {
    type: "eip155",
    id: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://base.example"] } },
  },
  {
    type: "eip155",
    id: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://arb.example"] } },
  },
  {
    type: "solana",
    id: 20011000000,
    name: "Solana",
    nativeCurrency: { name: "Sol", symbol: "SOL", decimals: 9 },
    rpcUrls: { default: { http: ["https://sol.example"] } },
  },
];

describe("classifyKhalaniPrequoteRoute — pure venue classification (R9)", () => {
  it("both endpoints in the live registry → khalani", () => {
    expect(classifyKhalaniPrequoteRoute("base", "arbitrum", CHAINS)).toEqual({
      outcome: "khalani",
      fromChainId: 8453,
      toChainId: 42161,
    });
  });

  it("numeric chain ids that are registered → khalani", () => {
    expect(classifyKhalaniPrequoteRoute("8453", "1", CHAINS)).toEqual({
      outcome: "khalani",
      fromChainId: 8453,
      toChainId: 1,
    });
  });

  it("a registered solana endpoint → khalani (family-filter keeps solana)", () => {
    expect(classifyKhalaniPrequoteRoute("solana", "base", CHAINS)).toEqual({
      outcome: "khalani",
      fromChainId: 20011000000,
      toChainId: 8453,
    });
  });

  it("local chain (Robinhood) on the TO side → static_relay", () => {
    expect(classifyKhalaniPrequoteRoute("base", "robinhood", CHAINS)).toEqual({
      outcome: "static_relay",
      localChainId: 4663,
      localSide: "to",
    });
  });

  it("local chain (Robinhood) on the FROM side → static_relay", () => {
    expect(classifyKhalaniPrequoteRoute("robinhood", "base", CHAINS)).toEqual({
      outcome: "static_relay",
      localChainId: 4663,
      localSide: "from",
    });
  });

  it("local chain via numeric id (4663) → static_relay (never masqueraded as khalani)", () => {
    expect(classifyKhalaniPrequoteRoute("4663", "base", CHAINS)).toEqual({
      outcome: "static_relay",
      localChainId: 4663,
      localSide: "from",
    });
  });

  it("both sides local (Robinhood ↔ 4663) → static_relay (from side wins)", () => {
    expect(classifyKhalaniPrequoteRoute("robinhood", "4663", CHAINS)).toEqual({
      outcome: "static_relay",
      localChainId: 4663,
      localSide: "from",
    });
  });

  it("nonlocal endpoint absent from the registry (TO side) → no_route", () => {
    expect(classifyKhalaniPrequoteRoute("base", "99999", CHAINS)).toEqual({
      outcome: "no_route",
      missing: ["to"],
    });
  });

  it("both endpoints absent → no_route (both sides)", () => {
    expect(classifyKhalaniPrequoteRoute("99999", "88888", CHAINS)).toEqual({
      outcome: "no_route",
      missing: ["from", "to"],
    });
  });

  it("tron alias trap: resolves via CHAIN_ALIASES but is absent from the family-filtered registry → no_route", () => {
    // `resolveChainId('tron')` returns 728126428 via CHAIN_ALIASES, but the live
    // registry never carries tron (foreign family), so the guard must NOT treat
    // it as Khalani-serviceable — it is a nonlocal miss → no_route (reveal).
    expect(classifyKhalaniPrequoteRoute("base", "tron", CHAINS)).toEqual({
      outcome: "no_route",
      missing: ["to"],
    });
    expect(classifyKhalaniPrequoteRoute("tron", "base", CHAINS)).toEqual({
      outcome: "no_route",
      missing: ["from"],
    });
  });
});

describe("resolveKhalaniPrequoteRoute — live registry wrapper", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearKhalaniChainsCache();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearKhalaniChainsCache();
  });

  it("classifies against the fetched family-filtered registry", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => CHAINS,
    });
    await expect(resolveKhalaniPrequoteRoute("base", "arbitrum")).resolves.toEqual({
      outcome: "khalani",
      fromChainId: 8453,
      toChainId: 42161,
    });
  });

  it("fail-closed: a registry-fetch failure PROPAGATES (never guesses a venue)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    await expect(resolveKhalaniPrequoteRoute("base", "arbitrum")).rejects.toBeTruthy();
  });
});
