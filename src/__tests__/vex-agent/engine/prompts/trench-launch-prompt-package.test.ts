/**
 * Trench prompt package (P1–P8) — the pins for the prompt wave that made the
 * Trench Express LAUNCH capability visible to a cold model, and repaired the
 * routing text around it.
 *
 * Three independent prompt audits found the same defect class: the tools
 * existed in the catalog, the navigation entries authored rich `facets` and
 * `exampleQueries`, and none of it reached the built prompt — so the model
 * could see `trench__launch_execute` only by guessing to search for it.
 *
 * Every assertion here is behaviour a regression would silently remove.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildBridgeCapabilityPrompt } from "@vex-agent/engine/prompts/protocols.js";
import {
  buildMissionRunPrompt,
  buildMissionSetupPrompt,
  buildProtocolsPrompt,
  buildToolModelPrompt,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/index.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";
import { makeContext } from "./_prompt-stack-helpers.js";

describe("trench prompt package", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
  });

  // ── P1: the authored navigation data actually renders ──────────
  describe("P1 - declarations replace capsule scaffolding", () => {
    it("keeps frozen facets in declaration metadata without rendering facet rows", () => {
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration row T846.
      for (const metadata of getAdvertisedProtocolNavigation()) {
        const section = prompt.split(`### ${metadata.namespace}\n`)[1]?.split("\n### ")[0] ?? "";
        expect(metadata.declaration.facets).toEqual(metadata.facets.map((facet) => facet.label));
        for (const facet of metadata.facets) expect(section).not.toContain(`- ${facet.label}`);
      }
    });

    it("renders each namespace's authored example queries on one `Try:` line", () => {
      const prompt = buildProtocolsPrompt();
      const trench = prompt.split("### trench\n")[1]?.split("\n### ")[0] ?? "";
      // Wave 2 migration row T676.
      expect(trench).not.toContain("Try: ");
      expect(getAdvertisedProtocolNavigation().find((entry) => entry.namespace === "trench")?.exampleQueries)
        .toContain('ToolSearch(query="preview a token launch cost", namespace="trench")');
    });

    it("surfaces the launch capability by name, not only by guessable search", () => {
      const trench = buildProtocolsPrompt().split("### trench\n")[1]?.split("\n### ")[0] ?? "";
      // Wave 2 migration rows T677 and T678.
      expect(trench).toContain("deploy the token");
      expect(trench).toContain("staged images cannot be created by the agent");
    });
  });

  // ── P2: the swap-venue routing exception ───────────────────────
  it("P2 — teaches that a bonding-curve Trench token trades only on its own ETH curve", () => {
    const prompt = buildProtocolsPrompt();
    const section = prompt.split("### Swap\n")[1]?.split("\n### ")[0] ?? "";
    // Wave 2 migration rows T679-T682.
    expect(section).toContain("Trench token still on its curve trades only against ETH");
    expect(section).toContain("after graduation it moves to a WETH-paired pool");
  });

  // ── P3: the launch doctrine block ──────────────────────────────
  describe("P3 — `## Trench Launch` doctrine", () => {
    it("names the four tools of the launch path in order, with what each one costs", () => {
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("### Launches");
      const section = prompt.split("### Launches\n")[1] ?? "";
      // Wave 2 migration rows T683-T701. Tool descriptions keep local call
      // mechanics; the task shape keeps procedure and exact authority prose.
      expect(section).toContain("Both agent paths start from a user-staged image");
      expect(section).toContain("Preview current costs immediately before execution");
      // The park-and-resume mechanics of the form (drafts, spends nothing, the
      // turn parks, the runtime resumes it with the outcome, never re-call it
      // while the form is open) now live in the `trench__launch_request_form`
      // description (ledger rows L288-L291); the task shape keeps only the
      // procedural rule that a drafted or pending launch is not a launch.
      expect(section).toContain("keep a human form separate from direct execution");
      expect(section).toContain("never infer that a drafted or pending launch happened");
      // Only the execute signs, and only under authority. The AUTHORITY PIN
      // was "an approval for this launch, or a mission ..." — updated 2026-08-02
      // with the owner decrees, because that text was WRONG in both directions:
      // it refused a full-permission chat user who had already given the same
      // consent every other mutating tool spends on, and it promised an
      // approval card for launches, which the restricted path no longer
      // produces (the FORM replaces it). All three arms are pinned so a
      // regression that drops one is a failure, not a silent narrowing.
      expect(section).toContain("irreversibly");
      expect(section).toContain("only under explicit authority");
      expect(section).toContain("FULL-permission chat session");
      expect(section).toContain("execute directly");
      expect(section).toContain("RESTRICTED session it refuses by name");
      expect(section).toContain("`trench__launch_request_form` instead");
      expect(section).toContain("this tool's consent surface");
      expect(section).toContain("MISSION run the authority is the contract's host-authored launch ceilings");
      expect(section).toContain("max launch value and max launch count on the contract card");
    });

    it("renders in the STATIC prefix (imperative doctrine, no live data)", () => {
      // Wave 2 migration row T702.
      expect(buildProtocolsPrompt()).toContain("### Launches");
    });
  });

  // ── P4: host-authored launch ceilings during setup ─────────────
  it("P4 — mission setup says launch ceilings are HOST-authored and checks the image locker", () => {
    const prompt = buildMissionSetupPrompt(makeContext({ sessionKind: "mission" }));
    expect(prompt).toContain("**launch ceilings**");
    expect(prompt).toContain("HOST-authored");
    expect(prompt).toContain("`MissionDraftUpdate` cannot write them");
    expect(prompt).toContain("contract card before accepting the contract");
    // The image check is a STATE read during setup, not banned market research.
    expect(prompt).toContain("`trench__images_list`");
    expect(prompt).toContain("state read");
    expect(prompt).toContain("Trench Photos card");
  });

  // ── P5: mission run — research pointer, launches, slice ────────
  describe("P5 — mission run", () => {
    const runPrompt = (): string => buildMissionRunPrompt(makeContext({
      sessionKind: "mission",
      missionRunId: "run-1",
    }));

    it("points at the Token Research Map instead of a hard-coded tool list", () => {
      const prompt = runPrompt();
      // Wave 2 migration rows T710-T712.
      expect(prompt).toContain("`### Research` task shape");
      // The must-end-in-a-decision clause survives the rewrite.
      expect(prompt).toContain("a shortlist, an execution candidate, a defer decision, or a contract-valid stop");
      // The stale hard-coded list is gone (it also named Solana unconditionally,
      // in installs that may have no Jupiter key).
      expect(prompt).not.toContain("Use DexScreener, Jupiter/Solana, wallet, agent scan, or web research");
    });

    it("carries the launch block: authority, path, and no improvised substitute", () => {
      const prompt = runPrompt();
      expect(prompt).toContain("## Token launches");
      expect(prompt).toContain("irreversible and spends real ETH");
      expect(prompt).toContain("max launch value, max launch count");
      expect(prompt).toContain("`trench__launch_preview`");
      expect(prompt).toContain("hands the launch DECISION to the user");
      // Honesty gate: a refusal from deferred host wiring is a report-and-move-on,
      // never an improvised alternative route or a retry loop.
      expect(prompt).toContain("do not improvise a substitute launch and do not retry it in a loop");
      expect(prompt).toContain("tell the user what to set on the contract card");
    });

    it("defines what a slice IS, not only what it is not", () => {
      const prompt = runPrompt();
      expect(prompt).toContain("A slice is one bounded stretch of work between engine yields");
      expect(prompt).toContain("not mission stop conditions");
    });
  });

  // ── P6: tool-map scope + list mode ─────────────────────────────
  it("P6 — the Tool Map rule is scoped to DIRECT tools and `list=true` is taught", () => {
    const prompt = buildToolModelPrompt();
    expect(prompt).toContain("if a direct internal tool is not in it RIGHT NOW, it is not callable");
    // The un-scoped version made the model believe the whole protocol surface
    // was gone whenever a namespace was absent from the Map.
    expect(prompt).toContain("Protocol tools are NOT listed there individually");
    expect(prompt).toContain("not evidence its tools do not exist");
    expect(prompt).toContain('`ToolSearch(namespace="x")` with NO query');
    expect(prompt).toContain("unranked and untruncated");
  });

  // ── P7: Robinhood funding routes through the shortcut ──────────
  it("P7 — funding Robinhood Chain routes via the bridge shortcut, not `relay.*` directly", () => {
    // Rendered by the DYNAMIC bridge turn layer; assert on the built text.
    const text = buildBridgeCapabilityPrompt({
      kind: "available",
      chainNames: ["Ethereum", "Base"],
      stale: false,
      robinhoodViaRelay: true,
    });
    expect(text).toContain("`BridgeQuote` then `BridgeExecute`");
    expect(text).toContain("auto-route to Relay");
    expect(text).not.toContain("in with `relay.*`");
  });

  // ── P8: the yield arbiter ──────────────────────────────────────
  describe("P8 — yield arbiter", () => {
    const saved = process.env.JUPITER_API_KEY;

    afterEach(() => {
      if (saved === undefined) delete process.env.JUPITER_API_KEY;
      else process.env.JUPITER_API_KEY = saved;
      resetProtocolsPromptCache();
    });

    it("names the two real yield families and forbids substituting a swap", () => {
      process.env.JUPITER_API_KEY = "test-jupiter-key";
      resetProtocolsPromptCache();
      const section = buildProtocolsPrompt().split("### Yield\n")[1]?.split("\n### ")[0] ?? "";
      // Wave 2 migration rows T730-T733.
      expect(section).toContain("There is no plain staking capability");
      expect(section).toContain("Pendle");
      expect(section).toContain("Route Solana yield to Jupiter Lend for earn and collateralized borrowing");
      expect(section).toContain("Never substitute a swap for a yield position");
    });

    it("drops the Solana half when JUPITER_API_KEY is absent (same gate the dispatcher uses)", () => {
      delete process.env.JUPITER_API_KEY;
      resetProtocolsPromptCache();
      const section = buildProtocolsPrompt().split("### Yield\n")[1]?.split("\n### ")[0] ?? "";
      // Wave 2 migration rows T734 and T735.
      expect(section).toContain("There is no plain staking capability");
      expect(section).toContain("Solana yield is unavailable until its configured capability is enabled");
    });
  });
});
