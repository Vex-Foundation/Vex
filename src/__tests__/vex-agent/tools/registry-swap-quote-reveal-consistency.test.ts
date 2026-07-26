/**
 * FIX4-SPINE C42 (Codex final-review round 3, finding 4) — the ALWAYS-VISIBLE
 * `swap_quote` / `swap_execute` tool descriptions must never name the HIDDEN
 * Uniswap fallback pair pre-reveal. `swap_quote`'s description used to say
 * "...the failure output will say when the hidden swap_quote_uniswap
 * fallback becomes available" — naming the hidden tool directly defeats the
 * session-scoped reveal gate (an agent could just call it, no failure needed).
 *
 * This pins ONLY the `registry/action-aliases.ts` half of C42 (spine-owned).
 * The broader "iterate every serialized tool description + the complete
 * built prompt" test spans W7's navigation-entry files too (entries-market.ts
 * unconditionally routes Relay/Pendle guidance to Uniswap) and is not this
 * suite's job — see the FIX4-SPINE build-log delta for the seam.
 */

import { describe, it, expect } from "vitest";

import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";

const LEAK_TERMS = ["uniswap", "swap_quote_uniswap", "swap_execute_uniswap"];

function toolByName(name: string) {
  const tool = ACTION_ALIAS_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`registry-swap-quote-reveal-consistency: no tool named "${name}"`);
  return tool;
}

describe("swap_quote / swap_execute descriptions — pre-reveal consistency (FIX4-SPINE C42)", () => {
  it("swap_quote's description never names the hidden Uniswap pair or the word 'uniswap'", () => {
    const description = toolByName("swap_quote").description.toLowerCase();
    for (const term of LEAK_TERMS) {
      expect(description).not.toContain(term);
    }
  });

  it("swap_execute's description never names the hidden Uniswap pair or the word 'uniswap'", () => {
    const description = toolByName("swap_execute").description.toLowerCase();
    for (const term of LEAK_TERMS) {
      expect(description).not.toContain(term);
    }
  });

  it("swap_quote still describes the KyberSwap-failure backup path WITHOUT naming a tool", () => {
    const description = toolByName("swap_quote").description;
    expect(description).toMatch(/backup/i);
    expect(description.toLowerCase()).not.toMatch(/hidden/);
  });

  it("the hidden pair's OWN descriptions may reference each other and Uniswap — only reachable post-reveal", () => {
    // Sanity check that the fix targeted the right tools: the hidden pair's
    // descriptions are NOT required to be uniswap-silent (they are filtered
    // out of discover_tools pre-reveal by a separate gate, not by their text).
    const quoteUniswap = toolByName("swap_quote_uniswap");
    const executeUniswap = toolByName("swap_execute_uniswap");
    expect(quoteUniswap.visibility?.requiresUniswapReveal).toBe(true);
    expect(executeUniswap.visibility?.requiresUniswapReveal).toBe(true);
  });
});
