/**
 * Swap-prequote FAÇADE surface test.
 *
 * After the structural split into `./prequote/*`, the original
 * `swap-prequote.ts` path stays as a compatibility façade. This test pins the
 * EXACT public surface: every previously-public runtime value/function is still
 * present with the correct `typeof`, the runtime export key SET is exactly the
 * expected set (no accidental additions like internal helpers leaking onto the
 * façade), and the previously-public TYPES still import (compile-time).
 *
 * The repo + wallet leaves are mocked so importing the façade (which transitively
 * loads the recorder/gate modules) performs no IO.
 */

import { describe, it, expect, vi } from "vitest";

// Mock the leaf dependencies so the façade import is side-effect free (mirrors
// the sibling prequote tests). No call is made here; these only prevent the
// transitive modules from reaching real IO at evaluation.
vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: vi.fn(),
  findLatestFreshByMatch: vi.fn(),
  existsFreshFailByMatch: vi.fn(),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(),
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedToken: vi.fn(),
}));

import * as facade from "@vex-agent/tools/protocols/swap-prequote.js";

// Type-only imports — these must compile against the façade re-exports. If a
// type were dropped from the façade, the file would fail to typecheck.
import type {
  SwapMatchInput,
  BridgeMatchInput,
  PrequoteMatchInput,
  BridgeTradeType,
  ExecuteGateRegistration,
  GateDecision,
} from "@vex-agent/tools/protocols/swap-prequote.js";

describe("swap-prequote façade surface", () => {
  it("exposes every expected runtime export with the correct typeof", () => {
    expect(typeof facade.PREQUOTE_QUOTE_TOOLS).toBe("object");
    expect(facade.PREQUOTE_QUOTE_TOOLS).not.toBeNull();
    expect(typeof facade.EXECUTE_GATE_TOOLS).toBe("object");
    expect(facade.EXECUTE_GATE_TOOLS).not.toBeNull();
    expect(typeof facade.PREQUOTE_MAX_AGE_MS).toBe("number");

    expect(typeof facade.computePrequoteMatchHash).toBe("function");
    expect(typeof facade.buildBridgeIdentity).toBe("function");
    expect(typeof facade.extractQuote).toBe("function");
    expect(typeof facade.recordPrequoteFromQuote).toBe("function");
    expect(typeof facade.evaluatePrequoteGate).toBe("function");
    expect(typeof facade.evaluateSwapPrequoteGate).toBe("function");
    expect(typeof facade.findFreshMatchedSwapPrequote).toBe("function");
  });

  it("pins the EXACT set of runtime export keys (no internal helper leakage)", () => {
    expect(new Set(Object.keys(facade))).toEqual(
      new Set([
        "PREQUOTE_QUOTE_TOOLS",
        "PREQUOTE_MAX_AGE_MS",
        "EXECUTE_GATE_TOOLS",
        "computePrequoteMatchHash",
        "buildBridgeIdentity",
        "extractQuote",
        "recordPrequoteFromQuote",
        "evaluatePrequoteGate",
        "evaluateSwapPrequoteGate",
        "findFreshMatchedSwapPrequote",
      ]),
    );
  });

  it("preserves the registry values verbatim through the façade", () => {
    // Spot-check the re-exported data is the real registry, not an empty stub.
    expect(facade.PREQUOTE_QUOTE_TOOLS["kyberswap.swap.quote"]).toEqual({
      kind: "swap",
      family: "eip155",
      provider: "kyberswap",
    });
    expect(facade.EXECUTE_GATE_TOOLS["khalani.bridge"]).toEqual({ kind: "bridge", provider: "khalani" });
    expect(facade.PREQUOTE_MAX_AGE_MS).toBe(15 * 60_000);
  });

  it("type-only exports remain importable (compile-time)", () => {
    // Exercise each imported type so the import is not elided and the test
    // fails to compile if any type were dropped from the façade.
    const swap: SwapMatchInput = {
      kind: "swap",
      sessionId: "s",
      family: "eip155",
      chainId: 1,
      walletAddress: "0x0",
      tokenIn: "0x1",
      tokenOut: "0x2",
      amount: "1",
      recipient: "0x0",
      approveExact: false,
      slippageBps: "",
    };
    const tradeType: BridgeTradeType = "EXACT_INPUT";
    const bridge: BridgeMatchInput = {
      kind: "bridge",
      sessionId: "s",
      sourceFamily: "eip155",
      destFamily: "solana",
      fromChainId: 1,
      toChainId: 2,
      sourceWallet: "0x0",
      recipient: "rcpt",
      fromToken: "0x1",
      toToken: "mint",
      amount: "1000",
      tradeType,
      refundTo: "0x0",
      referrer: "",
      referrerFeeBps: "",
      filler: "",
    };
    const match: PrequoteMatchInput = swap;
    const gateReg: ExecuteGateRegistration = { kind: "bridge" };
    const decision: GateDecision = { kind: "allow", verdict: "pass", prequoteId: "p" };

    expect(swap.kind).toBe("swap");
    expect(bridge.kind).toBe("bridge");
    expect(match.kind).toBe("swap");
    expect(gateReg.kind).toBe("bridge");
    expect(decision.kind).toBe("allow");
  });
});
