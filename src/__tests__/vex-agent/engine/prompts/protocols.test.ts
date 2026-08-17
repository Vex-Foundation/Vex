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

  // The routing line describes the failure CLASS rather than enumerating
  // codes, because the enumeration went stale twice - most recently when a
  // geo-blocked user's 403 matched nothing it listed.
  it("names the availability class and the conditions that are NOT triggers", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    expect(prompt).toContain("KyberSwap being unavailable to us at all");
    expect(prompt).toContain("neither is a slippage, balance, allowance, or deadline failure");
  });

  it("the routing line carries no em dash (owner decree 2026-08-05)", () => {
    resetProtocolsPromptCache();
    const routingLine = buildProtocolsPrompt()
      .split("\n")
      .find((line) => line.includes("backup venue is now available"));
    expect(routingLine).toBeDefined();
    expect(routingLine).not.toContain("—");
  });

  it("tells the model that Lighter previews prepare approval rather than execute", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    const section = prompt.split("## Lighter Order Preview Routing")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("live-data-backed read-only preview");
    expect(section).toContain("never places, submits, executes, or broadcasts");
    expect(section).toContain("Do not call it a simulation");
    expect(section).toContain("Inspect `approvalReady`");
    expect(section).toContain("Prepare trade approval button");
    expect(section).toContain("Do not print internal tool names");
    expect(section).toContain("finish the managed Lighter setup");
    expect(section).toContain("never ask the user to paste a trading key");
    expect(section).not.toContain("Settings/API keys");
    expect(section).toContain("Do not say a preview can be broadcast after only supplying an API-key index");
    expect(section).toContain("render `previewSummary.rows` as a Markdown table");
    expect(section).toContain("Parameter | Value | Notes");
    expect(section).toContain("Do not render raw preview internals");
    expect(section).toContain("Do not ask the user to confirm");
    expect(section).toContain("never emit raw HTML");
  });

  it("routes plain-language Lighter setup without exposing internal identifiers", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    const section = prompt.split("## Lighter Onboarding Routing")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain('"set up my Lighter account"');
    expect(section).toContain('"I want to trade perps on Lighter"');
    expect(section).toContain("How much USDC do you want to deposit?");
    expect(section).toContain("Vex resolves them internally");
    expect(section).toContain("activates the local integration automatically");
    expect(section).toContain("Never ask a normal user to visit the Lighter dashboard");
    expect(section).toContain("separate approval-gated actions");
    expect(section).toContain("ready to trade only after onboarding status proves");
    expect(section).not.toContain("ask the user for their account index");
    expect(section).not.toContain("Ask the user to paste an API key");
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
