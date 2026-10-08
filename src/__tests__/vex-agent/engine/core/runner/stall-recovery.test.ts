import { describe, it, expect, vi } from "vitest";

import type { InferenceConfig, ReasoningEffort } from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import {
  STALL_RECOVERY_ENABLED,
  buildStallRecoveryNote,
  createStallRecoveryTracker,
  decideRecoveryEffort,
  prepareStallRecoveryCall,
  stallRecoveryLogFields,
} from "@vex-agent/engine/core/runner/stall-recovery.js";
import { getToolDef } from "@vex-agent/tools/registry.js";
import { requireValue } from "../../../../helpers/require-value.js";

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "test-model",
    contextLimit: 128000,
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    ...overrides,
  };
}

function assistantCalling(...names: string[]): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: names.map((command, i) => ({ id: `call-${i}`, command, args: {} })),
    timestamp: "2026-09-27T00:00:00.000Z",
  };
}

function userAsks(content: string): Message {
  return { role: "user", content, timestamp: "2026-09-27T00:00:00.000Z" };
}

const READ_TOOL = "ToolSearch";
const BROADCAST_TOOL = "SwapExecute";

/** A current request that has already made one pure read: the evidence lowering needs. */
const READ_EVIDENCE: readonly Message[] = [userAsks("check the pools"), assistantCalling(READ_TOOL)];

