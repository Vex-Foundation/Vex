import { describe, expect, it } from "vitest";
import {
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/protocols.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";
import { getProtocolNamespaceCoverage } from "@vex-agent/engine/prompts/chain-coverage.js";
import { buildPromptStack } from "@vex-agent/engine/prompts/index.js";
import { makeContext } from "./_prompt-stack-helpers.js";

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
  // INVERTED by owner decision D4: uniswap is an advertised namespace now, and
  // the prompt states the PREFERENCE rather than hiding the alternative.
  it("advertises the uniswap namespace and states the venue preference", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    expect(prompt).toContain("### uniswap");
    // Wave 2 migration rows T531-T534.
    expect(prompt).toContain("KyberSwap is the primary EVM swap venue");
    // The preference must never be phrased as a lock.
    expect(prompt).not.toContain("backup venue is now available");
    expect(prompt).not.toMatch(/unlocks? it/i);
  });

  // The routing line describes the failure CLASS rather than enumerating
  // codes, because the enumeration went stale twice - most recently when a
  // geo-blocked user's 403 matched nothing it listed.
  it("names the availability class and the conditions that are NOT reasons to switch", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    // Wave 2 migration rows T535 and T536.
    expect(prompt).toContain("or is unavailable");
    expect(prompt).toContain("Do not switch for a bad price alone or for slippage, balance, allowance, or deadline failures");
  });

  it("the venue-routing lines carry no em dash (owner decree 2026-08-05)", () => {
    resetProtocolsPromptCache();
    // Re-anchored: the single "backup venue" line the decree originally
    // policed was replaced by three preference lines (owner decision D4), so
    // the anchor is now the doctrine they all state.
    // Wave 2 migration row T843. Ledger-mandated verbatim sentences keep
    // their original punctuation; newly authored routing prose does not.
    const routingLines = buildProtocolsPrompt()
      .split("\n")
      .filter((line) => line.startsWith("Default procedure: Resolve the exact token"));
    expect(routingLines.length).toBeGreaterThan(0);
    for (const line of routingLines) expect(line).not.toContain("—");
  });

  it("tells the model that Lighter previews prepare approval rather than execute", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    const section = prompt.split("### lighter")[1]?.split("\n### ")[0] ?? "";
    expect(section).toContain("Preview exact Lighter orders from live market and account data before any approval");
    expect(section).toContain("approval-gated deposits, orders, withdrawals, and claims");
    expect(section).toContain("previews are read-only");
    expect(section).toContain("every fund-moving or exchange-state-changing action remains approval-gated");
    expect(section).toContain("normal users never paste trading keys");
    expect(section).not.toContain("Settings/API keys");
  });

  it("routes plain-language Lighter setup without exposing internal identifiers", () => {
    resetProtocolsPromptCache();
    const prompt = buildProtocolsPrompt();
    const section = prompt.split("### lighter")[1]?.split("\n### ")[0] ?? "";
    expect(section).toContain("set up Lighter");
    expect(section).toContain("trade perps on Lighter");
    expect(section).toContain("managed wallet-funded onboarding");
    expect(section).toContain("account/API-key indexes are resolved internally");
    expect(section).toContain("environment-specific settlement assets");
    expect(section).toContain("Ethereum USDC for Core");
    expect(section).toContain("Robinhood Chain USDG for RHC");
    expect(section).not.toContain("ask the user for their account index");
    expect(section).not.toContain("Ask the user to paste an API key");
  });

  // pools.fun doctrine (P4). The integration shipped every layer except the
  // system-prompt doctrine, so a cold model could see the namespace on the map
  // and still not know that these tokens trade on `kyberswap`, that the preview
  // cannot name an address, or who earns the fee stream. Each assertion below
  // pins ONE measured or owner-decided fact, at the granularity the Trench and
  // Morpho assertions elsewhere in this suite use.
  describe("pools.fun doctrine", () => {
    it("routes trading to kyberswap and states the namespace has no trade tool", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T538-T540.
      expect(prompt).toContain("### pools");
      expect(prompt).toContain("This namespace has no trading quote");
      expect(prompt).toContain("13 of 13 sampled tokens");
    });

    it("contrasts the no-curve pools token against the Trench curve exception", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T541-T544.
      expect(prompt).toContain("pools.fun has no curve");
      expect(prompt).toContain("Trench token still on its curve trades only against ETH");
      expect(prompt).toContain("separate standard swap quote from its first block");
    });

    it("names the research gap: no holder count, no liquidity, dexscreener instead", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T545-T547.
      expect(prompt).toContain("Holder count and liquidity are unavailable here");
      expect(prompt).toContain("pair research is a separate stage");
      expect(prompt).toContain("my launches on the Robinhood launchpad");
    });

    it("states that the agent path requires an image and that execute refuses without one", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T548-T551.
      expect(prompt).toContain("agent path requires a staged image");
      expect(prompt).toContain("Both agent paths start from a user-staged image");
      // The blank-token outcome survives only as the user's own manual choice,
      // never as something the agent may elect.
      expect(prompt).toContain("Only the user's own launch form may choose to launch without one");
    });

    it("marks the launch preview advisory: no address, dynamic fee", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T552-T554.
      expect(prompt).toContain("The preview is advisory");
      expect(prompt).toContain("Never promise a predicted address from a preview");
      expect(prompt).toContain("The deployment cost is dynamic");
    });

    it("states the 25 bps native-only fee basis and the pinned fee recipient", () => {
      resetProtocolsPromptCache();
      const full = buildPromptStack(makeContext()).staticLayers.join("\n");
      // Wave 2 migration rows T555-T558. Fee prose has one owner: Identity.
      expect(full).toContain("25 bps of the NATIVE value the launch sends");
      expect(full).toContain("USDG prebuy is an ERC-20 leg and is NOT in that basis");
      expect(full).toContain("THE CREATOR FEE RECIPIENT IS PINNED");
      expect(full).toContain("NO recipient parameter");
    });

    it("routes a restricted session to the launch form and mirrors the authority matrix", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T559-T562.
      expect(prompt).toContain("keep a human form separate from direct execution");
      expect(prompt).toContain("never infer that a drafted or pending launch happened");
      expect(prompt).toContain("In a RESTRICTED session it refuses BY NAME - call `pools__launch_request_form` instead.");
      expect(prompt).toContain("HOST-authored launch ceilings");
    });

    it("states dryRun claim semantics: both legs, and alreadyCollected is not the total", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T563-T566.
      expect(prompt).toContain("claim my creator fees after a dry-run simulation");
      expect(prompt).toContain("Value multi-token rewards separately");
      expect(prompt).toContain("costs gas, so say so before claiming a dust balance");
    });

    it("the pools doctrine carries no em dash (owner decree 2026-08-05)", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration row T844.
      const start = prompt.indexOf("### pools\n");
      expect(start).toBeGreaterThan(-1);
      const section = prompt.substring(start, prompt.indexOf("\n## How Vex works a task"));
      expect(section).not.toContain("—");
    });
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
    // Wave 2 migration rows T568 and T845.
    const projected = getProtocolNamespaceCoverage("kyberswap")?.line ?? "";
    const registryChains = getKyberChains()
      .filter((chain) => chain.aggregator)
      .map((chain) => `${chain.name} (${chain.chainId})`);
    for (const chain of registryChains) expect(projected).toContain(chain);
    expect(projected).not.toContain("uniswap");
  });
});
