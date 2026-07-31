/**
 * Basis-point params must be WHOLE and NON-NEGATIVE at the manifest boundary.
 *
 * MEASURED DEFECT this pins (not inferred): Jupiter ACCEPTS a non-integer
 * `slippageBps` and answers with `otherAmountThreshold = 0` — a swap that will
 * take ANY output, including near-zero. Reproduced live at `50.5`, `50.9`, and
 * most dangerously `0.5`: a caller meaning "0.5%" got TOTAL-LOSS tolerance
 * instead of tight protection, silently, behind a normal-looking quote.
 *
 * Two layers were open: `z.number()` in `runtime/params.ts` (no `.int()`), and
 * `assertNumberInRange` in the Jupiter SDK (no integrality test). This file
 * covers the OUTER layer — the manifest boundary, which is the first code in
 * the process to see a model-supplied param. The inner Jupiter layer is covered
 * by `src/__tests__/solana/jupiter-swap-bps-integrality.test.ts`.
 *
 * The synthetic-manifest harness mirrors `../../runtime-type-validation.test.ts`
 * so the REAL `executeProtocolTool` is exercised, not a reimplementation.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import type {
  ProtocolHandler,
  ProtocolToolManifest,
} from "@vex-agent/tools/protocols/types.js";

vi.mock("@vex-agent/tools/protocols/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("@vex-agent/tools/protocols/catalog.js")>(
    "@vex-agent/tools/protocols/catalog.js",
  );
  return {
    ...actual,
    getProtocolManifest: (toolId: string) =>
      TEST_MANIFESTS.get(toolId) ?? actual.getProtocolManifest(toolId),
    getProtocolHandler: (toolId: string) =>
      TEST_HANDLERS.get(toolId) ?? actual.getProtocolHandler(toolId),
  };
});

const TEST_MANIFESTS = new Map<string, ProtocolToolManifest>();
const TEST_HANDLERS = new Map<string, ProtocolHandler>();

/** Every bps value the handler actually observed — the "did it get through?" oracle. */
let observedSlippage: unknown[] = [];

const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
const { PROTOCOL_TOOLS } = await import("@vex-agent/tools/protocols/catalog.js");

const TOOL_ID = "test.bps.quote";

beforeAll(() => {
  TEST_MANIFESTS.set(TOOL_ID, {
    toolId: TOOL_ID,
    namespace: "dexscreener", // executable, non-reveal-gated, no requiresEnv
    lifecycle: "active",
    description: "Synthetic tool for basis-point boundary tests",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in bps." },
      { key: "amount", type: "number", required: true, description: "Human-readable amount — legitimately fractional." },
    ],
    exampleParams: {},
  });
  TEST_HANDLERS.set(TOOL_ID, async (params) => {
    observedSlippage.push(params.slippageBps);
    return { success: true, output: "ok" };
  });
});

afterAll(() => {
  TEST_MANIFESTS.clear();
  TEST_HANDLERS.clear();
});

async function callWithSlippage(slippageBps: unknown) {
  observedSlippage = [];
  return executeProtocolTool(
    { toolId: TOOL_ID, params: { amount: 1.5, slippageBps } },
    { sessionPermission: "full", approved: true },
  );
}

describe("basis-point params are rejected when fractional", () => {
  // The three values reproduced live against Jupiter.
  for (const value of [0.5, 50.5, 50.9]) {
    it(`rejects ${value} and never lets it reach the handler`, async () => {
      const result = await callWithSlippage(value);

      expect(result.success).toBe(false);
      expect(result.output).toContain('"slippageBps"');
      expect(result.output).toMatch(/whole number of basis points/i);
      // The offending value is echoed so the agent can self-correct.
      expect(result.output).toContain(String(value));
      // Load-bearing: nothing downstream ever saw the value.
      expect(observedSlippage).toEqual([]);
    });
  }

  it("names the correct form for the percentage the caller most likely meant", async () => {
    // The dangerous case: "0.5" meaning 0.5%. 0.5% is 50 bps, and passing 0.5
    // as bps is what produced otherAmountThreshold = 0.
    const result = await callWithSlippage(0.5);
    expect(result.output).toContain("If you meant 0.5%, pass 50.");
  });

  it("never coerces — no rounding, flooring, or clamping to a neighbouring integer", async () => {
    // 50.9 must NOT become 50 or 51. Ambiguity on a price-protection param is
    // resolved by rejecting, never by guessing.
    const result = await callWithSlippage(50.9);
    expect(result.success).toBe(false);
    expect(observedSlippage).toEqual([]);
  });
});

describe("basis-point params are rejected when negative", () => {
  it("rejects -1 instead of silently substituting the 50 bps default", async () => {
    const result = await callWithSlippage(-1);

    expect(result.success).toBe(false);
    expect(result.output).toContain('"slippageBps"');
    expect(result.output).toMatch(/must not be negative/i);
    // The regression that matters: the old Pendle path answered -1 with 50.
    expect(observedSlippage).toEqual([]);
  });

  it("rejects a negative fractional value too", async () => {
    const result = await callWithSlippage(-0.5);
    expect(result.success).toBe(false);
    expect(observedSlippage).toEqual([]);
  });
});

