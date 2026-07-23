/**
 * Session-scoped bounded reveal for the hidden `swap_quote_uniswap` /
 * `swap_execute_uniswap` pair (plan §11.2, Blocker B) — hardened by Codex
 * spine-review round 1 finding 11 ("reveal tests exercise helpers, not
 * security boundaries") + finding 8/C3, bound in
 * `agents_dm/agent-scan-factory.md` "Coordinator addendum 1".
 *
 * FIX-W0 delta (finding 11): the ORIGINAL suite only ever called
 * `isUniswapPairRevealed`/`assertUniswapPairRevealed`/`revealUniswapPair`/
 * `clearUniswapPairReveal` directly — real production functions, but not the
 * REAL boundaries a model or a compromised caller actually goes through.
 * This revision ADDS (kept alongside the original helper-level tests as a
 * documented supplement, not the proof):
 *   - visibility PROJECTION: `registry/visibility.ts`'s real
 *     `getVisibleToolDefs` — proves the hidden pair is absent/present in the
 *     actual LLM-facing tool list, not just that a boolean flag flipped;
 *   - dispatch rejection through the REAL dispatcher route: `dispatchTool`
 *     (`tools/dispatcher.ts` → `protocol-route.ts#routeToolCall`) for BOTH
 *     the internal alias (`swap_quote_uniswap`) and the mutating alias
 *     (`swap_execute_uniswap`), plus a positive proof that a revealed session
 *     passes the gate (reaches Zod param validation instead of the reveal
 *     rejection);
 *   - the canonical `executeProtocolTool` gate for `uniswap.swap.quote`
 *     (C3 — finding 8's blocker: `execute_tool` forwards canonical dotted
 *     toolIds straight to `executeProtocolTool`, bypassing the alias-level
 *     checks entirely). FIX-SPINE is adding this gate IN PARALLEL with this
 *     revision, so the two tests in that describe block are EXPECTED TO BE
 *     RED until FIX-SPINE's C3 change lands — that is the intended contract-
 *     first shape of this parallel fix round, not a W0 authoring error;
 *   - clear-on-success re-verified through the visibility PROJECTION (not
 *     just the boolean helper) — see that test's own comment for the named
 *     gap this does NOT yet cover (no production call site exists for
 *     `clearUniswapPairReveal` until W2b's real uniswap.swap.execute handler
 *     lands; this is flagged in the FIX-W0 build-log delta for the
 *     coordinator to verify once W2b lands).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ToolCallRequest } from "@vex-agent/tools/types.js";
import { makeTestContext } from "../tools/_test-context.js";

// The real-boundary tests dynamically import the full dispatcher module graph
// (registry + internal loaders) — first-import cost far exceeds the 10s default.
vi.setConfig({ testTimeout: 120_000 });

const revealedSessionsToClear: string[] = [];
afterEach(async () => {
  if (revealedSessionsToClear.length === 0) return;
  const { clearUniswapPairReveal } = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
  for (const sessionId of revealedSessionsToClear.splice(0, revealedSessionsToClear.length)) {
    clearUniswapPairReveal(sessionId);
  }
});

// ── Helper-level supplement (kept — NOT the proof; see the boundary tests below) ──

describe("uniswap-reveal.js helpers (supplement)", () => {
  it("hidden before any reveal: not visible, dispatch rejected", async () => {
    const registry = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    expect(registry.isUniswapPairRevealed("session-A")).toBe(false);
    expect(() => registry.assertUniswapPairRevealed("session-A")).toThrow();
  });

  it("revealed after an eligible Kyber failure: visible + dispatch allowed", async () => {
    const registry = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    registry.revealUniswapPair("session-A");
    revealedSessionsToClear.push("session-A");
    expect(registry.isUniswapPairRevealed("session-A")).toBe(true);
    expect(() => registry.assertUniswapPairRevealed("session-A")).not.toThrow();
  });

  it("expires no later than PREQUOTE_MAX_AGE_MS — a stale reveal is treated as unrevealed", async () => {
    const registry = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    const { PREQUOTE_MAX_AGE_MS } = await import("../../../vex-agent/tools/protocols/prequote/registry.js");

    vi.useFakeTimers();
    try {
      registry.revealUniswapPair("session-C");
      expect(registry.isUniswapPairRevealed("session-C")).toBe(true);
      vi.advanceTimersByTime(PREQUOTE_MAX_AGE_MS + 1);
      expect(registry.isUniswapPairRevealed("session-C")).toBe(false);
      expect(() => registry.assertUniswapPairRevealed("session-C")).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cross-session isolation: revealing session A never reveals session B", async () => {
    const registry = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    registry.revealUniswapPair("session-D");
    revealedSessionsToClear.push("session-D");
    expect(registry.isUniswapPairRevealed("session-D")).toBe(true);
    expect(registry.isUniswapPairRevealed("session-E")).toBe(false);
  });

  it("an absent/undefined sessionId fails closed to hidden (never revealed by default)", async () => {
    const registry = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    expect(registry.isUniswapPairRevealed(undefined)).toBe(false);
  });
});

// ── REAL BOUNDARY 1: visibility projection (registry/visibility.ts) ──────────

describe("visibility projection — the real LLM-facing tool list", () => {
  it("the hidden pair is ABSENT from getVisibleToolDefs before any reveal", async () => {
    const { getVisibleToolDefs, defaultVisibilityContext } = await import(
      "../../../vex-agent/tools/registry/visibility.js"
    );
    const names = getVisibleToolDefs(defaultVisibilityContext({ sessionId: "session-vis-hidden" })).map((t) => t.name);
    expect(names).not.toContain("swap_quote_uniswap");
    expect(names).not.toContain("swap_execute_uniswap");
  });

  it("the hidden pair is PRESENT in getVisibleToolDefs after an eligible reveal", async () => {
    const { revealUniswapPair } = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    const { getVisibleToolDefs, defaultVisibilityContext } = await import(
      "../../../vex-agent/tools/registry/visibility.js"
    );
    revealUniswapPair("session-vis-revealed");
    revealedSessionsToClear.push("session-vis-revealed");
    const names = getVisibleToolDefs(defaultVisibilityContext({ sessionId: "session-vis-revealed" })).map((t) => t.name);
    expect(names).toContain("swap_quote_uniswap");
    expect(names).toContain("swap_execute_uniswap");
  });
});

// ── REAL BOUNDARY 2: dispatch rejection through the dispatcher route ─────────

const SWAP_ARGS = { chain: "base", tokenIn: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", tokenOut: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", amountIn: "1" };

describe("dispatch-side rejection through the REAL dispatcher (tools/dispatcher.ts)", () => {
  it("swap_quote_uniswap (internal alias): unrevealed session is rejected by the FULL dispatcher path", async () => {
    const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");
    const call: ToolCallRequest = { name: "swap_quote_uniswap", args: SWAP_ARGS };
    const result = await dispatchTool(call, makeTestContext({ sessionId: "session-dispatch-quote-hidden" }));
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not available|reveal/i);
  });

  it("swap_execute_uniswap (mutating alias): unrevealed session is rejected by the FULL dispatcher path", async () => {
    const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");
    const call: ToolCallRequest = { name: "swap_execute_uniswap", args: SWAP_ARGS };
    const result = await dispatchTool(
      call,
      makeTestContext({ sessionId: "session-dispatch-execute-hidden", sessionPermission: "full", approved: true }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not available|reveal/i);
  });

  it("swap_execute_uniswap: a REVEALED session passes the reveal gate (fails on param validation instead)", async () => {
    const { revealUniswapPair } = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");
    const sessionId = "session-dispatch-execute-revealed";
    revealUniswapPair(sessionId);
    revealedSessionsToClear.push(sessionId);

    // Deliberately missing `tokenOut` — if the reveal gate was passed, this
    // fails Zod validation with a DIFFERENT message than the reveal rejection.
    const call: ToolCallRequest = {
      name: "swap_execute_uniswap",
      args: { chain: "base", tokenIn: SWAP_ARGS.tokenIn, amountIn: "1" },
    };
    const result = await dispatchTool(call, makeTestContext({ sessionId, sessionPermission: "full", approved: true }));
    expect(result.success).toBe(false);
    expect(result.output).not.toMatch(/not available yet/i);
    expect(result.output).toMatch(/tokenOut/i);
  });
});

// ── REAL BOUNDARY 3: canonical executeProtocolTool gate (C3 — FIX-SPINE parallel) ──
//
// finding 8 / C3: `execute_tool` forwards arbitrary canonical dotted toolIds
// DIRECTLY to `executeProtocolTool`, bypassing the alias-level reveal checks
// entirely. C3 requires `executeProtocolTool` itself to reject
// `uniswap.swap.quote`/`uniswap.swap.execute` for an unrevealed session. This
// is a FIX-SPINE change landing IN PARALLEL with this revision — these two
// tests are the CONTRACT and are expected to be RED until that lands.
//
// The catalog is mocked (manifest + handler spy) so this proves the GATE,
// not real Uniswap network/RPC behavior — `importActual` keeps everything
// else in the catalog module real.

const uniswapQuoteHandler = vi.fn().mockResolvedValue({ success: true, output: "quoted" });
const mockGetProtocolManifest = vi.fn();
const mockGetProtocolHandler = vi.fn();
vi.mock("@vex-agent/tools/protocols/catalog.js", async (importActual) => {
  const actual = await importActual<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return {
    ...actual,
    getProtocolManifest: (...a: Parameters<typeof actual.getProtocolManifest>) => mockGetProtocolManifest(...a),
    getProtocolHandler: (...a: Parameters<typeof actual.getProtocolHandler>) => mockGetProtocolHandler(...a),
  };
});

const FAKE_UNISWAP_QUOTE_MANIFEST = {
  toolId: "uniswap.swap.quote",
  namespace: "uniswap" as const,
  lifecycle: "active" as const,
  description: "fake uniswap quote manifest for the C3 gate test",
  mutating: false,
  actionKind: "read" as const,
  params: [],
  exampleParams: {},
};

describe("canonical executeProtocolTool gate for the hidden Uniswap pair (C3)", () => {
  it("rejects an unrevealed session's canonical uniswap.swap.quote BEFORE the handler ever runs", async () => {
    mockGetProtocolManifest.mockReturnValue(FAKE_UNISWAP_QUOTE_MANIFEST);
    mockGetProtocolHandler.mockReturnValue(uniswapQuoteHandler);
    uniswapQuoteHandler.mockClear();

    const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool(
      { toolId: "uniswap.swap.quote", params: {} },
      {
        sessionPermission: "full", approved: true, sessionId: "session-canonical-unrevealed",
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
      },
    );
    expect(result.success).toBe(false);
    expect(uniswapQuoteHandler).not.toHaveBeenCalled();
  });

  it("allows a REVEALED session's canonical uniswap.swap.quote through to the handler", async () => {
    mockGetProtocolManifest.mockReturnValue(FAKE_UNISWAP_QUOTE_MANIFEST);
    mockGetProtocolHandler.mockReturnValue(uniswapQuoteHandler);
    uniswapQuoteHandler.mockClear();

    const { revealUniswapPair } = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    const sessionId = "session-canonical-revealed";
    revealUniswapPair(sessionId);
    revealedSessionsToClear.push(sessionId);

    const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");
    const result = await executeProtocolTool(
      { toolId: "uniswap.swap.quote", params: {} },
      {
        sessionPermission: "full", approved: true, sessionId,
        walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
      },
    );
    expect(uniswapQuoteHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

// ── Clear-on-success re-verified through the visibility projection ───────────

describe("clear-on-success — reveal is removed from the real tool list, not just the boolean", () => {
  it("clearUniswapPairReveal removes the pair from getVisibleToolDefs (not just isUniswapPairRevealed)", async () => {
    // NAMED GAP (documented for the coordinator, not fixed by this suite):
    // there is currently NO production call site for `clearUniswapPairReveal`
    // — it will be wired into a real uniswap.swap.execute SUCCESS path once
    // W2b lands that handler. This test proves the REGISTRY + VISIBILITY
    // seam responds correctly to the call; it cannot yet prove a real
    // successful broadcast triggers it, because that handler does not exist.
    const registry = await import("../../../vex-agent/tools/registry/uniswap-reveal.js");
    const { getVisibleToolDefs, defaultVisibilityContext } = await import(
      "../../../vex-agent/tools/registry/visibility.js"
    );
    const sessionId = "session-clear-on-success";
    registry.revealUniswapPair(sessionId);
    expect(getVisibleToolDefs(defaultVisibilityContext({ sessionId })).map((t) => t.name)).toContain(
      "swap_execute_uniswap",
    );

    registry.clearUniswapPairReveal(sessionId);

    expect(registry.isUniswapPairRevealed(sessionId)).toBe(false);
    const namesAfterClear = getVisibleToolDefs(defaultVisibilityContext({ sessionId })).map((t) => t.name);
    expect(namesAfterClear).not.toContain("swap_quote_uniswap");
    expect(namesAfterClear).not.toContain("swap_execute_uniswap");
  });
});
