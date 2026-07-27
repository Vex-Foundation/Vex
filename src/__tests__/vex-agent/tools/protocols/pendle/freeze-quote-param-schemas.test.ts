/**
 * FREEZE LIST — the four Pendle QUOTE tools keep exactly today's input schemas
 * (Pendle tranche 1, plan §3).
 *
 * A quote input is not cosmetic: it is hashed into the persisted `swap_prequotes`
 * authorization record that arms the matching broadcast tool
 * (`protocols/prequote/identity/hash.ts`). Adding, removing or renaming a param
 * changes what a quote authorizes, so it is a money-path change that belongs in
 * T2 with the prequote work — not a side effect of the read-side tranche.
 *
 * `pendle-manifest.test.ts` asserts the REQUIRED params with `arrayContaining`,
 * which cannot see an ADDED param. This file locks the exact sorted key set, so
 * any accidental schema drift fails loudly.
 *
 * Key sets captured from the tree at 34592cc4 (2026-07-27).
 */

import { describe, expect, it } from "vitest";
import { PENDLE_TOOLS } from "@vex-agent/tools/protocols/pendle/manifest.js";

/** toolId → the EXACT sorted param key set frozen for T1. */
const FROZEN_QUOTE_PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  "pendle.pt.quote": ["amountIn", "chain", "slippageBps", "tokenIn", "tokenOut"],
  "pendle.yt.quote": ["amountIn", "chain", "slippageBps", "tokenIn", "tokenOut"],
  "pendle.py.quote": ["amountIn", "chain", "direction", "pt", "slippageBps", "tokenIn", "tokenOut"],
  "pendle.lp.quote": ["amountIn", "chain", "direction", "market", "slippageBps", "tokenIn", "tokenOut"],
};

function quoteTool(toolId: string) {
  const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId);
  if (tool === undefined) throw new Error(`${toolId} is missing from PENDLE_TOOLS`);
  return tool;
}

describe("FREEZE: Pendle quote-tool input schemas", () => {
  for (const [toolId, frozenKeys] of Object.entries(FROZEN_QUOTE_PARAM_KEYS)) {
    it(`${toolId} exposes exactly ${frozenKeys.join(", ")}`, () => {
      const keys = quoteTool(toolId).params.map((p) => p.key).sort();
      expect(keys).toEqual([...frozenKeys]);
    });
  }

  it("no quote tool carries a `market` param (deferred to T2 with the prequote contract)", () => {
    for (const toolId of ["pendle.pt.quote", "pendle.yt.quote", "pendle.py.quote"]) {
      expect(quoteTool(toolId).params.some((p) => p.key === "market")).toBe(false);
    }
  });

  it("no quote tool carries dryRun — a quote never broadcasts", () => {
    for (const toolId of Object.keys(FROZEN_QUOTE_PARAM_KEYS)) {
      expect(quoteTool(toolId).params.some((p) => p.key === "dryRun")).toBe(false);
    }
  });

  it("every frozen key is declared with the same required-ness as today", () => {
    const FROZEN_REQUIRED: Readonly<Record<string, readonly string[]>> = {
      "pendle.pt.quote": ["amountIn", "chain", "tokenIn", "tokenOut"],
      "pendle.yt.quote": ["amountIn", "chain", "tokenIn", "tokenOut"],
      "pendle.py.quote": ["amountIn", "chain", "direction", "pt"],
      "pendle.lp.quote": ["amountIn", "chain", "direction", "market"],
    };
    for (const [toolId, required] of Object.entries(FROZEN_REQUIRED)) {
      const actual = quoteTool(toolId).params.filter((p) => p.required === true).map((p) => p.key).sort();
      expect(actual).toEqual([...required]);
    }
  });
});