describe("valid basis-point values are unchanged", () => {
  // Guards against the fix over-rejecting: the whole currently-accepted range
  // must still pass, untouched.
  for (const value of [0, 1, 50, 100, 250, 5000, 9999, 10_000]) {
    it(`accepts ${value} and forwards it verbatim`, async () => {
      const result = await callWithSlippage(value);
      expect(result.success).toBe(true);
      expect(observedSlippage).toEqual([value]);
    });
  }

  it("an omitted bps param is still optional", async () => {
    observedSlippage = [];
    const result = await executeProtocolTool(
      { toolId: TOOL_ID, params: { amount: 1.5 } },
      { sessionPermission: "full", approved: true },
    );
    expect(result.success).toBe(true);
    expect(observedSlippage).toEqual([undefined]);
  });

  it("a NON-bps numeric param stays legitimately fractional", async () => {
    // `amount: 1.5` above is human-readable units — the integrality rule must
    // apply ONLY to params declaring `unit: "bps"`, never to numbers at large.
    const result = await callWithSlippage(50);
    expect(result.success).toBe(true);
  });
});

// ── Reachability: the REAL tool path, not a synthetic stand-in ───────────
//
// The open question this answers: was a model-supplied fractional bps actually
// reachable end-to-end, or only latent? It was REACHABLE. Before the fix the
// chain was, with no integrality check at any link:
//   execute_tool → validateProtocolParams (z.number() accepts 0.5)
//     → solana.swap.quote handler
//     → resolveJupiterFeeSwapKnobs (typeof === "number" only)
//     → prepareFeeBearingJupiterSwap → jupiterSwapBuild
//     → normalizeBuildQueryParams → assertNumberInRange(0, 10_000) — passed
//     → `slippageBps=0.5` on the wire to Jupiter.
// This test drives the REAL registered manifest and asserts the rejection now
// happens at the first link, before the handler and before any provider call.
describe("reachability regression — real solana.swap manifests", () => {
  const previousApiKey = process.env.JUPITER_API_KEY;

  beforeAll(() => {
    // `requiresEnv` is gated BEFORE param validation; without a key the call
    // would fail for the wrong reason and the test would prove nothing.
    process.env.JUPITER_API_KEY = "test-key-not-used-no-request-is-made";
  });

  afterAll(() => {
    if (previousApiKey === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = previousApiKey;
  });

  for (const toolId of ["solana.swap.quote", "solana.swap.execute"]) {
    it(`${toolId} rejects a model-supplied 50.5 before the handler runs`, async () => {
      const result = await executeProtocolTool(
        {
          toolId,
          params: { inputToken: "SOL", outputToken: "USDC", amount: 1, slippageBps: 50.5 },
        },
        { sessionPermission: "full", approved: true },
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain('"slippageBps"');
      expect(result.output).toMatch(/whole number of basis points/i);
    });
  }

  it("solana.swap.quote rejects the total-loss 0.5 case", async () => {
    const result = await executeProtocolTool(
      {
        toolId: "solana.swap.quote",
        params: { inputToken: "SOL", outputToken: "USDC", amount: 1, slippageBps: 0.5 },
      },
      { sessionPermission: "full", approved: true },
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/whole number of basis points/i);
  });
});

// ── Manifest census ─────────────────────────────────────────────────────
describe("manifest bps declarations", () => {
  it("every NUMERIC param whose key ends in Bps declares unit:\"bps\"", () => {
    // No per-tool waivers on purpose: the point of the declaration is that a
    // new venue cannot quietly reopen this hole, so any numeric bps param
    // without the unit must fail here and force a deliberate decision.
    const undeclared = PROTOCOL_TOOLS.flatMap((m) =>
      m.params
        .filter((p) => p.key.endsWith("Bps") && p.type === "number" && p.unit !== "bps")
        .map((p) => `${m.toolId}.${p.key}`),
    );

    expect(undeclared).toEqual([]);
  });

  it("covers every venue that takes a numeric bps param", () => {
    // Pins the breadth of the fix. If a venue is added or dropped this fails,
    // which is the prompt to decide whether the new one needs the declaration.
    const declared = PROTOCOL_TOOLS.flatMap((m) =>
      m.params.filter((p) => p.unit === "bps").map((p) => `${m.toolId}.${p.key}`),
    );

    // 20 + the five R5d slippageBps declarations that reject rather than clamp
    // like the rest: the Pendle SY wrap/unwrap pair (card D3), the dual-LP pair
    // (E3) and the three term-mobility moves (E4) — registered by card E5 — plus
    // the two Trench Express curve slippageBps params (trade_quote + execute),
    // which reject above the 1000 bps cap rather than clamping like the rest.
    expect(declared.length).toBe(29);
    expect(new Set(declared.map((id) => id.split(".")[0]))).toEqual(
      new Set(["solana", "kyberswap", "uniswap", "pendle", "trench"]),
    );
  });

  it("Relay's slippageBps is STRING-typed and therefore NOT covered here", () => {
    // Documented, not fixed: relay declares slippage as a string, forwards any
    // non-empty value unvalidated, and does not bind it into the bridge
    // prequote identity at all. Three gaps on one param, owned by a separate
    // card. Pinned so the gap is visible rather than silently assumed closed.
    const relayBps = PROTOCOL_TOOLS.flatMap((m) =>
      m.params
        .filter((p) => m.namespace === "relay" && p.key.endsWith("Bps"))
        .map((p) => p.type),
    );

    expect(relayBps.length).toBeGreaterThan(0);
    expect(new Set(relayBps)).toEqual(new Set(["string"]));
  });

  it("unit:\"bps\" is only declared on numeric params", () => {
    // `unit` is meaningless on a non-number; the runtime guard skips it, so a
    // mis-declared manifest would silently lose its protection.
    const misdeclared = PROTOCOL_TOOLS.flatMap((m) =>
      m.params
        .filter((p) => p.unit === "bps" && p.type !== "number")
        .map((p) => `${m.toolId}.${p.key} (${p.type})`),
    );

    expect(misdeclared).toEqual([]);
  });
});
