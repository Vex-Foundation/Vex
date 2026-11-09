/**
 * Her mood in the shell from the person's last money decision
 * (`useKimmShellMood.ts`): offer while an approved call runs, refused after a
 * rejection or a failure, signed only after a proven fill, nothing for an
 * unproven result; a decision is spent once Vex is idle again, belongs to its
 * own chat, and Studio reads none.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishApprovalDecision,
  resetApprovalDecisionSignalForTests,
  type ApprovalDecisionSignal,
} from "../../appShell/approvals/decision-signal.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { kimmOptionsOfDecision, useKimmShellMood } from "../useKimmShellMood.js";
import type { VexState } from "../vex-state.js";

const CHAT = "session-1";

function signal(over: Partial<ApprovalDecisionSignal>): ApprovalDecisionSignal {
  return {
    kind: "approved",
    decision: "approve",
    approvalId: "approval-1",
    sessionId: CHAT,
    executionStatus: "dispatching",
    at: Date.now(),
    ...over,
  };
}

function mount(state: VexState) {
  return renderHook(({ s }: { s: VexState }) => useKimmShellMood(s), { initialProps: { s: state } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
  resetApprovalDecisionSignalForTests();
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: CHAT });
});

afterEach(() => {
  cleanup();
  resetApprovalDecisionSignalForTests();
  vi.useRealTimers();
});

describe("kimmOptionsOfDecision", () => {
  it("maps each decision to her clock's options, and claims no unproven fill", () => {
    expect(kimmOptionsOfDecision(null)).toEqual({});
    expect(kimmOptionsOfDecision(signal({ executionStatus: null }))).toEqual({ approved: true });
    expect(kimmOptionsOfDecision(signal({ executionStatus: "not_started" }))).toEqual({ approved: true });
    expect(kimmOptionsOfDecision(signal({ executionStatus: "dispatching" }))).toEqual({ approved: true });
    expect(kimmOptionsOfDecision(signal({ executionStatus: "succeeded" }))).toEqual({ outcome: "filled" });
    expect(kimmOptionsOfDecision(signal({ executionStatus: "indeterminate" }))).toEqual({});
    expect(kimmOptionsOfDecision(signal({ kind: "rejected", decision: "reject" }))).toEqual({ outcome: "refused" });
    expect(kimmOptionsOfDecision(signal({ kind: "failed" }))).toEqual({ outcome: "failed" });
  });
});

describe("useKimmShellMood", () => {
  it("reads Vex's state alone while no decision has landed", () => {
    const view = mount("thinking");
    expect(view.result.current).toBe("think");
  });

  it("offers while the approved call runs, then a rejection shows refused for 3.4 s and she rests", () => {
    const view = mount("awaiting");
    act(() => {
      vi.advanceTimersByTime(10);
      publishApprovalDecision(signal({}));
    });
    view.rerender({ s: "working" });
    expect(view.result.current).toBe("offer");

    act(() => {
      vi.advanceTimersByTime(10);
      publishApprovalDecision(signal({ kind: "rejected", decision: "reject", executionStatus: null }));
    });
    view.rerender({ s: "done" });
    expect(view.result.current).toBe("refused");
    act(() => vi.advanceTimersByTime(3400));
    expect(view.result.current).toBe("rest");
  });

  it("spends a decision once Vex is idle again, so a later Done is her own", () => {
    const view = mount("awaiting");
    act(() => {
      vi.advanceTimersByTime(10);
      publishApprovalDecision(signal({ kind: "failed", executionStatus: null }));
    });
    view.rerender({ s: "error" });
    expect(view.result.current).toBe("refused");

    view.rerender({ s: "ready" });
    act(() => vi.advanceTimersByTime(10));
    view.rerender({ s: "thinking" });
    expect(view.result.current).toBe("think");
    view.rerender({ s: "done" });
    expect(view.result.current).toBe("rest");
  });

  it("ignores another chat's decision", () => {
    const view = mount("awaiting");
    act(() => {
      vi.advanceTimersByTime(10);
      publishApprovalDecision(signal({ sessionId: "session-2" }));
    });
    view.rerender({ s: "working" });
    expect(view.result.current).toBe("think");
  });

  it("reads no decision in Studio", () => {
    useUiStore.setState({ runtimeMode: "studio" });
    const view = mount("awaiting");
    act(() => {
      vi.advanceTimersByTime(10);
      publishApprovalDecision(signal({}));
    });
    view.rerender({ s: "working" });
    expect(view.result.current).toBe("think");
  });

  it("claims no fill for an approved call whose result is unproven", () => {
    const view = mount("awaiting");
    act(() => {
      vi.advanceTimersByTime(10);
      publishApprovalDecision(signal({ executionStatus: "indeterminate" }));
    });
    view.rerender({ s: "done" });
    expect(view.result.current).toBe("rest");
  });
});
