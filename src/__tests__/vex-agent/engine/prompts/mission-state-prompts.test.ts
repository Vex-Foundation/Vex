import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import { makeEngineContext } from "../_engine-context.js";
import {
  buildPromptStack,
  buildMissionRunPrompt,
  buildMissionSetupPrompt,
  buildResearchPrompt,
  buildToolModelPrompt,
} from "../../../../vex-agent/engine/prompts/index.js";
import { buildContextPressureBanner } from "../../../../vex-agent/engine/prompts/context-pressure.js";

function makeMissionContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return makeEngineContext({
    sessionId: "session-1",
    sessionKind: "mission",
    missionId: "mission-1",
    ...overrides,
  });
}

describe("mission state prompts", () => {
  it("frames mission setup as Capability Orientation with tool-backed readiness", () => {
    const prompt = buildMissionSetupPrompt(makeMissionContext());

    // Setup is Capability Orientation: identify which tools/venues fit + read
    // live wallet/chain state to ground the draft, then propose/refine it.
    expect(prompt).toContain("Capability Orientation");
    expect(prompt).toContain("`ToolSearch`");
    expect(prompt).toContain("`WalletBalances`");
    expect(prompt).toContain("`AgentScan`");
    // Research-category pointer + venue-only recording rule are part of the
    // coherent orientation vocabulary.
    expect(prompt).toContain("`WebResearch`");
    expect(prompt).toContain("`TwitterAccount`");
    expect(prompt).toContain("`allowedProtocols`");
    expect(prompt).toContain("venue/protocol names only");
    // Grounded, not open-ended — the draft discipline + mutation ban stay.
    expect(prompt).toContain("do not spiral into open-ended market analysis before the draft is ready");
    expect(prompt).toContain("Do NOT execute any mutating tools (swaps, bridges, transfers) during setup");
    expect(prompt).toContain("`MissionDraftUpdate` is the source of truth for readiness");
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
    // no `PlanWrite` pointer, no "Action Plan" heading. Plan-mode off leaves
    // the setup prompt byte-identical to before plan-mode existed.
    expect(prompt).not.toContain("`PlanWrite`");
    expect(prompt).not.toContain("Action Plan (plan mode is ON)");
  });

  it("renders the plan-authoring subsection ONLY when plan-mode is ON", () => {
    const prompt = buildMissionSetupPrompt(makeMissionContext({ planMode: true }));

    // The plan-mode-ON subsection appears (Stage 4): it instructs the model to
    // co-author the action plan via `PlanWrite` and that the single host
    // Accept step accepts BOTH the contract and the plan together.
    expect(prompt).toContain("Action Plan (plan mode is ON)");
    expect(prompt).toContain("`PlanWrite`");
    expect(prompt).toContain("single Accept contract step accepts both");
    // Plan-mode has only the short delta: record the intended capabilities,
    // then defer operational research until after acceptance.
    expect(prompt).toContain("Record which tools and venues you will use");
    expect(prompt).toContain("Operational Research");
    // The single host accept step is still named where the contract fields
    // define it; the activation sequence above owns the full ordering.
    expect(prompt).toContain("mission.acceptContract");

    // The OFF-only invariants (Capability Orientation framing, ToolSearch,
    // wallet/chain grounding) still hold with plan-mode on — the subsection is
    // additive, not a replacement.
    expect(prompt).toContain("`ToolSearch`");
    expect(prompt).toContain("`WalletBalances`");
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
    // negative market-data-call rule.
    const prompt = buildResearchPrompt();

    expect(prompt).toMatch(/Research workflow varies by mode/i);
    expect(prompt).toMatch(/Mission SETUP.*Capability Orientation/i);
    expect(prompt).toMatch(/Mission RUN.*actionable decision/i);
    expect(prompt).toMatch(/Chat.*answer the current request/i);

    // Capability Orientation markers — merged into research.ts.
    expect(prompt).toContain("## Capability Orientation vs Operational Research");
    expect(prompt).toContain("Operational Research");
    expect(prompt).toContain("This is orientation, not market operation");
    expect(prompt).toContain("do NOT call market-data tools or pull quotes while planning");

    // Negative: the old "research + planning phase" framing is gone.
    expect(prompt).not.toContain("research + planning phase");
    expect(prompt).not.toContain("research and planning phase");

    // "discovery is a means to execution" must be SCOPED to the execution
    // phases wherever it appears — in `# Tool Model` §3 (tool-model.ts) and in
    // `# Research` (research.ts) — never an unscoped global rule. A2 replaced
    // the old scope marker "During mission RUN / agent execution": "agent
    // execution" was not a phase this prompt ever defines, so the marker now
    // names the two defined ones. The structural check is unchanged.
    const combined = `${buildToolModelPrompt()}\n\n${prompt}`;
    const discoveryPhrase = "discovery is a means to execution";
    expect(combined).toContain(discoveryPhrase);
    const segments = combined.split(discoveryPhrase);
    for (let i = 0; i < segments.length - 1; i += 1) {
      const before = segments[i];
      const lastScope = before.lastIndexOf(
        "During mission RUN — or in AGENT chat when the user explicitly asked for the action —",
      );
      const lastSentenceBreak = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"));
      // The scope marker must be the nearest sentence-leading phrase before
      // this occurrence (i.e. no sentence boundary separates them).
      expect(lastScope, `unscoped "${discoveryPhrase}" at occurrence ${i + 1}`).toBeGreaterThan(lastSentenceBreak);
    }
  });

  it("describes barrier dispatch truthfully rather than enumerating an obsolete safety subset", () => {
    // Original intent (kept): never hard-code which safety classes dispatch —
    // the Tool Map is the live answer. Updated for v2: the banner also stops
    // instructing a tool call, because the runtime now compacts on its own.
    const prompt = buildContextPressureBanner("barrier", 0.9);

    expect(prompt).toContain("Mutating tools are unavailable");
    expect(prompt).toContain("no tool call is required from you");
    // Guards the ORIGINAL intent — the banner must not hard-code a safety-class
    // enumeration, which would go stale exactly as the previous one did.
    expect(prompt).not.toMatch(/only read_only and \w+ tools dispatch/);
    expect(prompt).not.toMatch(/MUST call/);
  });

  it("makes active mission runs ignore stale setup start instructions", () => {
    // The Jupiter steering line below is env-gated (A2): `solana.*` needs
    // JUPITER_API_KEY, so recommending it without the key would point the model
    // at a namespace the dispatcher refuses. Assert the WITH-key posture here.
    const savedJupiterKey = process.env.JUPITER_API_KEY;
    process.env.JUPITER_API_KEY = "test-jupiter-key";
    const prompt = buildMissionRunPrompt(
      makeMissionContext({ missionRunId: "run-1" }),
      {
        missionPromptContext: "# Mission: SOL Sprint",
        iterationCount: 0,
      },
    );

    expect(prompt).toContain("started the run from the host UI (the Start or Continue control); the run is active");
    expect(prompt).toContain("Treat earlier setup messages asking the operator to start the mission as historical context only");
    expect(prompt).toContain("do not call `LoopDefer` because you are waiting for mission activation");
    expect(prompt).toContain("each research loop must produce a shortlist, an execution candidate, a defer decision, or a contract-valid stop");
    // Fresh-token steering: prefer Jupiter's recent feed over the free DexScreener feed.
    expect(prompt).toContain("category=recent");
    // Setup-only proof: the execution-lock standing rule must NOT leak into the
    // run prompt — during an active run the gate is open and the lock would be
    // false, contradictory guidance.
    expect(prompt).not.toContain("Execution lock (standing rule)");
    expect(prompt).not.toContain("blocked by the runtime gate");

    if (savedJupiterKey === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = savedJupiterKey;
  });

  // ── C3: typed deployed capital guidance ─────────────────────────
  describe("deployed capital guidance", () => {
    it("documents deployedCapital as an optional typed field in the setup prompt", () => {
      const prompt = buildMissionSetupPrompt(makeMissionContext());
      expect(prompt).toContain("- **deployedCapital** (optional, and strongly recommended whenever a success criterion mentions gain, loss, or a portfolio value)");
      expect(prompt).toContain("Save all five parts together or none, because a raw amount without its decimals cannot be read");
    });

    it("tells the model what the warnings list means in the setup prompt", () => {
      const prompt = buildMissionSetupPrompt(makeMissionContext());
      expect(prompt).toContain("MissionDraftUpdate returns a warnings list when it sees this: fix the draft, or tell the user plainly why you are leaving it");
    });

    it("points the run prompt at the Mission Capital section instead of the transcript", () => {
      const prompt = buildMissionRunPrompt(makeMissionContext({ missionRunId: "run-1" }));
      expect(prompt).toContain("Deployed capital and portfolio change since this run started are given to you each turn in `# Mission Capital`");
      expect(prompt).toContain("never treat a balance that existed before the run started as progress");
    });

    it("renders a NESTED draft field as JSON, never as [object Object]", () => {
      const prompt = buildMissionSetupPrompt(makeMissionContext(), {
        currentDraft: {
          title: "SOL DCA",
          deployedCapital: {
            amountRaw: "3044000000000000000000",
            decimals: 18,
            chainId: 4663,
            assetAddress: "0x0f9f0000000000000000000000000000000000ee",
            assetSymbol: "VEX",
          },
        },
        missingFields: [],
        warnings: [],
      });
      expect(prompt).not.toContain("[object Object]");
      expect(prompt).toContain("\"amountRaw\":\"3044000000000000000000\"");
    });

    it("surfaces measurability warnings in the setup prompt itself, even on a READY draft", () => {
      // The renew gap: a renewed draft clones the previous deployedCapital
      // verbatim and no tool call fires, so the prompt is the only surface
      // that can show the model a stale-denominator warning unprompted.
      const prompt = buildMissionSetupPrompt(makeMissionContext(), {
        currentDraft: { title: "Renewed hunt" },
        missingFields: [],
        warnings: [
          "A success criterion states an absolute portfolio value.",
        ],
      });
      expect(prompt).toContain("## Status: READY");
      expect(prompt).toContain("## Measurability Warnings");
      expect(prompt).toContain("A success criterion states an absolute portfolio value.");
      expect(prompt).toContain("tell the user plainly why you are leaving it as is");
    });

    it("omits the warnings section entirely when there are none", () => {
      const prompt = buildMissionSetupPrompt(makeMissionContext(), {
        currentDraft: { title: "Clean" },
        missingFields: ["goal"],
        warnings: [],
      });
      expect(prompt).not.toContain("## Measurability Warnings");
    });
  });
});
