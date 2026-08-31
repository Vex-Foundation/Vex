/**
 * M5: the composer strip and the desk-rule tape word must NEVER disagree about
 * what an autonomous agent session is doing.
 *
 * This is the regression this whole projection exists for. The two surfaces
 * used to answer the question from different inputs - the tape from "is there
 * a mission run row", the strip from the mission status - so a full-autonomy
 * agent session, which has no run row at all, read RUNNING on neither and
 * "Idle" on the tape while it was mid-slice or parked on a wake. Both now read
 * `RuntimeStateDto.activity` through the one selector, and this test drives
 * BOTH real components over the same DTO to prove it.
 *
 * Deliberately NOT a unit test of `readSessionActivityReadout`: that function
 * agreeing with itself proves nothing. The contract is that two rendered
 * surfaces show the same state for the same fact.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RuntimeActivity } from "@shared/schemas/runtime.js";

const SESSION = "00000000-0000-4000-8000-0000000000a1";

const runtimeData = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: runtimeData.current, isError: false }),
}));
vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => ({ data: { ok: true, data: [] } }),
}));
vi.mock("../../../lib/api/chat.js", () => ({
  useIsChatSubmitting: () => false,
}));
vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionPlan: () => ({ data: { ok: true, data: null } }),
}));
vi.mock("../../../stores/streamStore.js", () => ({
  useStreamPreview: () => null,
}));
vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (select: (s: { activeSessionId: string }) => unknown) =>
    select({ activeSessionId: SESSION }),
}));

const { DeskRuleTapeState } = await import("../DeskRuleTapeState.js");
const { ComposerMissionStrip } = await import(
  "../SessionComposer/ComposerMissionStrip.js"
);

/**
 * An AGENT session's runtime state: no mission run row, which is exactly the
 * shape that used to read Idle on the tape no matter what the agent was doing.
 */
function agentState(activity: RuntimeActivity) {
  return {
    ok: true as const,
    data: {
      sessionId: SESSION,
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
    },
  };
}

afterEach(() => {
  cleanup();
  runtimeData.current = null;
});

describe("strip and tape agree about session activity", () => {
  it.each([
    ["running", { kind: "running" } as RuntimeActivity, "Running", "RUNNING"],
    [
      "sleeping",
      {
        kind: "sleeping",
        nextWakeAt: "2026-08-28T12:04:00.000Z",
      } as RuntimeActivity,
      "Sleeping",
      "SLEEPING",
    ],
  ])(
    "both name a %s agent session",
    (_label, activity, tapeWord, stripWord) => {
      runtimeData.current = agentState(activity);
      render(
        <>
          <DeskRuleTapeState />
          <ComposerMissionStrip
            sessionId={SESSION}
            mode="agent"
            missionStatus={null}
            activity={activity}
          />
        </>,
      );
      // The tape prints the sentence-case word; the strip prints it uppercased
      // in its own micro-label grammar. Same state, two registers - which is
      // why the machine label below is the real agreement assertion.
      expect(screen.getByText(tapeWord)).toBeTruthy();
      const strip = document.querySelector("[data-vex-area='composer-mission-strip']");
      expect(strip?.textContent).toContain(stripWord);
      expect(strip?.getAttribute("data-vex-activity")).toBe(
        activity.kind === "running" ? "running" : "sleeping",
      );
    },
  );

  // At rest the two surfaces say the same thing in different ways, and both
  // are correct: the tape always shows a word, so it shows Idle; the strip is
  // a band that only exists when there is something to report, so it shows
  // nothing rather than parking "IDLE" over an idle composer.
  it("agree that an idle agent session is idle", () => {
    const activity: RuntimeActivity = { kind: "none" };
    runtimeData.current = agentState(activity);
    render(
      <>
        <DeskRuleTapeState />
        <ComposerMissionStrip
          sessionId={SESSION}
          mode="agent"
          missionStatus={null}
          activity={activity}
        />
      </>,
    );
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(
      document.querySelector("[data-vex-area='composer-mission-strip']"),
    ).toBeNull();
  });

  // The projection is session-scoped, so a MISSION session's activity is
  // `none` and the tape must keep reading its run status - not fall through to
  // Idle and contradict the strip, which still speaks mission grammar.
  it("leave mission rendering to the mission status", () => {
    runtimeData.current = {
      ok: true as const,
      data: {
        ...agentState({ kind: "none" }).data,
        hasActiveRun: true,
        status: "running",
        missionRunId: "r1",
        stoppable: true,
      },
    };
    render(
      <>
        <DeskRuleTapeState />
        <ComposerMissionStrip
          sessionId={SESSION}
          mode="mission"
          missionStatus="running"
          activity={{ kind: "none" }}
        />
      </>,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    const strip = document.querySelector("[data-vex-area='composer-mission-strip']");
    expect(strip?.textContent).toContain("Mission");
    expect(strip?.getAttribute("data-status")).toBe("running");
  });
});
