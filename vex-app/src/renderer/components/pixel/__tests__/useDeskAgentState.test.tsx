/**
 * The print's agent state, read from the real stores.
 *
 * The contract is agreement: the eagle on the left page and the tape word in
 * the running head must never name different states. So this suite renders
 * the REAL `DeskRuleTapeState` beside a probe of `useDeskAgentState` over the
 * same mocked stores, across every combination of the signals both read, and
 * compares them (the tape's Sleeping is drawn as idle). It also pins the two
 * places the hook says more than the tape: the welcome (no session open), and
 * the turn island's word while live.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RuntimeActivity } from "@shared/schemas/runtime.js";
import type { StreamPreview } from "../../../stores/streamStore.js";

const SESSION = "00000000-0000-4000-8000-0000000000b4";

const stores = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  preview: null as unknown,
  submitting: false,
  pending: [] as unknown[],
  pendingAll: [] as unknown[],
  runtime: undefined as unknown,
}));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: stores.runtime, isError: false }),
}));
vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => ({ data: { ok: true, data: stores.pending } }),
  usePendingApprovalsAll: () => ({ data: { ok: true, data: stores.pendingAll } }),
}));
vi.mock("../../../lib/api/chat.js", () => ({
  useIsChatSubmitting: () => stores.submitting,
}));
vi.mock("../../../stores/streamStore.js", () => ({
  useStreamPreview: () => stores.preview,
}));
vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (select: (s: { activeSessionId: string | null }) => unknown) =>
    select({ activeSessionId: stores.activeSessionId }),
}));

const { DeskRuleTapeState } = await import(
  "../../../features/appShell/DeskRuleTapeState.js"
);
const { useDeskAgentState } = await import("../useDeskAgentState.js");

function Probe() {
  const { state, turn } = useDeskAgentState();
  return <span data-testid="probe" data-state={state} data-turn={turn ?? ""} />;
}

function preview(overrides: Partial<StreamPreview> = {}): StreamPreview {
  return {
    streamId: "s1",
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningSegments: [],
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: 0,
    errorType: null,
    errorDetail: null,
    status: "working",
    ...overrides,
  };
}

interface RunCase {
  readonly hasActiveRun: boolean;
  readonly status: string | null;
}

function runtimeState(run: RunCase, activity: RuntimeActivity) {
  return {
    ok: true as const,
    data: {
      sessionId: SESSION,
      hasActiveRun: run.hasActiveRun,
      missionRunId: run.hasActiveRun ? "r1" : null,
      status: run.status,
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: null,
      iterationCount: null,
      leaseActive: activity.kind === "running",
      leaseExpiresAt: null,
      pendingControlKind: null,
      stoppable: run.hasActiveRun || activity.kind !== "none",
      activity,
    },
  };
}

function probe(): { state: string | null; turn: string | null } {
  const el = screen.getByTestId("probe");
  return { state: el.getAttribute("data-state"), turn: el.getAttribute("data-turn") };
}

afterEach(() => {
  cleanup();
  stores.activeSessionId = null;
  stores.preview = null;
  stores.submitting = false;
  stores.pending = [];
  stores.pendingAll = [];
  stores.runtime = undefined;
});

const RUNS: readonly (RunCase | null)[] = [
  null,
  { hasActiveRun: false, status: null },
  { hasActiveRun: true, status: "running" },
  { hasActiveRun: true, status: "paused_wake" },
  { hasActiveRun: true, status: "paused_approval" },
];
const ACTIVITIES: readonly RuntimeActivity[] = [
  { kind: "none" },
  { kind: "running" },
  { kind: "sleeping", nextWakeAt: "2026-10-12T12:00:00.000Z" },
];
const PREVIEWS: readonly (StreamPreview | null)[] = [
  null,
  preview({ phase: "streaming", status: "thinking" }),
  preview({ phase: "done", toolName: "WalletBalances" }),
];

describe("the eagle and the tape word agree", () => {
  const cases: [string, () => void][] = [];
  for (const pending of [false, true])
    for (const submitting of [false, true])
      for (const pv of PREVIEWS)
        for (const run of RUNS)
          for (const activity of run === null ? [null] : ACTIVITIES) {
            const name = [
              pending ? "pending" : "-",
              submitting ? "submitting" : "-",
              pv === null ? "no stream" : pv.phase,
              run === null ? "no runtime" : `${String(run.hasActiveRun)}:${run.status ?? "none"}`,
              activity === null ? "-" : activity.kind,
            ].join(" ");
            cases.push([
              name,
              () => {
                stores.activeSessionId = SESSION;
                stores.pending = pending ? [{ id: "a1" }] : [];
                stores.submitting = submitting;
                stores.preview = pv;
                stores.runtime =
                  run === null || activity === null ? undefined : runtimeState(run, activity);
              },
            ]);
          }

  it.each(cases)("%s", (_name, arrange) => {
    arrange();
    render(
      <>
        <Probe />
        <DeskRuleTapeState />
      </>,
    );
    const tape = document.querySelector("[data-vex-tape-state]")?.getAttribute("data-vex-tape-state");
    expect(tape).toBeTruthy();
    const drawn = tape === "sleeping" ? "idle" : tape;
    expect(probe().state).toBe(drawn);
  });
});

describe("useDeskAgentState", () => {
  it("names the five states from their triggers", () => {
    stores.activeSessionId = SESSION;
    stores.runtime = runtimeState({ hasActiveRun: false, status: null }, { kind: "none" });
    const { rerender } = render(<Probe />);
    expect(probe().state).toBe("idle");

    stores.submitting = true;
    rerender(<Probe />);
    expect(probe().state).toBe("live");

    stores.submitting = false;
    stores.runtime = runtimeState({ hasActiveRun: true, status: "running" }, { kind: "none" });
    rerender(<Probe />);
    expect(probe().state).toBe("running");

    stores.runtime = runtimeState({ hasActiveRun: true, status: "paused_wake" }, { kind: "none" });
    rerender(<Probe />);
    expect(probe().state).toBe("paused");

    stores.pending = [{ id: "a1" }];
    stores.submitting = true;
    rerender(<Probe />);
    expect(probe().state).toBe("awaiting");
  });

  it("draws a sleeping agent session as idle and its wake slice as running", () => {
    stores.activeSessionId = SESSION;
    stores.runtime = runtimeState(
      { hasActiveRun: false, status: null },
      { kind: "sleeping", nextWakeAt: "2026-10-12T12:00:00.000Z" },
    );
    const { rerender } = render(<Probe />);
    expect(probe().state).toBe("idle");
    stores.runtime = runtimeState({ hasActiveRun: false, status: null }, { kind: "running" });
    rerender(<Probe />);
    expect(probe().state).toBe("running");
  });

  it("on the welcome, a pending approval anywhere holds the flock", () => {
    stores.activeSessionId = null;
    stores.pendingAll = [];
    const { rerender } = render(<Probe />);
    expect(probe().state).toBe("idle");
    stores.pendingAll = [{ id: "a9" }];
    // A turn or a run of no session cannot reach the welcome.
    stores.submitting = true;
    rerender(<Probe />);
    expect(probe().state).toBe("awaiting");
  });

  it("on the welcome, the tape says nothing, so there is nothing to disagree with", () => {
    stores.activeSessionId = null;
    render(<DeskRuleTapeState />);
    expect(document.querySelector("[data-vex-tape-state]")).toBeNull();
  });

  it.each([
    [preview({ status: "working" }), "working"],
    [preview({ status: "thinking" }), "thinking"],
    [preview({ status: "calling", toolName: "TokenFind" }), "calling"],
    [preview({ status: "writing" }), "writing"],
    [preview({ phase: "done", toolName: "SwapQuote" }), "running"],
  ] as const)("every turn island word is live (%#: %s)", (pv, turn) => {
    stores.activeSessionId = SESSION;
    stores.submitting = true;
    stores.preview = pv;
    render(<Probe />);
    expect(probe()).toEqual({ state: "live", turn });
  });

  it("names no turn outside live", () => {
    stores.activeSessionId = SESSION;
    stores.preview = preview({ phase: "done" });
    stores.pending = [{ id: "a1" }];
    render(<Probe />);
    expect(probe()).toEqual({ state: "awaiting", turn: "" });
  });
});
