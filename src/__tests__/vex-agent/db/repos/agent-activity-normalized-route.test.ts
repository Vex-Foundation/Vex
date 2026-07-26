/**
 * `buildNormalizedBridgeRoute` (migration 045) — the in-flight guard key. Pure
 * function, no DB. Pins the Codex GREEN-LIGHT properties: the key is FAMILY-SAFE
 * (the divergent provider-native Solana ids collapse to one canonical token) and
 * EXCLUDES provider/protocol, so Khalani and Relay cannot race one route into two
 * in-flight bridges. EVM token addresses are case-folded; Solana mints are not.
 */
import { describe, it, expect } from "vitest";
import { buildNormalizedBridgeRoute } from "../../../../vex-agent/db/repos/agent-activity.js";

describe("buildNormalizedBridgeRoute", () => {
  it("builds an EVM route key with eip155:<id> chain keys and lowercased tokens", () => {
    const key = buildNormalizedBridgeRoute({
      fromChainId: 8453,
      fromChainFamily: "eip155",
      fromToken: "0xAAAAbbbb",
      toChainId: 42161,
      toChainFamily: "eip155",
      toToken: "0xCCCCdddd",
    });
    expect(key).toBe("eip155:8453:0xaaaabbbb->eip155:42161:0xccccdddd");
  });

  it("is case-insensitive for EVM token addresses (same route collides)", () => {
    const a = buildNormalizedBridgeRoute({
      fromChainId: 8453, fromChainFamily: "eip155", fromToken: "0xABCDEF",
      toChainId: 10, toChainFamily: "eip155", toToken: "0x123456",
    });
    const b = buildNormalizedBridgeRoute({
      fromChainId: 8453, fromChainFamily: "eip155", fromToken: "0xabcdef",
      toChainId: 10, toChainFamily: "eip155", toToken: "0x123456",
    });
    expect(a).toBe(b);
  });

  it("is FAMILY-SAFE: the divergent provider-native Solana ids collapse to one canonical route", () => {
    // Khalani's native Solana id (20011000000) and Relay's (792703809) denote the
    // same chain — both must produce the SAME route key so the guard blocks a
    // cross-provider race.
    const khalani = buildNormalizedBridgeRoute({
      fromChainId: 20011000000, fromChainFamily: "solana", fromToken: "So1Mint",
      toChainId: 8453, toChainFamily: "eip155", toToken: "0xUSDC",
    });
    const relay = buildNormalizedBridgeRoute({
      fromChainId: 792703809, fromChainFamily: "solana", fromToken: "So1Mint",
      toChainId: 8453, toChainFamily: "eip155", toToken: "0xusdc",
    });
    expect(khalani).toBe(relay);
    expect(khalani).toBe("solana:So1Mint->eip155:8453:0xusdc");
  });

  it("is case-SENSITIVE for Solana mints (base58) and never contains a provider name", () => {
    const upper = buildNormalizedBridgeRoute({
      fromChainId: 792703809, fromChainFamily: "solana", fromToken: "MintABC",
      toChainId: 8453, toChainFamily: "eip155", toToken: "0xUSDC",
    });
    const lower = buildNormalizedBridgeRoute({
      fromChainId: 792703809, fromChainFamily: "solana", fromToken: "mintabc",
      toChainId: 8453, toChainFamily: "eip155", toToken: "0xUSDC",
    });
    expect(upper).not.toBe(lower);
    expect(upper).not.toMatch(/khalani|relay/i);
  });
});
