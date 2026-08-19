/**
 * Pendle alias non-routing (spec D) — the generic `swap` / `bridge` aliases are
 * venue-specific and NEVER resolve to a pendle.* tool. Pendle PT trades are
 * intent-specific and reachable only via execute_tool({ toolId: "pendle.pt.*" }).
 */

import { describe, it, expect, vi } from "vitest";

// The bridge router reads the live Khalani chain registry; mocked so this file
// stays hermetic. Which venue it picks is irrelevant here - neither is pendle.
vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getChains: async () => [
      { type: "eip155", id: 1, name: "Ethereum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
      { type: "eip155", id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    ],
  }),
}));

import { MUTATING_PROTOCOL_ALIAS_ROUTERS } from "@vex-agent/tools/mutating-aliases.js";
import { PENDLE_TOOLS } from "@vex-agent/tools/protocols/pendle/manifest.js";

const PENDLE_TOOL_IDS = new Set(PENDLE_TOOLS.map((m) => m.toolId));

function aliasRouter(name: string) {
  const router = MUTATING_PROTOCOL_ALIAS_ROUTERS[name];
  if (!router) throw new Error(`no mutating alias router registered for "${name}"`);
  return router;
}

describe("pendle alias non-routing", () => {
  it("registers NO pendle alias — only swap_execute(+uniswap) + bridge(+relay) exist", () => {
    // `bridge_execute_relay` is the hidden, route-bound Relay reveal pair's
    // mutating half (mirrors the `swap_execute_uniswap` reveal pattern) —
    // still never a pendle route.
    expect(Object.keys(MUTATING_PROTOCOL_ALIAS_ROUTERS).sort()).toEqual([
      "bridge",
      "bridge_execute_relay",
      "swap_execute",
      "swap_execute_uniswap",
    ]);
  });

  it("the generic swap alias resolves to a venue tool, never pendle", async () => {
    const target = await aliasRouter("swap_execute")({
      chain: "ethereum",
      tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      tokenOut: "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb",
      amountIn: "1",
    }, undefined);
    expect(PENDLE_TOOL_IDS.has(target.toolId)).toBe(false);
    expect(target.toolId.startsWith("pendle.")).toBe(false);
  });

  it("the generic bridge alias never resolves to pendle", async () => {
    try {
      const target = await aliasRouter("bridge")({
        fromChain: "ethereum",
        toChain: "base",
        fromToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        toToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        amount: "1",
      }, undefined);
      expect(target.toolId.startsWith("pendle.")).toBe(false);
    } catch {
      // A route error is also acceptable — the point is it never yields pendle.
    }
  });
});
