/**
 * bridge-activity-repair — R6 token correlation across the EVM NATIVE-ALIAS gap
 * (Card F3).
 *
 * Live evidence (2026-07-26 probe of the stuck rows): a Hyperstream-routed
 * Khalani order DOES carry `transactions.fill`, but Khalani reports a native
 * asset as the ZERO ADDRESS on both legs while Vex stored the model-echoed
 * `0xEeee…` sentinel. Plain case-insensitive equality therefore returned
 * `from_token` and the row (#104, execution 232) sat in `correlation_mismatch`
 * forever even though the fill was on-chain and final.
 *
 * The fix widens ONLY the token comparison, ONLY on `eip155`, and ONLY across
 * the closed native-alias set. Wrapped native (WETH) is a different ERC-20 and
 * must still mismatch — that assertion is the guard on the widening.
 *
 * Shapes come from the real capture; wallet/hash identities are substituted.
 */

import { describe, it, expect } from "vitest";

import {
  mapKhalaniOrderOutcome,
  type KhalaniOrderView,
  type StoredBridgeCorrelation,
  type StoredBridgeRoute,
} from "@vex-agent/sync/bridge-activity-repair.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

// Execution 232 / logical row #104: Base → Arbitrum, native → native, filled
// with an on-chain destination hash. Identities substituted.
const AUTHOR = "0x1111111111111111111111111111111111111111";
const DEPOSIT_HASH = `0x${"1a".repeat(32)}`;
const FILL_HASH = `0x${"2b".repeat(32)}`;

const EVM_ROUTE: StoredBridgeRoute = {
  fromChainId: 8453,
  fromChainFamily: "eip155",
  toChainId: 42161,
  toChainFamily: "eip155",
};

/** What Vex stored for row #104: the 0xEeee… sentinel on BOTH legs. */
const STORED_NATIVE: StoredBridgeCorrelation = {
  route: EVM_ROUTE,
  providerOrderId: "cms25eykj0001psp7444egzun",
  tokenInAddress: NATIVE_SENTINEL,
  tokenOutAddress: NATIVE_SENTINEL,
  author: AUTHOR,
  depositTxHash: DEPOSIT_HASH,
  quoteId: "550cf6b6-a8e4-4f4d-a3fd-62f0cb1d531a",
  routeId: "Hyperstream",
};

/** What Khalani returns for row #104: the ZERO ADDRESS on both legs. */
function hyperstreamNativeOrder(overrides: Partial<KhalaniOrderView> = {}): KhalaniOrderView {
  return {
    id: "cms25eykj0001psp7444egzun",
    status: "filled",
    fromChainId: 8453,
    toChainId: 42161,
    quoteId: "550cf6b6-a8e4-4f4d-a3fd-62f0cb1d531a",
    routeId: "Hyperstream",
    fromToken: ZERO_ADDRESS,
    toToken: ZERO_ADDRESS,
    author: AUTHOR,
    depositTxHash: DEPOSIT_HASH,
    transactions: { fill: { txHash: FILL_HASH, chainId: 42161 } },
    ...overrides,
  };
}

describe("R6 token correlation — EVM native aliases name the same asset (F3)", () => {
  it("the REAL stuck shape (zero address vs stored 0xEeee… sentinel) now correlates and becomes confirmable", () => {
    expect(mapKhalaniOrderOutcome(hyperstreamNativeOrder(), STORED_NATIVE)).toEqual({
      kind: "confirmable",
      providerStatus: "filled",
      fillTxHashes: [FILL_HASH],
      destChainId: 42161,
      destChainFamily: "eip155",
    });
  });

  it.each([
    ["the literal \"native\"", "native"],
    ["the literal \"NATIVE\" (upper case)", "NATIVE"],
    ["the lowercase 0xeeee… sentinel", NATIVE_SENTINEL.toLowerCase()],
    ["the zero address", ZERO_ADDRESS],
  ])("provider %s against the stored sentinel correlates", (_label, providerToken) => {
    const order = hyperstreamNativeOrder({ fromToken: providerToken, toToken: providerToken });
    expect(mapKhalaniOrderOutcome(order, STORED_NATIVE).kind).toBe("confirmable");
  });

  it("a stored \"native\" literal against a provider zero address correlates (alias set is symmetric)", () => {
    const stored: StoredBridgeCorrelation = { ...STORED_NATIVE, tokenInAddress: "native", tokenOutAddress: "native" };
    expect(mapKhalaniOrderOutcome(hyperstreamNativeOrder(), stored).kind).toBe("confirmable");
  });

  // ── The guard on the widening ──────────────────────────────────────────────

  it("WRAPPED native (WETH) is NOT a native alias — a WETH source still mismatches", () => {
    const order = hyperstreamNativeOrder({ fromToken: WETH_BASE });
    expect(mapKhalaniOrderOutcome(order, STORED_NATIVE)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field: "from_token",
    });
  });

  it("WRAPPED native (WETH) on the DESTINATION still mismatches", () => {
    const order = hyperstreamNativeOrder({ toToken: WETH_BASE });
    expect(mapKhalaniOrderOutcome(order, STORED_NATIVE)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field: "to_token",
    });
  });

  it("a stored WETH row is NOT satisfied by a native-alias provider token", () => {
    const stored: StoredBridgeCorrelation = { ...STORED_NATIVE, tokenOutAddress: WETH_BASE };
    expect(mapKhalaniOrderOutcome(hyperstreamNativeOrder(), stored)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field: "to_token",
    });
  });

  it("a genuinely foreign ERC-20 still mismatches", () => {
    const order = hyperstreamNativeOrder({ toToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
    expect(mapKhalaniOrderOutcome(order, STORED_NATIVE).kind).toBe("correlation_mismatch");
  });

  it("the alias equivalence does NOT leak into non-token fields (a mismatched author still fails)", () => {
    const order = hyperstreamNativeOrder({ author: ZERO_ADDRESS });
    expect(mapKhalaniOrderOutcome(order, STORED_NATIVE)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field: "author",
    });
  });

  // ── Solana family is untouched (base58 is case-sensitive, no native alias) ──

  it("a SOLANA destination is unaffected: case-sensitive base58 mints still mismatch on case", () => {
    const solanaRoute: StoredBridgeRoute = { ...EVM_ROUTE, toChainId: 20011000000, toChainFamily: "solana" };
    const stored: StoredBridgeCorrelation = {
      ...STORED_NATIVE,
      route: solanaRoute,
      tokenOutAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const order = hyperstreamNativeOrder({
      toChainId: 20011000000,
      toToken: "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
      transactions: { fill: { txHash: FILL_HASH, chainId: 20011000000 } },
    });
    expect(mapKhalaniOrderOutcome(order, stored)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field: "to_token",
    });
  });

  it("a SOLANA destination does NOT accept the zero address as a native alias", () => {
    const solanaRoute: StoredBridgeRoute = { ...EVM_ROUTE, toChainId: 20011000000, toChainFamily: "solana" };
    const stored: StoredBridgeCorrelation = { ...STORED_NATIVE, route: solanaRoute, tokenOutAddress: "native" };
    const order = hyperstreamNativeOrder({
      toChainId: 20011000000,
      toToken: ZERO_ADDRESS,
      transactions: { fill: { txHash: FILL_HASH, chainId: 20011000000 } },
    });
    expect(mapKhalaniOrderOutcome(order, stored)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field: "to_token",
    });
  });
});
