import { describe, it, expect, beforeEach } from "vitest";

import {
  buildPromptStack,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import { buildRuntimeClockSnapshot } from "../../../../vex-agent/engine/runtime-clock.js";
import { makeContext, joinedStack } from "./_prompt-stack-helpers.js";

describe("prompt-stack — mode & context", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
  });

  // ── Contextual layers ───────────────────────────────────────

  describe("contextual layers", () => {
    it("agent mode includes agent prompt", () => {
      const joined = joinedStack(makeContext({ sessionKind: "agent" }));
      expect(joined).toContain("# Agent Mode");
    });

    it("mission setup includes setup prompt", () => {
      const joined = joinedStack(makeContext({
        sessionKind: "mission", missionId: "m-1",
      }));
      expect(joined).toContain("# Mission Setup");
      expect(joined).not.toContain("# Mission Execution");
      // The standing execution lock rides the setup layer: pre-acceptance,
      // every on-chain mutation is gate-blocked and the model must say so
      // instead of inventing workarounds.
      expect(joined).toContain("Execution lock (standing rule)");
    });

    it("mission run includes run prompt", () => {
      const joined = joinedStack(makeContext({
        sessionKind: "mission", missionId: "m-1", missionRunId: "run-1",
      }));
      expect(joined).toContain("# Mission Execution");
      expect(joined).not.toContain("# Mission Setup");
      // Setup-only: the execution lock must not leak into an active run.
      expect(joined).not.toContain("Execution lock (standing rule)");
    });

    it("mission setup with context shows draft state", () => {
      const joined = joinedStack(
        makeContext({ sessionKind: "mission" }),
        {
          missionSetupContext: {
            currentDraft: { title: "SOL DCA", goal: "Accumulate SOL" },
            missingFields: ["capitalSource", "startingCapital"],
          },
        },
      );
      expect(joined).toContain("SOL DCA");
      expect(joined).toContain("Still Missing");
      expect(joined).toContain("capitalSource");
      expect(joined).toContain("Stop conditions are user-owned contract terms");
      // Puzzle 04: prompt no longer instructs the model about
      // `stopConditionsAccepted=true` — acceptance is host-only. The
      // mission-setup prompt instead points the model at the host
      // `Accept contract` step.
      // Wave-3 P4: one authoritative activation-sequence rule replaces the
      // old standalone acceptance sentence.
      expect(joined).toContain("click Accept contract");
      expect(joined).toContain("Only after that acceptance does the host show Start mission");
    });

    it("mission run with context shows mission contract", () => {
      const joined = joinedStack(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        {
          missionRunContext: {
            missionPromptContext: "# Mission: SOL DCA\n**Goal:** Accumulate 10 SOL",
            iterationCount: 5,
          },
        },
      );
      expect(joined).toContain("SOL DCA");
      expect(joined).toContain("Iteration: 5");
    });

  });

  // ── Base prompt ─────────────────────────────────────────────

  describe("base prompt", () => {
    it("includes session context", () => {
      const joined = joinedStack(makeContext({ sessionId: "test-session" }));
      expect(joined).toContain("test-session");
    });

    it("includes runtime clock context for session and mission timing (turn layers)", () => {
      const runtimeClock = buildRuntimeClockSnapshot({
        now: new Date("2026-05-03T08:39:18.126Z"),
        timezone: "UTC",
        sessionStartedAt: "2026-05-03T08:01:02.000Z",
        missionRunStartedAt: "2026-05-03T08:10:00.000Z",
        missionDeadline: "2026-05-03T14:10:00.000Z",
      });
      const stack = buildPromptStack(
        makeContext({
          sessionKind: "mission",
          missionId: "m-1",
          missionRunId: "run-1",
          sessionStartedAt: "2026-05-03T08:01:02.000Z",
          missionRunStartedAt: "2026-05-03T08:10:00.000Z",
          missionDeadline: "2026-05-03T14:10:00.000Z",
        }),
        { runtimeClock },
      );
      const turnJoined = stack.turnLayers.join("\n");

      expect(turnJoined).toContain("# Runtime Clock");
      expect(turnJoined).toContain("Current time UTC: 2026-05-03T08:39:18.126Z");
      expect(turnJoined).toContain("Session started: 2026-05-03T08:01:02.000Z (elapsed: 38m 16s)");
      expect(turnJoined).toContain("Mission run started: 2026-05-03T08:10:00.000Z (elapsed: 29m 18s)");
      expect(turnJoined).toContain("Mission deadline: 2026-05-03T14:10:00.000Z (in 5h 30m)");
      expect(turnJoined).toContain("loop_defer(after_ms, reason)");
      // The volatile clock must never leak into the static prefix.
      expect(stack.staticLayers.join("\n")).not.toContain("# Runtime Clock");
    });

    it("includes loaded content blocks (e.g. long_memory_get injections)", () => {
      const joined = joinedStack(makeContext({
        loadedDocuments: new Map([["long_memory:42", "# Strategy\nBuy low sell high"]]),
      }));
      expect(joined).toContain("# Loaded Content");
      expect(joined).toContain("long_memory:42");
      expect(joined).toContain("Buy low sell high");
    });
  });

  // ── Dynamic aspect injection ────────────────────────────────

  describe("base prompt — dynamic aspect", () => {
    /**
     * Aspect narration in base.ts is modal: only the currently active mode's
     * aspect lands in the prompt. Prevents model from reading about modes it
     * can't reach from this session.
     */
    it("AGENT aspect: only teacher/collaborator lines, no MISSION narrative", () => {
      const joined = joinedStack(makeContext({ sessionKind: "agent" }));
      expect(joined).toContain("AGENT");
      expect(joined).toContain("teacher, collaborator");
      expect(joined).not.toContain("MISSION SETUP");
      expect(joined).not.toContain("MISSION RUN");
    });

    it("MISSION SETUP aspect: planner lines, no AGENT / MISSION RUN narrative", () => {
      const joined = joinedStack(makeContext({ sessionKind: "mission" }));
      expect(joined).toContain("MISSION SETUP");
      expect(joined).toContain("planner");
      // AGENT aspect narrative absent — we only check the aspect-section label.
      expect(joined).not.toContain("teacher, collaborator");
      expect(joined).not.toContain("MISSION RUN");
    });

    it("MISSION RUN aspect: executor lines, no SETUP / AGENT narrative", () => {
      const joined = joinedStack(makeContext({
        sessionKind: "mission", missionId: "m-1", missionRunId: "run-1",
      }));
      expect(joined).toContain("MISSION RUN");
      expect(joined).toContain("executor");
      expect(joined).toContain("mission_stop");
      expect(joined).toContain("user-approved stop condition");
      expect(joined).toContain("loop_defer");
      expect(joined).not.toContain("teacher, collaborator");
      expect(joined).not.toContain("planner");
    });
  });

  // The agent mode-core carries a UNIQUE anti-drift instruction that no other
  // layer states — it must survive the decomposition (Codex P2 add e).
  describe("agent mode-core anti-drift instruction preserved (P3 requirement e)", () => {
    it("keeps the unique 'don't drift into autonomous monitoring/mission drafting' line", () => {
      const joined = joinedStack(makeContext({ sessionKind: "agent" }));
      expect(joined).toContain(
        "Do not turn an agent answer into autonomous monitoring, mission drafting, or multi-step research unless the user asks for that workflow",
      );
    });
  });
});