describe("stall recovery", () => {
  it("is switched on by default", () => {
    expect(STALL_RECOVERY_ENABLED).toBe(true);
  });

  it("the registry fixtures really are a read and a non-read tool", () => {
    const read = requireValue(getToolDef(READ_TOOL));
    expect(read.actionKind).toBe("read");
    expect(read.mutating).toBe(false);
    expect(requireValue(getToolDef(BROADCAST_TOOL)).actionKind).not.toBe("read");
  });

  describe("note", () => {
    it.each([
      ["reasoning_exhausted", "ran out of output room while reasoning"],
      ["incomplete_tool_batch", "cut off or malformed, so none of those calls ran"],
      ["blank", "Your last reply was empty."],
      [
        "stream_timeout",
        "Your last attempt took too long without producing an action and was stopped. Act now: call the next tool with complete arguments, or give your answer.",
      ],
    ] as const)("names what went wrong for %s", (kind, phrase) => {
      const note = buildStallRecoveryNote(kind);
      expect(note.startsWith("# Last Attempt Produced No Action\n")).toBe(true);
      expect(note).toContain(phrase);
    });
  });

  describe("tracker", () => {
    it("arms once after an unproductive round and is spent when consumed", () => {
      const t = createStallRecoveryTracker(true);
      expect(t.pending()).toBe(null);
      t.observe({ kind: "blank" });
      expect(t.pending()).toBe("blank");
      t.consume();
      expect(t.pending()).toBe(null);
      t.observe({ kind: "reasoning_exhausted" });
      expect(t.pending()).toBe(null);
    });

    it("stays armed until a call is actually issued", () => {
      const t = createStallRecoveryTracker(true);
      t.observe({ kind: "reasoning_exhausted" });
      expect(t.pending()).toBe("reasoning_exhausted");
      expect(t.pending()).toBe("reasoning_exhausted");
    });

    it("a productive round resets the streak so a later stall recovers again", () => {
      const t = createStallRecoveryTracker(true);
      t.observe({ kind: "blank" });
      t.consume();
      t.observe({ kind: "productive" });
      t.observe({
        kind: "incomplete_tool_batch",
        truncated: true,
        validToolCalls: 0,
        malformedToolCalls: 1,
      });
      expect(t.pending()).toBe("incomplete_tool_batch");
    });

    it("a timeout arms the recovery, and a timed-out recovery fails the streak", () => {
      const t = createStallRecoveryTracker(true);
      t.observe({ kind: "stream_timeout", stall: "first_chunk" });
      expect(t.pending()).toBe("stream_timeout");
      t.consume();
      expect(t.recoveryFailed()).toBe(false);
      t.observe({ kind: "stream_timeout", stall: "idle" });
      expect(t.recoveryFailed()).toBe(true);
    });

    it("never arms when switched off", () => {
      const t = createStallRecoveryTracker(false);
      t.observe({ kind: "blank" });
      expect(t.pending()).toBe(null);
    });
  });

  describe("effort guard", () => {
    const noPending = vi.fn(async () => false);

    it("lowers to low when every condition holds", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: [assistantCalling(READ_TOOL)],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: true, from: "high", to: "low" });
    });

    it("keeps effort when there are no tool calls at all: no evidence the request is read-only", async () => {
      const probe = vi.fn(async () => false);
      const decision = await decideRecoveryEffort({
        config: config({ reasoningEffort: "medium" }),
        liveMessages: [],
        inLoopPendingApprovals: 0,
        hasPendingApproval: probe,
      });
      expect(decision).toEqual({ lowered: false, reason: "no_current_request_evidence" });
      expect(probe).not.toHaveBeenCalled();
    });

    it("keeps effort for a fresh request with no calls yet, even after read-only history", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: [
          userAsks("what is SOL at?"),
          assistantCalling(READ_TOOL),
          { role: "tool", content: "{}", toolCallId: "call-0", timestamp: "2026-09-27T00:00:01.000Z" },
          { role: "assistant", content: "SOL is at 150.", timestamp: "2026-09-27T00:00:02.000Z" },
          userAsks("swap 5 SOL to USDC"),
          // An engine cue after the request is not a user message and not a call.
          { role: "system", content: "cue", timestamp: "2026-09-27T00:00:03.000Z" },
        ],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: false, reason: "no_current_request_evidence" });
    });

    it("lowers when the current request has made only read calls", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: [
          userAsks("earlier"),
          assistantCalling(BROADCAST_TOOL),
          userAsks("now just look"),
          assistantCalling(READ_TOOL),
          { role: "tool", content: "{}", toolCallId: "call-0", timestamp: "2026-09-27T00:00:01.000Z" },
          assistantCalling(READ_TOOL, READ_TOOL),
        ],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: true, from: "high", to: "low" });
    });

    it("keeps effort when any current-request call is not a read, even an earlier one", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: [
          userAsks("swap then check"),
          assistantCalling(BROADCAST_TOOL),
          { role: "tool", content: "{}", toolCallId: "call-0", timestamp: "2026-09-27T00:00:01.000Z" },
          assistantCalling(READ_TOOL),
        ],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: false, reason: "non_read_tool_call" });
    });

    it("keeps effort when the model does not support the parameter", async () => {
      const decision = await decideRecoveryEffort({
        config: config({ supportsReasoningEffort: false }),
        liveMessages: [],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: false, reason: "effort_unsupported" });
    });

    it("keeps the provider default when no effort was set", async () => {
      const decision = await decideRecoveryEffort({
        config: config({ reasoningEffort: undefined }),
        liveMessages: [],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: false, reason: "effort_provider_default" });
    });

    it.each<ReasoningEffort>(["none", "minimal", "low"])(
      "never raises or repeats an effort already at or below low (%s)",
      async (effort) => {
        const decision = await decideRecoveryEffort({
          config: config({ reasoningEffort: effort }),
          liveMessages: [],
          inLoopPendingApprovals: 0,
          hasPendingApproval: noPending,
        });
        expect(decision).toEqual({ lowered: false, reason: "effort_not_above_low" });
      },
    );

    it.each<ReasoningEffort>(["medium", "high", "xhigh", "max"])(
      "treats %s as above low",
      async (effort) => {
        const decision = await decideRecoveryEffort({
          config: config({ reasoningEffort: effort }),
          liveMessages: READ_EVIDENCE,
          inLoopPendingApprovals: 0,
          hasPendingApproval: noPending,
        });
        expect(decision.lowered).toBe(true);
      },
    );

    it("keeps effort after a non-read tool call, even beside a read", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: [assistantCalling(READ_TOOL, BROADCAST_TOOL)],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: false, reason: "non_read_tool_call" });
    });

    it("counts an unregistered tool as non-read", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: [assistantCalling("some_protocol.unknown_action")],
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: false, reason: "non_read_tool_call" });
    });

    it("reads the MOST RECENT assistant tool calls, past later text and tool rows", async () => {
      const liveMessages: Message[] = [
        assistantCalling(READ_TOOL),
        assistantCalling(BROADCAST_TOOL),
        { role: "tool", content: "{}", toolCallId: "call-0", timestamp: "2026-09-27T00:00:01.000Z" },
        { role: "assistant", content: "Waiting.", timestamp: "2026-09-27T00:00:02.000Z" },
      ];
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages,
        inLoopPendingApprovals: 0,
        hasPendingApproval: noPending,
      });
      expect(decision).toEqual({ lowered: false, reason: "non_read_tool_call" });
    });

    it("keeps effort while the session has a pending approval", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: READ_EVIDENCE,
        inLoopPendingApprovals: 0,
        hasPendingApproval: async () => true,
      });
      expect(decision).toEqual({ lowered: false, reason: "pending_approval" });
    });

    it("keeps effort when this loop parked an approval", async () => {
      const probe = vi.fn(async () => false);
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: READ_EVIDENCE,
        inLoopPendingApprovals: 1,
        hasPendingApproval: probe,
      });
      expect(decision).toEqual({ lowered: false, reason: "pending_approval" });
    });

    it("fails closed when the approval state cannot be read", async () => {
      const decision = await decideRecoveryEffort({
        config: config(),
        liveMessages: READ_EVIDENCE,
        inLoopPendingApprovals: 0,
        hasPendingApproval: async () => {
          throw new Error("pool exhausted");
        },
      });
      expect(decision).toEqual({ lowered: false, reason: "pending_approval_unreadable" });
    });

    it("skips the approval read when a cheaper check already refused", async () => {
      const probe = vi.fn(async () => false);
      await decideRecoveryEffort({
        config: config({ supportsReasoningEffort: false }),
        liveMessages: [],
        inLoopPendingApprovals: 0,
        hasPendingApproval: probe,
      });
      expect(probe).not.toHaveBeenCalled();
    });
  });

  describe("recovery call", () => {
    it("copies config and prompt options instead of mutating them", async () => {
      const base = config();
      const promptOptions = { planOffNotice: "x" };
      const call = await prepareStallRecoveryCall({
        from: "reasoning_exhausted",
        config: base,
        promptOptions,
        liveMessages: READ_EVIDENCE,
        inLoopPendingApprovals: 0,
        hasPendingApproval: async () => false,
      });
      expect(call.config.reasoningEffort).toBe("low");
      expect(base.reasoningEffort).toBe("high");
      expect(call.promptOptions.stallRecoveryNote).toBe(buildStallRecoveryNote("reasoning_exhausted"));
      expect(call.promptOptions.planOffNotice).toBe("x");
      expect(promptOptions).toEqual({ planOffNotice: "x" });
      expect(stallRecoveryLogFields(call)).toEqual({
        previousClassification: "reasoning_exhausted",
        effortLowered: true,
        effortFrom: "high",
        effortTo: "low",
        guardReason: null,
      });
    });

    it("sends the note alone when the guard refuses", async () => {
      const base = config();
      const call = await prepareStallRecoveryCall({
        from: "blank",
        config: base,
        promptOptions: {},
        liveMessages: READ_EVIDENCE,
        inLoopPendingApprovals: 0,
        hasPendingApproval: async () => true,
      });
      expect(call.config).toBe(base);
      expect(call.promptOptions.stallRecoveryNote).toBe(buildStallRecoveryNote("blank"));
      expect(stallRecoveryLogFields(call)).toEqual({
        previousClassification: "blank",
        effortLowered: false,
        effortFrom: "high",
        effortTo: "high",
        guardReason: "pending_approval",
      });
    });
  });
});
