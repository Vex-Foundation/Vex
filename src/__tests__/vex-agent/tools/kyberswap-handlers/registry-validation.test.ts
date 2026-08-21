import { describe, it, expect, vi } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

// Only `kyberswap.chains` with `liveStatus: true` needs a mock — that is the
// one path calling the live Common Service client. Every other case here
// either fails on required-param validation (before any network/chain call) or
// reads the REAL static chain registry — no external dependency to stub.
const mockGetSupportedChains = vi.fn();
vi.mock("@tools/kyberswap/common/client.js", () => ({
  getKyberCommonClient: () => ({ getSupportedChains: () => mockGetSupportedChains() }),
}));

/** Named lookup, so a missing handler fails as itself rather than as a crash. */
function handlerFor(toolId: string): ProtocolHandler {
  const handler = KYBERSWAP_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  return handler;
}

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
import type { ProtocolHandler } from "@vex-agent/tools/protocols/types.js";
import { KYBERSWAP_TOOLS } from "../../../../vex-agent/tools/protocols/kyberswap/manifest.js";

describe("kyberswap handlers", () => {
  // ── Handler coverage ─────────────────────────────────────────────
  //
  // Agent Scan plan §4.2 deleted limit-order (10) + zap (4) tooling and
  // collapsed swap.sell/swap.buy into ONE unified swap.execute. Batch 2 (owner
  // decision D7) then retired `chains.supported` into `chains`'s `liveStatus`
  // param — 4 tools/handlers remain: chains, tokens.check, swap.quote,
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

  it("handler count matches manifest count (4)", () => {
    expect(Object.keys(KYBERSWAP_HANDLERS)).toHaveLength(4);
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

  it("kyberswap.chains returns the registry (18 aggregator chains, Scroll/zkSync/Etherlink dropped)", async () => {
    const result = await handlerFor("kyberswap.chains")(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output) as {
      liveStatus: boolean;
      liveStatusAvailable: boolean | null;
      count: number;
      chains: Array<{ slug: string; chainId: number; aggregator: boolean; state: string | null; stateReason: string | null }>;
    };
    expect(data.count).toBe(18);
    expect(data.chains).toHaveLength(18);
    const [first] = data.chains;
    expect(first?.slug).toBeDefined();
    expect(first?.chainId).toBeDefined();
    expect(first?.aggregator).toBeDefined();
    // No live read was asked for, so the state is null and SAYS why — an
    // unexplained null would read as "the provider reports nothing".
    expect(first?.state).toBeNull();
    expect(first?.stateReason).toContain("liveStatus was not set");
    expect(data.liveStatus).toBe(false);
    // "not attempted" is a different answer from "attempted and failed".
    expect(data.liveStatusAvailable).toBeNull();
    expect(mockGetSupportedChains).not.toHaveBeenCalled();
  });

  // C23 (Codex final-review finding 8) survives the merge as the JOIN
  // DIRECTION: rows are the registry's, so a chain we no longer execute
  // (Scroll/zkSync) or a brand-new provider-only chain can never be
  // re-advertised as Vex-supported. The live read can add a state, never a row.
  it("kyberswap.chains liveStatus joins provider state onto registry rows without adding chains", async () => {
    mockGetSupportedChains.mockResolvedValueOnce([
      { chainId: 1, chainName: "ethereum", displayName: "Ethereum", state: "active" as const }, // ours
      { chainId: 534352, chainName: "scroll", displayName: "Scroll", state: "active" as const }, // dropped (ZaaS-only)
      { chainId: 324, chainName: "zksync", displayName: "zkSync", state: "active" as const }, // dropped (ZaaS-only)
      { chainId: 999999, chainName: "future-chain", displayName: "Future Chain", state: "new" as const }, // unonboarded
    ]);

    const result = await handlerFor("kyberswap.chains")(
      { liveStatus: true },
      ctx({ sessionPermission: "restricted", approved: false }),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output) as {
      liveStatus: boolean;
      liveStatusAvailable: boolean | null;
      chains: Array<{ chainId: number; slug: string; state: string | null; stateReason: string | null; displayName: string | null }>;
    };
    expect(data.liveStatus).toBe(true);
    expect(data.liveStatusAvailable).toBe(true);
    // Provider-only chains never enter the result.
    expect(data.chains.map((c) => c.chainId)).not.toContain(534352);
    expect(data.chains.map((c) => c.chainId)).not.toContain(324);
    expect(data.chains.map((c) => c.chainId)).not.toContain(999999);

    const ethereum = data.chains.find((c) => c.chainId === 1);
    expect(ethereum?.state).toBe("active");
    expect(ethereum?.stateReason).toBeNull();
    expect(ethereum?.displayName).toBe("Ethereum");
    // The field the whole namespace needs survives the live path.
    expect(ethereum?.slug).toBeDefined();

    // A registry chain the live list did not carry keeps its row and says why
    // its state is unknown, rather than disappearing.
    const uncarried = data.chains.find((c) => c.chainId !== 1);
    expect(uncarried?.state).toBeNull();
    expect(uncarried?.stateReason).toContain("did not carry this chain");
  });

  // A status endpoint being down must not cost the caller the registry half,
  // which is the half the next kyberswap call depends on.
  it("kyberswap.chains still returns the registry when the Common Service fails, with a stated reason", async () => {
    mockGetSupportedChains.mockRejectedValueOnce(new Error("common service 503"));

    const result = await handlerFor("kyberswap.chains")(
      { liveStatus: true },
      ctx({ sessionPermission: "restricted", approved: false }),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output) as {
      liveStatus: boolean;
      liveStatusAvailable: boolean | null;
      chains: Array<{ slug: string; state: string | null; stateReason: string | null }>;
    };
    expect(data.liveStatus).toBe(true);
    expect(data.liveStatusAvailable).toBe(false);
    expect(data.chains).toHaveLength(18);
    for (const chain of data.chains) {
      expect(chain.slug).toBeDefined();
      expect(chain.state).toBeNull();
      expect(chain.stateReason).toContain("Common Service unavailable");
    }
  });
});
