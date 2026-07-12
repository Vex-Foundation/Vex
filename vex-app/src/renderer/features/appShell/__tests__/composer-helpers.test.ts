import { describe, expect, it } from "vitest";
import type { ChatSubmitResult } from "@shared/schemas/chat.js";
import {
  submitFailureNotice,
  submitSuccessText,
} from "../composer-helpers.js";

function outcome(
  overrides: Partial<ChatSubmitResult> = {},
): ChatSubmitResult {
  return {
    text: null,
    toolCallsMade: 0,
    pendingApprovals: [],
    stopReason: null,
    missionStatus: null,
    treatedAsInitialGoal: false,
    ...overrides,
  };
}

describe("composer outcome copy", () => {
  it.each([
    ["iteration_limit", "action limit"],
    ["timeout", "timed out"],
    ["system_error", "internal error"],
  ] as const)("marks %s as an incomplete retryable turn", (stopReason, copy) => {
    const notice = submitFailureNotice(outcome({ stopReason }));
    expect(notice?.retryable).toBe(true);
    expect(notice?.text).toContain(copy);
  });

  it("blocks blind retry after tool activity and warns that earlier steps may have completed", () => {
    const notice = submitFailureNotice(
      outcome({ stopReason: "timeout", toolCallsMade: 2 }),
    );
    expect(notice?.retryable).toBe(false);
    expect(notice?.text).toContain("earlier steps may have completed");
  });

  it("explains context exhaustion without offering a same-session retry", () => {
    expect(
      submitFailureNotice(
        outcome({ stopReason: "compact_unable_at_critical" }),
      ),
    ).toEqual({
      text: "Vex stopped because this conversation ran out of usable context. Start a new session or try a narrower request.",
      retryable: false,
    });
  });

  it.each([
    null,
    "approval_required",
    "waiting_for_wake",
    "plan_acceptance_required",
  ] as const)("leaves %s to its existing transcript or control UI", (stopReason) => {
    expect(submitFailureNotice(outcome({ stopReason }))).toBeNull();
  });

  it("preserves the existing stopped and mission-goal success copy", () => {
    expect(submitSuccessText(outcome({ stopReason: "user_stopped" }))).toBe(
      "Stopped.",
    );
    expect(submitSuccessText(outcome({ treatedAsInitialGoal: true }))).toBe(
      "Mission goal received.",
    );
  });
});
