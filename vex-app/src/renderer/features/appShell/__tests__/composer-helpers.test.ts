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
    ["no_progress", "only empty responses"],
  ] as const)("marks %s as an incomplete retryable turn", (stopReason, copy) => {
    const notice = submitFailureNotice(outcome({ stopReason }));
    expect(notice?.retryable).toBe(true);
    expect(notice?.text).toContain(copy);
  });

  // A stall is only the TAIL of a turn: rounds before it can have dispatched
  // real, money-moving tool calls. The notice must therefore go through the
  // SAME `toolCallsMade` gate as every other incomplete reason - a blanket
  // "safe to retry" would blindly replay a turn that already took an action.
  it("gates one-click retry on a stall exactly like every other incomplete turn", () => {
    const notice = submitFailureNotice(
      outcome({ stopReason: "no_progress", toolCallsMade: 3 }),
    );
    expect(notice?.retryable).toBe(false);
    expect(notice?.text).toContain("earlier steps may have completed");
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

  // `ChatSubmitResult` carries only a `toolCallsMade` COUNT — it does not
  // (and, within this package's renderer+chat.ts scope, cannot safely)
  // identify which specific tools ran or whether any of them was
  // mutating. The renderer has no reliable, registry-backed way to
  // classify a tool as read-only vs. mutating (that classification lives
  // in the privileged `src/vex-agent/tools/registry/*` `mutating` flags,
  // which the untrusted renderer must not duplicate or import). So the
  // retry gate stays deliberately conservative: ANY executed tool call —
  // read-only or mutating — withholds one-click Retry, because a
  // renderer-side guess at "this one was safe" could be wrong and would
  // then blindly replay a turn that already took a real action. These
  // cases pin that this is intentional, not an oversight: a turn whose
  // only executed tool looks read-only-shaped (by name) is treated
  // identically to one whose tool looks mutating-shaped.
  it.each([
    ["a read-only-shaped tool name", "wallet_balances"],
    ["a mutating-shaped tool name", "wallet_send_confirm"],
  ])(
    "withholds retry after exactly one completed tool call regardless of its apparent kind (%s)",
    (_label, _toolNameHint) => {
      // The renderer only ever sees the count — the tool name itself never
      // reaches `ChatSubmitResult` — so both cases reduce to the same
      // input. Asserting on that input is the pin: the gate cannot and
      // must not special-case a "read-only-looking" count of 1.
      const notice = submitFailureNotice(
        outcome({ stopReason: "iteration_limit", toolCallsMade: 1 }),
      );
      expect(notice?.retryable).toBe(false);
      expect(notice?.text).toContain("earlier steps may have completed");
    },
  );
});
