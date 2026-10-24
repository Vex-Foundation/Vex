/**
 * The run strip above the composer (docs/design/R3-MINIMAL.md section 7):
 * sentence-case state words, real facts only, the ink frame for a mission
 * paused on an error, nothing while settled, and the cells it publishes for
 * the mission keys `MissionControls` owns (`mission-strip-slot.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement, type JSX } from "react";
import type { RuntimeActivity } from "@shared/schemas/runtime.js";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";

const SESSION = "00000000-0000-4000-8000-0000000000e1";
const DUE_AT = "2026-08-28T12:04:00.000Z";

const runtimeData = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: () => ({ data: runtimeData.current, isError: false }),
}));
vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
  useSessionPlan: () => ({ data: { ok: true, data: null } }),
}));

const { ComposerMissionStrip } = await import(
  "../SessionComposer/ComposerMissionStrip.js"
);
const { useMissionStripSlot } = await import(
  "../MissionControls/mission-strip-slot.js"
);

function wakeTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderStrip(
  mode: "mission" | "agent",
  missionStatus: MissionRunStatus | null,
  activity: RuntimeActivity | null = { kind: "none" },
) {
  return render(
    createElement(ComposerMissionStrip, { sessionId: SESSION, mode, missionStatus, activity }),
  );
}

function strip(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-area='composer-mission-strip']");
}

afterEach(() => {
  cleanup();
  runtimeData.current = null;
});

describe("ComposerMissionStrip", () => {
  it("names a running mission in sentence case, with no limits it cannot read", () => {
    renderStrip("mission", "running");
    expect(strip()?.textContent).toContain("Mission · Running");
    expect(strip()?.textContent).not.toMatch(/RUNNING|Max spend/);
    expect(strip()?.getAttribute("data-status")).toBe("running");
  });

  it("shows a sleeping mission's wake time from pausedWake", () => {
    runtimeData.current = {
      ok: true,
      data: { pausedWake: { dueAt: DUE_AT, reason: null, watchSummary: null } },
    };
    renderStrip("mission", "paused_wake");
    expect(strip()?.textContent).toContain("Mission · Sleeping");
    expect(strip()?.textContent).toContain(`Wakes at ${wakeTime(DUE_AT)}`);
  });

  it("frames a mission paused on an error in ink and says it is not monitoring", () => {
    renderStrip("mission", "paused_error");
    expect(strip()?.textContent).toContain("Mission · Paused on error");
    expect(strip()?.textContent).toContain("Not monitoring the market");
    expect(strip()?.querySelector(".border-rule-ink")).not.toBeNull();
  });

  it("renders nothing for a settled run or no run", () => {
    for (const status of ["completed", "failed", "stopped", "cancelled", null] as const) {
      const { unmount } = renderStrip("mission", status);
      expect(strip()).toBeNull();
      unmount();
    }
  });

  it("names a sleeping agent session with its wake time and publishes no mission cells", () => {
    renderStrip("agent", null, { kind: "sleeping", nextWakeAt: DUE_AT });
    expect(strip()?.textContent).toContain("Agent · Sleeping");
    expect(strip()?.textContent).toContain(`Wakes at ${wakeTime(DUE_AT)}`);
    expect(strip()?.getAttribute("data-vex-activity")).toBe("sleeping");
    expect(strip()?.querySelector("[data-vex-cell]")).toBeNull();
  });

  it("publishes its key and note cells for the session while mounted, and withdraws them", () => {
    const seen: { controls: HTMLElement | null; notes: HTMLElement | null }[] = [];
    function Probe(): JSX.Element | null {
      seen.push(useMissionStripSlot(SESSION));
      return null;
    }
    const probe = render(createElement(Probe));
    const { unmount } = renderStrip("mission", "running");
    const cells = seen[seen.length - 1];
    expect(cells?.controls?.getAttribute("data-vex-cell")).toBe("mission-controls");
    expect(cells?.notes?.getAttribute("data-vex-cell")).toBe("mission-notes");
    unmount();
    const after = seen[seen.length - 1];
    expect(after?.controls).toBeNull();
    expect(after?.notes).toBeNull();
    probe.unmount();
  });
});
