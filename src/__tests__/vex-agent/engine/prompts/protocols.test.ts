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
      expect(prompt).toContain("## pools.fun Launchpad");
      expect(prompt).toContain("TRADING IS DELIBERATELY NOT IN THIS NAMESPACE");
      expect(prompt).toContain("13 of 13 sampled tokens routed");
    });

    // The two Robinhood launchpads must be distinguishable AT THE VENUE
    // QUESTION: the Trench curve exception alone reads as "launchpad tokens on
    // 4663 do not route", which is wrong for every pools.fun token.
    it("contrasts the no-curve pools token against the Trench curve exception", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("pools.fun contrast, same chain");
      expect(prompt).toContain("NO bonding curve and NO graduation");
      expect(prompt).toContain("Never route a pools.fun token through `trench.trade_*`");
      // The Trench exception it contrasts with must still be there.
      expect(prompt).toContain("Trench exception, Robinhood Chain (4663)");
    });

    it("names the research gap: no holder count, no liquidity, dexscreener instead", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("NO holder count and NO liquidity figure ANYWHERE");
      expect(prompt).toContain("indexed as sushiswap v3 on chain robinhood");
      expect(prompt).toContain("pools.my_launches");
    });

    // The address is NOT knowable at preview time (image -> metadata link ->
    // salt -> address) and the deployment fee moves; a model that promises
    // either from a preview is stating a money fact it cannot support.
    // Post-PPV (2026-08-19): the doctrine must state the REQUIREMENT and the
    // refusal, not merely warn about a blank token. A model reading only a
    // consequence launched one anyway.
    it("states that the agent path requires an image and that execute refuses without one", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("AN IMAGE IS REQUIRED on the agent path");
      expect(prompt).toContain("`pools.launch_execute` REFUSES without one and launches nothing");
      expect(prompt).toContain("`trench.images`");
      // The blank-token outcome survives only as the user's own manual choice,
      // never as something the agent may elect.
      expect(prompt).toContain("Only the user's own launch form may choose to launch without one");
    });

    it("marks the launch preview advisory: no address, dynamic fee", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("`pools.launch_preview` is ADVISORY");
      expect(prompt).toContain("Never promise a predicted address from a preview");
      expect(prompt).toContain("THE DEPLOYMENT FEE IS DYNAMIC");
    });

    // Fee basis and destination are the two facts rule 90 says must never be
    // model-chosen: 25 bps on the NATIVE value only, recipient pinned.
    it("states the 25 bps native-only fee basis and the pinned fee recipient", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("25 bps of the NATIVE value the launch sends");
      expect(prompt).toContain("USDG prebuy is an ERC-20 leg and is NOT in that basis");
      expect(prompt).toContain("THE CREATOR FEE RECIPIENT IS PINNED");
      expect(prompt).toContain("NO recipient parameter");
    });

    it("routes a restricted session to the launch form and mirrors the authority matrix", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("`pools.launch_request_form` is how you hand the launch DECISION");
      expect(prompt).toContain("do not call it again while the form is open");
      expect(prompt).toMatch(
        /`pools\.launch_execute`[\s\S]*RESTRICTED session it refuses BY NAME - call `pools\.launch_request_form`/,
      );
      expect(prompt).toContain("HOST-authored launch ceilings");
    });

    // `alreadyCollected` is NOT the claimable total - the simulation is. That
    // inversion is the one way this tool misreports money.
    it("states dryRun claim semantics: both legs, and alreadyCollected is not the total", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("`pools.claim_fees`");
      expect(prompt).toContain("`dryRun: true` FIRST");
      expect(prompt).toContain("already-collected figures are fees the locker ALREADY holds and are NOT the claimable total");
      expect(prompt).toContain("costs gas, so say so before claiming a dust balance");
    });

    it("the pools doctrine carries no em dash (owner decree 2026-08-05)", () => {
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      const start = prompt.indexOf("## pools.fun Launchpad");
      expect(start).toBeGreaterThan(-1);
      const section = prompt.substring(start, prompt.indexOf("## Virtuals Agent Tokens"));
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
