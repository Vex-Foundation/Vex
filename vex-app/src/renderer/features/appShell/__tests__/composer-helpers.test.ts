import { describe, expect, it } from "vitest";
import type { ChatSubmitResult } from "@shared/schemas/chat.js";
import { err, ok } from "@shared/ipc/result.js";
import type {
  RuntimeActivity,
  RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import {
  FREE_TEXT_DISALLOWED,
  gatedReason,
  readActivity,
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

  // M2. A continued full-autonomy turn is NOT a failure: the slice ended
  // because the next one is already scheduled. A terminal banner here is the
  // renderer calling a healthy hand-off an error, which is the defect the
  // honest stop reason was introduced to expose rather than create.
  it("shows no terminal banner when the turn was continued to a scheduled wake", () => {
    expect(submitFailureNotice(outcome({ stopReason: "waiting_for_wake" }))).toBeNull();
    // Not an artefact of the zero-tool default arm: a continued turn that DID
    // dispatch tool calls is still not a failure.
    expect(
      submitFailureNotice(
        outcome({ stopReason: "waiting_for_wake", toolCallsMade: 4 }),
      ),
    ).toBeNull();
  });

  // M4. The detector's stop reason must reach the operator. Without its own
  // arm it fell through `default: null` and the turn ended in silence - the
  // loop stopped and nothing on screen said why.
  it("names a tool-call loop and never offers one-click retry", () => {
    const notice = submitFailureNotice(outcome({ stopReason: "tool_call_loop" }));
    expect(notice?.text).toContain("repeated the same tool call");
    // Unconditionally non-retryable, and deliberately NOT routed through
    // `incompleteTurnNotice`: reaching this stop reason MEANS identical tool
    // calls executed, so `toolCallsMade === 0` is unreachable and a
    // count-gated retry arm would be dead code posing as a safety check.
    expect(notice?.retryable).toBe(false);
    expect(notice?.text).toContain("earlier steps may have completed");
    expect(
      submitFailureNotice(outcome({ stopReason: "tool_call_loop", toolCallsMade: 9 }))
        ?.retryable,
    ).toBe(false);
  });
});

// M6 (owner decision). Steering a RUNNING mission is the designed path:
// `ingress.ts` persists the message as an operator instruction that the loop
// merges at its next tool-step boundary. The composer gate refused exactly
// that, leaving Stop as the operator's only lever over a running run.
describe("free-text gate", () => {
  it("allows free text into a running mission", () => {
    expect(FREE_TEXT_DISALLOWED.has("running")).toBe(false);
  });

  // The gate still holds where free text genuinely cannot answer what the run
  // is parked on, and each of those states still names its own control.
  it.each(["paused_approval", "paused_user", "paused_wake"] as const)(
    "still gates %s and explains which control clears it",
    (status) => {
      expect(FREE_TEXT_DISALLOWED.has(status)).toBe(true);
      expect(gatedReason(status).length).toBeGreaterThan(0);
    },
  );

  // The reason string is only ever read for a GATED status. A `running` arm
  // surviving here would be unreachable copy asserting the opposite of the
  // contract above.
  it("no longer carries a reason for running", () => {
    expect(gatedReason("running")).not.toContain("Stop button");
  });
});

/**
 * A REAL runtime DTO, not a partial cast to `never`. The cast let a fixture
 * omit every field the reader might grow to touch and still type-check, which
 * is exactly the drift a projection test exists to catch.
 */
function runtimeState(activity: RuntimeActivity): RuntimeStateDto {
  return {
    sessionId: "00000000-0000-4000-8000-0000000000a1",
    hasActiveRun: false,
    missionRunId: null,
    status: null,
    stopReason: null,
    lastCheckpointAt: null,
    startedAt: null,
    iterationCount: null,
    leaseActive: activity.kind === "running",
    leaseExpiresAt: null,
    pendingControlKind: null,
    stoppable: activity.kind !== "none",
    activity,
  };
}

describe("readActivity", () => {
  it("reads the projection main decided", () => {
    expect(readActivity(ok(runtimeState({ kind: "running" })))).toEqual({
      kind: "running",
    });
  });

  // NULL IS NOT IDLE. An unread or failed runtime state must not let a surface
  // assert the session is doing nothing - that is how a running agent was
  // reported Idle in the first place.
  it("returns null - never an idle activity - when the state is unread or failed", () => {
    expect(readActivity(undefined)).toBeNull();
    expect(
      readActivity(
        err({
          code: "internal.unexpected",
          domain: "runtime",
          message: "Unable to load runtime state.",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "corr-1",
        }),
      ),
    ).toBeNull();
  });
});
