import { describe, expect, it } from "vitest";
import {
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/protocols.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";

describe("buildProtocolsPrompt", () => {
  it("advertises real active namespaces", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    expect(prompt).toContain("### khalani");
    expect(prompt).toContain("### kyberswap");
  });

  // Agent Scan plan v3 §11.2 (FIX3-W7, Codex final-review round 2 finding 2 /
  // C30): the hidden Uniswap fallback must not be statically advertised in
  // the BUILT system prompt for an unrevealed session — no per-namespace
  // section (that would come from a navigation entry's `advertised: true`),
  // and no imperative instruction telling the agent to proactively "fall
  // back" or "switch" to it. Only a specific KyberSwap route-not-found-class
  // failure output (checked at dispatch time, not documented here as a
  // manual trigger) may surface it — this static, always-rendered layer must
  // stay reveal-agnostic. The cross-venue safety sentence ("a uniswap quote
  // only authorizes a uniswap execute") is intentionally kept — it is a
  // conditional invariant for the rare revealed case, not an instruction to
  // go use the venue, so it does not violate the hidden-by-default posture.
  it("never advertises the hidden uniswap namespace section or instructs a fallback to it", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    expect(prompt).not.toContain("### uniswap");
    expect(prompt).not.toMatch(/fall back to `?uniswap/i);
    expect(prompt).not.toMatch(/switch to (the )?`?uniswap/i);
    // Positive control: the reveal-consistent replacement wording landed.
    expect(prompt).toContain("backup venue is now available");
  });

  // Owner add-on (2026-07-23): the kyberswap entry's chain list must be
  // DERIVED from the live registry, never hand-written, so a future chain
  // add/drop in `@tools/kyberswap/chains.ts` flows into the prompt
  // automatically. This test independently re-derives the SAME filter
  // (`aggregator: true`) the prompt-building code applies — a real
  // regression guard, not a tautology: if the navigation entry's filter
  // logic ever drifts (e.g. stops filtering, or filters on the wrong field),
  // the built prompt's actual chain list and this test's independently
  // recomputed expectation would diverge and the test would fail.
  it("kyberswap chain list is lockstepped to the live registry, never hand-written", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    const match = prompt.match(/Swap-supported EVM chains: ([^.]+)\./);
    expect(
      match,
      `expected a "Swap-supported EVM chains" sentence in the built prompt; got:\n${prompt}`,
    ).not.toBeNull();
    const promptedSlugs = match![1]!.split(", ").map((s) => s.trim());
    const registrySlugs = getKyberChains()
      .filter((chain) => chain.aggregator)
      .map((chain) => chain.slug);
    expect(promptedSlugs).toEqual(registrySlugs);
    // Never mentions the hidden Uniswap fallback (C30) — a chain-list line
    // is exactly the kind of place a future edit might accidentally add it.
    expect(prompt.match(/Swap-supported EVM chains: [^.]+\./)![0]).not.toContain("uniswap");
  });
});
