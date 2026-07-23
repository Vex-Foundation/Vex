import { describe, it, expect, vi } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

// Only `kyberswap.chains.supported` (C23) needs a mock — it calls the live
// Common Service client. Every other case here either fails on
// required-param validation (before any network/chain call) or reads the
// REAL static chain registry (kyberswap.chains) — no external dependency to
// stub.
const mockGetSupportedChains = vi.fn();
vi.mock("@tools/kyberswap/common/client.js", () => ({
  getKyberCommonClient: () => ({ getSupportedChains: () => mockGetSupportedChains() }),
}));

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}

import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";
import { KYBERSWAP_TOOLS } from "../../../../vex-agent/tools/protocols/kyberswap/manifest.js";

describe("kyberswap handlers", () => {
  // ── Handler coverage ─────────────────────────────────────────────
  //
  // Agent Scan plan §4.2 deleted limit-order (10) + zap (4) tooling and
  // collapsed swap.sell/swap.buy into ONE unified swap.execute — 5 tools/
  // handlers remain: chains, chains.supported, tokens.check, swap.quote,
  // swap.execute.

  it("has a handler for every manifest toolId", () => {
    const handlerKeys = new Set(Object.keys(KYBERSWAP_HANDLERS));
    const manifestIds = KYBERSWAP_TOOLS.map(t => t.toolId);
    const missing = manifestIds.filter(id => !handlerKeys.has(id));
    expect(missing).toEqual([]);
  });

  it("has no extra handlers without manifests", () => {
    const manifestIds = new Set(KYBERSWAP_TOOLS.map(t => t.toolId));
    const handlerKeys = Object.keys(KYBERSWAP_HANDLERS);
    const extra = handlerKeys.filter(key => !manifestIds.has(key));
    expect(extra).toEqual([]);
  });

  it("handler count matches manifest count (5)", () => {
    expect(Object.keys(KYBERSWAP_HANDLERS)).toHaveLength(5);
  });

  it("every handler is a function", () => {
    for (const [, handler] of Object.entries(KYBERSWAP_HANDLERS)) {
      expect(typeof handler).toBe("function");
    }
  });

  it("does not register a handler for any retired limitOrder/zap/sell/buy toolId", () => {
    const handlerKeys = Object.keys(KYBERSWAP_HANDLERS);
    for (const key of handlerKeys) {
      expect(key).not.toMatch(/^kyberswap\.limitOrder\./);
      expect(key).not.toMatch(/^kyberswap\.zap\./);
    }
    expect(handlerKeys).not.toContain("kyberswap.swap.sell");
    expect(handlerKeys).not.toContain("kyberswap.swap.buy");
  });

  // ── Required param validation ────────────────────────────────────

  it("kyberswap.tokens.check fails without chain and address", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.tokens.check"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("kyberswap.swap.quote fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.swap.execute fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: "ETH" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  // ── Read-only handlers return data (no wallet needed) ────────────

  it("kyberswap.chains returns chain list (19 aggregator chains, Scroll/zkSync dropped)", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.chains"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(19);
    expect(data[0].slug).toBeDefined();
    expect(data[0].chainId).toBeDefined();
    expect(data[0].aggregator).toBeDefined();
  });

  // C23 (Codex final-review finding 8): the provider's live list must be
  // intersected with our OWN registry — a chain we no longer execute
  // (Scroll/zkSync) or a brand-new provider-only chain must never be
  // re-advertised as Vex-supported.
  it("kyberswap.chains.supported intersects the provider list with the local registry", async () => {
    mockGetSupportedChains.mockResolvedValueOnce([
      { chainId: 1, chainName: "ethereum", displayName: "Ethereum", state: "active" as const }, // ours
      { chainId: 534352, chainName: "scroll", displayName: "Scroll", state: "active" as const }, // dropped (ZaaS-only)
      { chainId: 324, chainName: "zksync", displayName: "zkSync", state: "active" as const }, // dropped (ZaaS-only)
      { chainId: 999999, chainName: "future-chain", displayName: "Future Chain", state: "new" as const }, // unonboarded
    ]);

    const result = await KYBERSWAP_HANDLERS["kyberswap.chains.supported"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output) as Array<{ chainId: number }>;
    expect(data.map((c) => c.chainId)).toEqual([1]);
  });
});
