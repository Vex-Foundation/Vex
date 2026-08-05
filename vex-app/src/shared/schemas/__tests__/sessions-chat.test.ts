import { describe, expect, it } from "vitest";
import { chatStopReasonSchema, chatSubmitInputSchema } from "../chat.js";
import { sessionCreateInputSchema, sessionModelDtoSchema } from "../sessions.js";

describe("sessionCreateInputSchema", () => {
  it("accepts mission creation without an initial goal", () => {
    const parsed = sessionCreateInputSchema.safeParse({
      mode: "mission",
      name: "LP rebalance",
      permission: "restricted",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects goal text in the create-session payload", () => {
    const parsed = sessionCreateInputSchema.safeParse({
      mode: "mission",
      name: "LP rebalance",
      permission: "restricted",
      initialGoal: "Rebalance Arbitrum LP",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("chatSubmitInputSchema", () => {
  it("trims and accepts the first mission goal as chat text", () => {
    const parsed = chatSubmitInputSchema.safeParse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      message: "  Rebalance Arbitrum LP  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toBe("Rebalance Arbitrum LP");
    }
  });

  // S6/D2: reasoningEffort is OPTIONAL + additive — absent means "no
  // explicit choice" (D6: the engine sends no reasoning param and the
  // provider's own default applies). The transport enum was WIDENED to the
  // full 7-value OpenRouter range (including "none"/"max") — behavior
  // change by decree, this test now pins the WIDER contract instead of the
  // old 3-value subset.
  it("accepts every reasoning effort in the widened 7-value transport enum", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const parsed = chatSubmitInputSchema.safeParse({
        sessionId: "11111111-1111-4111-8111-111111111111",
        message: "think hard",
        reasoningEffort: effort,
      });
      expect(parsed.success, `reasoningEffort "${effort}" must parse`).toBe(true);
    }
  });

  it("rejects reasoning efforts outside the 7-value transport enum", () => {
    for (const effort of ["off", "extreme", "MEDIUM", "", "very_high"]) {
      const parsed = chatSubmitInputSchema.safeParse({
        sessionId: "11111111-1111-4111-8111-111111111111",
        message: "think hard",
        reasoningEffort: effort,
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe("sessionModelDtoSchema (S6 reasoning capability)", () => {
  const baseDto = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
    source: "global_default",
    updatedAt: null,
  };

  it("accepts supportsReasoning true/false/null", () => {
    for (const supportsReasoning of [true, false, null]) {
      const parsed = sessionModelDtoSchema.safeParse({
        ...baseDto,
        supportsReasoning,
        reasoning: null,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("requires the supportsReasoning field (strict DTO)", () => {
    const parsed = sessionModelDtoSchema.safeParse({ ...baseDto, reasoning: null });
    expect(parsed.success).toBe(false);
  });

  it("requires the reasoning field (D3: REQUIRED nullable, strict DTO)", () => {
    const parsed = sessionModelDtoSchema.safeParse({ ...baseDto, supportsReasoning: true });
    expect(parsed.success).toBe(false);
  });

  it("accepts a null reasoning capability alongside supportsReasoning: true (boolean-only fallback)", () => {
    const parsed = sessionModelDtoSchema.safeParse({
      ...baseDto,
      supportsReasoning: true,
      reasoning: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a full non-null reasoning capability", () => {
    const parsed = sessionModelDtoSchema.safeParse({
      ...baseDto,
      supportsReasoning: true,
      reasoning: {
        supportedEfforts: ["high", "medium", "low", "none"],
        defaultEffort: "medium",
        defaultEnabled: true,
        mandatory: false,
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("chatStopReasonSchema (engine StopReason mirror)", () => {
  // The engine's full StopReason union (src/vex-agent/engine/types.ts —
  // BusinessStopReason | RuntimeStopReason), enumerated here BY HAND because
  // src/shared must not import vex-agent. chat.submit pipes the engine's
  // stopReason straight into the validated output (and the paused_wake
  // preempt branch can surface ANY turn-loop stop reason via
  // resumeMissionRun), so a member missing from the schema turns a
  // successful turn into an internal.unexpected IPC error. If this list
  // drifts from the engine union, update BOTH the schema and this test.
  const ENGINE_STOP_REASONS = [
    "goal_reached",
    "deadline_reached",
    "capital_depleted",
    "max_loss_hit",
    "no_viable_opportunity",
    "emergency_stop",
    "user_stopped",
    "approval_required",
    "checkpoint_pause",
    "iteration_limit",
    "timeout",
    "waiting_for_wake",
    "waiting_for_compact_commit",
    "compact_unable_at_critical",
    "system_error",
    "user_paused",
    "plan_acceptance_required",
    "user_form_required",
  ] as const;

  it("accepts every engine StopReason member (S7 fix: user_paused + plan_acceptance_required)", () => {
    for (const reason of ENGINE_STOP_REASONS) {
      const parsed = chatStopReasonSchema.safeParse(reason);
      expect(parsed.success, `stop reason "${reason}" must parse`).toBe(true);
    }
  });

  it("rejects values outside the engine union", () => {
    for (const reason of ["paused", "plan_pause", "unknown", ""]) {
      expect(chatStopReasonSchema.safeParse(reason).success).toBe(false);
    }
  });
});
