/**
 * VENUE-TOOL SURFACE CONSISTENCY (was FIX4-SPINE C42, INVERTED by owner
 * decision D4).
 *
 * This suite used to enforce the opposite invariant: `SwapQuote` /
 * `SwapExecute` were always visible while the Uniswap pair was HIDDEN behind a
 * session reveal, so the routers' descriptions could not name the pair — an
 * agent that read the name could simply call it, no failure needed, which
 * defeated the gate.
 *
 * D4 retired the gate. Hiding a venue is what cost the agent its fallback at
 * exactly the moment the primary venue failed, and authorization was never the
 * hiding: the prequote gate and the approval gate are. So the invariant flips —
 * the routers SHOULD name the alternative, and the venue tools must carry no
 * visibility gate at all. Kept rather than deleted because a silent regression
 * to a hidden venue is precisely what this file is positioned to catch.
 */

import { describe, it, expect } from "vitest";

import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";

const VENUE_TOOLS = [
  "SwapQuoteUniswap",
  "SwapExecuteUniswap",
  "BridgeQuoteRelay",
  "BridgeExecuteRelay",
] as const;

function toolByName(name: string) {
  const tool = ACTION_ALIAS_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`registry venue-tool surface: no tool named "${name}"`);
  return tool;
}

describe("venue tools are always visible (owner decision D4)", () => {
  it("carries NO visibility gate on any of the four venue tools", () => {
    for (const name of VENUE_TOOLS) {
      const tool = toolByName(name);
      // `undefined` or an object with no gate key are both acceptable; what
      // must never come back is a reveal-shaped gate.
      const gates = Object.keys(tool.visibility ?? {});
      expect(gates, `${name} declares visibility gates: ${gates.join(", ")}`).toEqual([]);
    }
  });

  it("the primary routers NAME the alternative venue instead of hiding it", () => {
    expect(toolByName("SwapQuote").description).toContain("SwapQuoteUniswap");
    expect(toolByName("SwapQuote").description).toMatch(/primary swap venue/i);
  });

  it("no venue tool description claims it must be unlocked", () => {
    for (const name of VENUE_TOOLS) {
      const description = toolByName(name).description;
      expect(description, `${name} still claims a reveal`).not.toMatch(
        /only usable after|not available yet|revealed it for this session|unlocks it/i,
      );
    }
  });

  it("the venue tools still state the preference, so visibility is not the only signal", () => {
    // The preference has to live SOMEWHERE now that hiding no longer expresses
    // it. Each venue tool says which route is primary.
    expect(toolByName("SwapQuoteUniswap").description).toMatch(/KyberSwap is the primary swap route/i);
    expect(toolByName("BridgeQuoteRelay").description).toMatch(/Khalani is the primary bridge route/i);
  });
});
