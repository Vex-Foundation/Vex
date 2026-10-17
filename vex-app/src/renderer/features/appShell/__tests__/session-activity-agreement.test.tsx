/**
 * M5: the composer strip and the title bar's token chip must NEVER disagree
 * about what an autonomous agent session is doing.
 *
 * This is the regression the activity projection exists for. The two surfaces
 * used to answer the question from different inputs (the head word from "is
 * there a mission run row", the strip from the mission status), so a
 * full-autonomy agent session, which has no run row at all, read RUNNING on
 * neither and "Idle" in the head while it was mid-slice or parked on a wake.
 * Both now read `RuntimeStateDto.activity` through the one selector
 * (`readSessionActivityReadout`; the chip through `useVexPresence`), and this
 * test drives BOTH real components over the same DTO to prove it.
 *
 * Deliberately NOT a unit test of the selector: that function agreeing with
 * itself proves nothing. The contract is that two rendered surfaces show the
 * same state for the same fact.
 */

import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeActivity } from "@shared/schemas/runtime.js";

const SESSION = "00000000-0000-4000-8000-0000000000a1";

const runtimeData = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: runtimeData.current, isError: false }),
}));
vi.mock("../../../lib/api/approvals.js", () => ({
  usePendingApprovals: () => ({ data: { ok: true, data: [] } }),
  usePendingApprovalsAll: () => ({
    data: { ok: true, data: [] },
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock("../../../lib/api/chat.js", () => ({
  useIsChatSubmitting: () => false,
}));
vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionPlan: () => ({ data: { ok: true, data: null } }),
  useSession: () => ({ data: { ok: true, data: null } }),
  useSessionsList: () => ({ data: { ok: true, data: [] } }),
}));
vi.mock("../../../lib/api/messages.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/api/messages.js")>();
  return { ...original, useTranscriptInfinite: () => ({ data: undefined }) };
});
vi.mock("../../../stores/streamStore.js", () => ({
  useStreamPreview: () => null,
}));
vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (select: (s: { activeSessionId: string; runtimeMode: "agent" }) => unknown) =>
    select({ activeSessionId: SESSION, runtimeMode: "agent" }),
}));

const { VexTokenChip } = await import("../../vex/VexTokenChip.js");
const { ComposerMissionStrip } = await import(
  "../SessionComposer/ComposerMissionStrip.js"
);

/**
 * An AGENT session's runtime state: no mission run row, which is exactly the
 * shape that used to read Idle in the head no matter what the agent was doing.
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

function renderBoth(strip: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VexTokenChip open onToggle={() => undefined} />
      {strip}
    </QueryClientProvider>,
  );
}

function chip(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-area='vex-token-chip']");
}

afterEach(() => {
  cleanup();
  runtimeData.current = null;
});

describe("strip and chip agree about session activity", () => {
  it.each([
    ["running", { kind: "running" } as RuntimeActivity, "working", "Working", "RUNNING"],
    [
      "sleeping",
      {
        kind: "sleeping",
        nextWakeAt: "2026-08-28T12:04:00.000Z",
      } as RuntimeActivity,
      "sleeping",
      "Sleeping",
      "SLEEPING",
    ],
  ])(
    "both name a %s agent session",
    (_label, activity, chipState, chipWord, stripWord) => {
      runtimeData.current = agentState(activity);
      renderBoth(
        <ComposerMissionStrip
          sessionId={SESSION}
          mode="agent"
          missionStatus={null}
          activity={activity}
        />,
      );
      // The chip prints the state word in sentence case; the strip prints it
      // in its own label grammar (its case is the strip's business, so the
      // word is compared without it). Same state, two registers, which is why
      // the machine labels below are the real agreement assertion.
      expect(chip()?.getAttribute("data-vex-state")).toBe(chipState);
      expect(chip()?.textContent).toContain(chipWord);
      const strip = document.querySelector("[data-vex-area='composer-mission-strip']");
      expect(strip?.textContent?.toLowerCase()).toContain(stripWord.toLowerCase());
      expect(strip?.getAttribute("data-vex-activity")).toBe(
        activity.kind === "running" ? "running" : "sleeping",
      );
    },
  );

  // At rest the two surfaces say the same thing in different ways, and both
  // are correct: the chip always shows a word, so it shows Ready; the strip is
  // a band that only exists when there is something to report, so it shows
  // nothing rather than parking a word over an idle composer.
  it("agree that an idle agent session is at rest", () => {
    const activity: RuntimeActivity = { kind: "none" };
    runtimeData.current = agentState(activity);
    renderBoth(
      <ComposerMissionStrip
        sessionId={SESSION}
        mode="agent"
        missionStatus={null}
        activity={activity}
      />,
    );
    expect(chip()?.getAttribute("data-vex-state")).toBe("ready");
    expect(chip()?.textContent).toContain("Ready");
    expect(document.querySelector("[data-vex-area='composer-mission-strip']")).toBeNull();
  });

  // The projection is session-scoped, so a MISSION session's activity is
  // `none` and the chip must keep reading its run status, not fall through to
  // Ready and contradict the strip, which still speaks mission grammar.
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
    renderBoth(
      <ComposerMissionStrip
        sessionId={SESSION}
        mode="mission"
        missionStatus="running"
        activity={{ kind: "none" }}
      />,
    );
    expect(chip()?.getAttribute("data-vex-state")).toBe("working");
    expect(chip()?.textContent).toContain("Working");
    const strip = document.querySelector("[data-vex-area='composer-mission-strip']");
    expect(strip?.textContent?.toLowerCase()).toContain("mission");
    expect(strip?.getAttribute("data-status")).toBe("running");
  });
});
