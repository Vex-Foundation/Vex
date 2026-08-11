import { describe, it, expect } from "vitest";

import type {
  SessionKind,
  Permission,
  MissionStatus,
  MissionRunStatus,
  BusinessStopReason,
  RuntimeStopReason,
  StopReason,
  MessageSource,
  MessageType,
  MessageVisibility,
  MissionDraft,
  MissionPatch,
  EngineContext,
  TurnResult,
  MessageMetadata,
} from "../../../vex-agent/engine/types.js";

import {
  MISSION_DRAFT_REQUIRED_FIELDS,
  MissionRunPausedError,
} from "../../../vex-agent/engine/types.js";

describe("engine types", () => {
  // ── Session axes ────────────────────────────────────────────────

  describe("SessionKind", () => {
    it("accepts valid values", () => {
      const values: SessionKind[] = ["agent", "mission"];
      expect(values).toHaveLength(2);
    });
  });

  describe("Permission", () => {
    it("accepts valid values", () => {
      const values: Permission[] = ["restricted", "full"];
      expect(values).toHaveLength(2);
    });
  });

  // ── Mission lifecycle ───────────────────────────────────────────

  describe("MissionStatus", () => {
    it("covers full lifecycle", () => {
      const values: MissionStatus[] = ["draft", "ready", "running", "completed", "failed", "cancelled"];
      expect(values).toHaveLength(6);
    });
  });

  describe("MissionRunStatus", () => {
    it("covers run states including pause reasons", () => {
      const values: MissionRunStatus[] = ["running", "paused_approval", "completed", "failed", "stopped"];
      expect(values).toHaveLength(5);
    });
  });

  // ── Stop conditions ─────────────────────────────────────────────

  describe("BusinessStopReason", () => {
    it("covers all business stop reasons", () => {
      const values: BusinessStopReason[] = [
        "goal_reached", "deadline_reached", "capital_depleted",
        "max_loss_hit", "no_viable_opportunity", "emergency_stop", "user_stopped",
      ];
      expect(values).toHaveLength(7);
    });
  });

  describe("RuntimeStopReason", () => {
    it("covers all runtime stop reasons", () => {
      const values: RuntimeStopReason[] = [
        "approval_required", "checkpoint_pause", "iteration_limit",
        "timeout", "waiting_for_wake", "system_error",
      ];
      expect(values).toHaveLength(6);
    });
  });

  describe("StopReason", () => {
    it("is union of business and runtime", () => {
      const business: StopReason = "goal_reached";
      const runtime: StopReason = "approval_required";
      expect(business).toBe("goal_reached");
      expect(runtime).toBe("approval_required");
    });
  });

  // ── Message taxonomy ──────────────────────────────────────────

  describe("MessageSource", () => {
    it("covers all sources", () => {
      const values: MessageSource[] = ["user", "assistant", "engine", "tool", "system"];
      expect(values).toHaveLength(5);
    });
  });

  describe("MessageType", () => {
    it("covers all message types", () => {
      const values: MessageType[] = [
        "chat", "mission_setup", "mission_summary", "approval_pause",
        "continue", "checkpoint", "tool_result",
      ];
      expect(values).toHaveLength(7);
    });
  });

  describe("MessageVisibility", () => {
    it("covers user and internal", () => {
      const values: MessageVisibility[] = ["user", "internal"];
      expect(values).toHaveLength(2);
    });
  });

  // ── MissionDraft ──────────────────────────────────────────────

  describe("MissionDraft", () => {
    it("has all expected fields", () => {
      const draft: MissionDraft = {
        title: null,
        goal: null,
        capitalSource: null,
        startingCapital: null,
        deployedCapital: null,
        allowedWallets: null,
        allowedChains: null,
        allowedProtocols: null,
        riskProfile: null,
        successCriteria: null,
        stopConditions: null,
        deadline: null,
        durationMinutes: null,
        maxLaunchValueRaw: null,
        maxLaunchValueDecimals: null,
        maxLaunchCount: null,
      };
      // Puzzle 04 removed `stopConditionsAccepted` from MissionDraft —
      // acceptance is host-only via `missions.accepted_contract_hash`.
      // WP-I1 added `durationMinutes` (hard time-box, minutes).
      // C3 added `deployedCapital` (the typed measurement base; optional, so it
      // is NOT in MISSION_DRAFT_REQUIRED_FIELDS).
      expect(Object.keys(draft)).toHaveLength(16);
    });

    it("accepts populated values", () => {
      const draft: MissionDraft = {
        title: "SOL DCA Strategy",
        goal: "Accumulate 10 SOL over 7 days",
        capitalSource: "wallet",
        startingCapital: "500 USDC",
        deployedCapital: {
          amountRaw: "500000000",
          decimals: 6,
          chainId: 4663,
          assetAddress: "0x0f9f0000000000000000000000000000000000ee",
          assetSymbol: "USDC",
        },
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana"],
        riskProfile: "conservative",
        successCriteria: ["Accumulated 10 SOL"],
        stopConditions: ["capital_depleted", "deadline_reached"],
        deadline: "2026-04-04",
        durationMinutes: 60,
        maxLaunchValueRaw: "1000000000000000000",
        maxLaunchValueDecimals: 18,
        maxLaunchCount: 3,
      };
      expect(draft.title).toBe("SOL DCA Strategy");
      expect(draft.allowedChains).toEqual(["solana"]);
    });
  });

  describe("MISSION_DRAFT_REQUIRED_FIELDS", () => {
    it("contains exactly 10 required fields", () => {
      expect(MISSION_DRAFT_REQUIRED_FIELDS).toHaveLength(10);
    });

    it("does not include deadline (optional)", () => {
      expect(MISSION_DRAFT_REQUIRED_FIELDS).not.toContain("deadline");
    });

    it("does not include durationMinutes (optional — env/default fallback)", () => {
      expect(MISSION_DRAFT_REQUIRED_FIELDS).not.toContain("durationMinutes");
    });

    it("includes all business-critical fields", () => {
      const expected = [
        "title", "goal", "capitalSource", "startingCapital",
        "allowedWallets", "allowedChains", "allowedProtocols",
        "riskProfile", "successCriteria", "stopConditions",
      ];
      for (const field of expected) {
        expect(MISSION_DRAFT_REQUIRED_FIELDS).toContain(field);
      }
    });
  });

  // ── EngineContext ─────────────────────────────────────────────

  describe("EngineContext", () => {
    it("has all expected fields", () => {
      const ctx: EngineContext = {
        sessionId: "session-1",
        sessionKind: "agent",
        sessionPermission: "restricted",
        missionId: null,
        missionRunId: null,
        selectedEvmWallet: null,
        selectedSolanaWallet: null,
        walletPolicy: { kind: "none" },
        loadedDocuments: new Map(),
      };
      expect(ctx.sessionId).toBe("session-1");
    });

    it("supports mission context", () => {
      const ctx: EngineContext = {
        sessionId: "session-2",
        sessionKind: "mission",
        sessionPermission: "restricted",
        missionId: "mission-1",
        missionRunId: "run-1",
        selectedEvmWallet: { id: "w-evm", address: "0xabc" },
        selectedSolanaWallet: { id: "w-sol", address: "So1abc" },
        walletPolicy: { kind: "mission_allowed", allowedWallets: ["w-evm", "w-sol"] },
        loadedDocuments: new Map([["doc/strategy", "# Strategy"]]),
      };
      expect(ctx.missionId).toBe("mission-1");
      expect(ctx.loadedDocuments.size).toBe(1);
    });
  });

  // ── TurnResult ────────────────────────────────────────────────

  describe("TurnResult", () => {
    it("represents a text-only chat response", () => {
      const result: TurnResult = {
        text: "Here is your balance.",
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: null,
        missionStatus: null,
      };
      expect(result.text).toBeTruthy();
      expect(result.pendingApprovals).toHaveLength(0);
    });

    it("represents an approval pause", () => {
      const result: TurnResult = {
        text: null,
        toolCallsMade: 3,
        pendingApprovals: ["approval-1", "approval-2"],
        stopReason: "approval_required",
        missionStatus: "running",
      };
      expect(result.pendingApprovals).toHaveLength(2);
      expect(result.stopReason).toBe("approval_required");
    });

    it("represents a completed mission", () => {
      const result: TurnResult = {
        text: "Mission complete — accumulated 10 SOL.",
        toolCallsMade: 15,
        pendingApprovals: [],
        stopReason: "goal_reached",
        missionStatus: "completed",
      };
      expect(result.stopReason).toBe("goal_reached");
      expect(result.missionStatus).toBe("completed");
    });
  });

  // ── MissionRunPausedError — wrapper propagation (WP1 step 6) ───

  describe("MissionRunPausedError", () => {
    it("copies statusCode/causeCode from a normalized 503/ECONNRESET-shaped cause", () => {
      const cause = Object.assign(
        new Error("OpenRouter chat completion failed: status=503 | unavailable"),
        { statusCode: 503, causeCode: "ECONNRESET" },
      );
      const wrapper = new MissionRunPausedError({
        runId: "run-1", missionId: "mission-1", sessionId: "session-1", cause,
      });
      expect(wrapper.statusCode).toBe(503);
      expect(wrapper.causeCode).toBe("ECONNRESET");
      expect(wrapper.cause).toBe(cause);
    });

    it("is null for a cause with no matching validated own-property", () => {
      const wrapper = new MissionRunPausedError({
        runId: "run-1", missionId: "mission-1", sessionId: "session-1",
        cause: new Error("plain failure"),
      });
      expect(wrapper.statusCode).toBeNull();
      expect(wrapper.causeCode).toBeNull();
    });

    it("rejects a non-finite statusCode and a non-errno-shaped causeCode", () => {
      const cause = Object.assign(new Error("weird"), {
        statusCode: NaN,
        causeCode: "not an errno shape!",
      });
      const wrapper = new MissionRunPausedError({
        runId: "run-1", missionId: "mission-1", sessionId: "session-1", cause,
      });
      expect(wrapper.statusCode).toBeNull();
      expect(wrapper.causeCode).toBeNull();
    });

    it("handles a non-Error cause without throwing", () => {
      const wrapper = new MissionRunPausedError({
        runId: "run-1", missionId: "mission-1", sessionId: "session-1", cause: "boom",
      });
      expect(wrapper.statusCode).toBeNull();
      expect(wrapper.causeCode).toBeNull();
      expect(wrapper.message).toBe("boom");
    });
  });

  // ── MessageMetadata ───────────────────────────────────────────

  describe("MessageMetadata", () => {
    it("all fields are optional", () => {
      const empty: MessageMetadata = {};
      expect(Object.keys(empty)).toHaveLength(0);
    });

    it("accepts full metadata", () => {
      const meta: MessageMetadata = {
        source: "engine",
        messageType: "continue",
        visibility: "internal",
        originSessionId: "session-parent",
      };
      expect(meta.source).toBe("engine");
      expect(meta.visibility).toBe("internal");
    });
  });
});
