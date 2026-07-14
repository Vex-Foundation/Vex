import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import {
  buildPromptStack,
  buildMissionRunPrompt,
  buildMissionSetupPrompt,
  buildResearchPrompt,
  buildToolModelPrompt,
} from "../../../../vex-agent/engine/prompts/index.js";
import { buildContextPressureBanner } from "../../../../vex-agent/engine/prompts/context-pressure.js";

function makeMissionContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "mission",
    sessionPermission: "restricted",
    missionId: "mission-1",
    missionRunId: null,
    isSubagent: false,
    loadedDocuments: new Map(),
    ...overrides,
  };
}

describe("mission state prompts", () => {
  it("frames mission setup as Capability Orientation with tool-backed readiness", () => {
    const prompt = buildMissionSetupPrompt(makeMissionContext());

    // Setup is Capability Orientation: identify which tools/venues fit + read
    // live wallet/chain state to ground the draft, then propose/refine it.
    expect(prompt).toContain("Capability Orientation");
    expect(prompt).toContain("`discover_tools`");
    expect(prompt).toContain("`wallet_balances`");
    expect(prompt).toContain("`portfolio`");
    // Research-category pointer + venue-only recording rule are part of the
    // coherent orientation vocabulary.
    expect(prompt).toContain("`web_research`");
    expect(prompt).toContain("`twitter_account`");
    expect(prompt).toContain("`allowedProtocols`");
    expect(prompt).toContain("venue/protocol names only");
    // Grounded, not open-ended — the draft discipline + mutation ban stay.
    expect(prompt).toContain("do not spiral into open-ended market analysis before the draft is ready");
    expect(prompt).toContain("Do NOT execute any mutating tools (swaps, bridges, transfers) during setup");
    expect(prompt).toContain("`mission_draft_update` is the source of truth for readiness");
    // Standing execution lock — the proactive counterpart to the prequote
    // gate's `wallet_setup` fail-close: the model must know every on-chain
    // mutation is refused pre-acceptance so it never invents workarounds
    // (e.g. "my tools have no approve()" → sending the user to MetaMask).
    expect(prompt).toContain("**Execution lock (standing rule):**");
    expect(prompt).toContain("blocked by the runtime gate");
    expect(prompt).toContain("do not invent workarounds");
    expect(prompt).toContain("follow the activation sequence below");
    expect(prompt).toContain("Activation sequence:");
    expect(prompt).toContain("click Accept contract. Only after that acceptance does the host show Start mission");
    expect(prompt.match(/Activation sequence:/g)).toHaveLength(1);
    expect(prompt).not.toContain("The user can now start the mission.");

    // Negative: old vocabulary and the dropped `social` namespace are gone.
    expect(prompt).not.toContain("research and planning phase");
    expect(prompt).not.toContain("swaps/DEX/markets/social");
    expect(prompt).not.toMatch(/markets\/social/);

    // Plan-mode OFF (default): the plan-authoring subsection MUST NOT render —
    // no `plan_write` pointer, no "Action Plan" heading. Plan-mode off leaves
    // the setup prompt byte-identical to before plan-mode existed.
    expect(prompt).not.toContain("`plan_write`");
    expect(prompt).not.toContain("Action Plan (plan mode is ON)");
  });

  it("renders the plan-authoring subsection ONLY when plan-mode is ON", () => {
    const prompt = buildMissionSetupPrompt(makeMissionContext({ planMode: true }));

    // The plan-mode-ON subsection appears (Stage 4): it instructs the model to
    // co-author the action plan via `plan_write` and that the single host
    // Accept step accepts BOTH the contract and the plan together.
    expect(prompt).toContain("Action Plan (plan mode is ON)");
    expect(prompt).toContain("`plan_write`");
    expect(prompt).toContain("single Accept contract step accepts both");
    // Plan-mode has only the short delta: record the intended capabilities,
    // then defer operational research until after acceptance.
    expect(prompt).toContain("Record which tools and venues you will use");
    expect(prompt).toContain("Operational Research");
    // The single host accept step is still named where the contract fields
    // define it; the activation sequence above owns the full ordering.
    expect(prompt).toContain("mission.acceptContract");

    // The OFF-only invariants (Capability Orientation framing, discover_tools,
    // wallet/chain grounding) still hold with plan-mode on — the subsection is
    // additive, not a replacement.
    expect(prompt).toContain("`discover_tools`");
    expect(prompt).toContain("`wallet_balances`");
  });

  it("treats partial meme-token mission ideas as draft input grounded by focused research", () => {
    const prompt = buildMissionSetupPrompt(makeMissionContext());

    expect(prompt).toContain("hunt Solana meme tokens with $6");
    expect(prompt).toContain("treat it as draft input");
    expect(prompt).toContain("do not defer the draft into an open-ended token/market hunt");
  });

  it("research workflow uses the Capability Orientation vs Operational Research vocabulary", () => {
    // P3 decomposition: the per-mode research breakdown lives in `# Research`
    // (research.ts) and speaks ONE vocabulary — Mission SETUP is Capability
    // Orientation (not market operation), Mission RUN ends in an actionable
    // decision, Chat answers and stops. The former `planning-discipline.ts`
    // constant is merged into research.ts, carrying the canonical heading + the
    // negative `execute_tool`-on-market-data rule.
    const prompt = buildResearchPrompt();

    expect(prompt).toMatch(/Research workflow varies by mode/i);
    expect(prompt).toMatch(/Mission SETUP.*Capability Orientation/i);
    expect(prompt).toMatch(/Mission RUN.*actionable decision/i);
    expect(prompt).toMatch(/Chat.*answer the current request/i);

    // Capability Orientation markers — merged into research.ts.
    expect(prompt).toContain("## Capability Orientation vs Operational Research");
    expect(prompt).toContain("Operational Research");
    expect(prompt).toContain("This is orientation, not market operation");
    expect(prompt).toContain("do NOT call `execute_tool` on market data");

    // Negative: the old "research + planning phase" framing is gone.
    expect(prompt).not.toContain("research + planning phase");
    expect(prompt).not.toContain("research and planning phase");

    // "discovery is a means to execution" must be SCOPED to mission RUN / agent
    // execution wherever it appears — in `# Tool Model` §3 (tool-model.ts) and
    // in `# Research` (research.ts) — never an unscoped global rule.
    const combined = `${buildToolModelPrompt()}\n\n${prompt}`;
    const discoveryPhrase = "discovery is a means to execution";
    expect(combined).toContain(discoveryPhrase);
    const segments = combined.split(discoveryPhrase);
    for (let i = 0; i < segments.length - 1; i += 1) {
      const before = segments[i];
      const lastScope = before.lastIndexOf("During mission RUN / agent execution");
      const lastSentenceBreak = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"));
      // The scope marker must be the nearest sentence-leading phrase before
      // this occurrence (i.e. no sentence boundary separates them).
      expect(lastScope, `unscoped "${discoveryPhrase}" at occurrence ${i + 1}`).toBeGreaterThan(lastSentenceBreak);
    }
  });

  it("describes barrier dispatch from the current Tool Map rather than an obsolete safety subset", () => {
    const prompt = buildContextPressureBanner("barrier", 0.9);

    expect(prompt).toContain("Mutations are blocked until compaction completes");
    expect(prompt).toContain("trust the current Tool Map for what remains callable");
    expect(prompt).not.toContain("only read_only and compact_only tools dispatch");
  });

  it("makes active mission runs ignore stale setup start instructions", () => {
    const prompt = buildMissionRunPrompt(
      makeMissionContext({ missionRunId: "run-1" }),
      {
        missionPromptContext: "# Mission: SOL Sprint",
        iterationCount: 0,
      },
    );

    expect(prompt).toContain("started the run from the host UI (the Start or Continue control); the run is active");
    expect(prompt).toContain("Treat earlier setup messages asking the operator to start the mission as historical context only");
    expect(prompt).toContain("do not call `loop_defer` because you are waiting for mission activation");
    expect(prompt).toContain("each research loop must produce a shortlist, an execution candidate, a defer decision, or a contract-valid stop");
    // Fresh-token steering: prefer Jupiter's recent feed over the free DexScreener feed.
    expect(prompt).toContain("category=recent");
    // Setup-only proof: the execution-lock standing rule must NOT leak into the
    // run prompt — during an active run the gate is open and the lock would be
    // false, contradictory guidance.
    expect(prompt).not.toContain("Execution lock (standing rule)");
    expect(prompt).not.toContain("blocked by the runtime gate");
  });

});
