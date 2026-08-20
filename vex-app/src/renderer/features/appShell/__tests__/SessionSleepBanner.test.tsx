/**
 * `SessionSleepBanner` — the "Vex is sleeping" state made visible.
 *
 * `loop_defer` parks a run as `paused_wake` for up to 24 hours. Until now the
 * UI showed nothing at all for that state: the operator saw silence and could
 * not tell a sleeping agent from a dead one. The banner's whole job is to say
 * WHEN it wakes and WHY it slept.
 *
 * Two properties matter beyond "it renders":
 *
 *  1. it is driven ENTIRELY by `pausedWake`'s presence, never by `status`
 *     alone — a `paused_wake` run whose pending row is already claimed is no
 *     longer sleeping, and a banner counting down to a wake that already fired
 *     is worse than no banner;
 *  2. the countdown is derived from `dueAt` on every tick, so it stays honest
 *     across a suspended laptop or a long-idle window, rather than decrementing
 *     a stored number that drifts from the real deadline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createElement } from "react";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";

const mockUseRuntimeState = vi.fn();
vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
}));

const { SessionSleepBanner } = await import("../SessionSleepBanner.js");

const SESSION = "00000000-0000-4000-8000-00000000bbbb";
const NOW = new Date("2026-07-30T20:27:00.000Z");

function state(pausedWake: RuntimeStateDto["pausedWake"]): unknown {
  return {
    data: {
      ok: true,
      data: {
        sessionId: SESSION,
        hasActiveRun: true,
        missionRunId: "run-1",
        status: "paused_wake",
        stopReason: null,
        lastCheckpointAt: null,
        startedAt: null,
        iterationCount: 1,
        leaseActive: false,
        leaseExpiresAt: null,
        pendingControlKind: null,
        ...(pausedWake === undefined ? {} : { pausedWake }),
      },
    },
  };
}

function renderBanner() {
  render(createElement(SessionSleepBanner, { sessionId: SESSION }));
  return screen.queryByTestId("session-sleep-banner");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SessionSleepBanner", () => {
  it("renders nothing when the runtime state carries no pausedWake", () => {
    mockUseRuntimeState.mockReturnValue(state(undefined));
    expect(renderBanner()).toBeNull();
  });

  it("renders nothing while the runtime query has not resolved", () => {
    mockUseRuntimeState.mockReturnValue({ data: undefined });
    expect(renderBanner()).toBeNull();
  });

  it("renders nothing when the runtime call failed", () => {
    mockUseRuntimeState.mockReturnValue({
      data: { ok: false, error: { code: "internal.unexpected" } },
    });
    expect(renderBanner()).toBeNull();
  });

  it("names the wake time and the remaining duration", () => {
    // 30 minutes out — the owner's own example.
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T20:57:00.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    const banner = renderBanner();

    expect(banner).not.toBeNull();
    const wakeAt = new Date("2026-07-30T20:57:00.000Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(banner?.textContent).toContain("Vex went to sleep");
    expect(banner?.textContent).toContain(`Wakes at ${wakeAt}`);
    expect(banner?.textContent).toContain("30 min");
  });

  it("rounds a part-minute remainder up rather than down", () => {
    // 29m59s left is still "30 min" — a countdown that rounds down reads as
    // one minute of lost time every single minute.
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T20:56:59.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    expect(renderBanner()?.textContent).toContain("30 min");
  });

  it("splits an hour-plus remainder into hours and minutes", () => {
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T21:28:00.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    expect(renderBanner()?.textContent).toContain("1 h 1 min");
  });

  it("shows the agent's reason and the watch summary when present", () => {
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T22:27:00.000Z",
        reason: "waiting for the ETH funding window",
        watchSummary: "price, balance",
      }),
    );
    const banner = renderBanner();

    expect(banner?.textContent).toContain("waiting for the ETH funding window");
    expect(banner?.textContent).toContain("price, balance");
    // 2h out — hours and minutes, not "120 min".
    expect(banner?.textContent).toContain("2 h");
  });

  it("re-derives the countdown from dueAt as time passes", () => {
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T20:57:00.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    const banner = renderBanner();
    expect(banner?.textContent).toContain("30 min");

    act(() => {
      // The window was suspended for 24 minutes; `advanceTimersByTime` then
      // carries the clock through the ONE tick that fires on resume.
      vi.setSystemTime(new Date("2026-07-30T20:51:00.000Z"));
      vi.advanceTimersByTime(60_000);
    });

    // Derived from the deadline, NOT decremented — a suspended window that
    // missed 24 ticks still shows the truth on the next one.
    expect(banner?.textContent).toContain("5 min");
    expect(banner?.textContent).not.toContain("30 min");
  });

  it("degrades to an imminent-wake phrasing once the deadline has passed", () => {
    // The executor polls every 2s and must still claim the row; a negative
    // countdown would read as a bug.
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T20:26:00.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    const banner = renderBanner();
    expect(banner?.textContent).toContain("any moment now");
    // Never a negative countdown ("-5 min") - the copy's own hyphen
    // separator is fine, a hyphen glued to a digit is not.
    expect(banner?.textContent).not.toMatch(/-\d/);
  });

  it("renders nothing for an unparseable dueAt rather than Invalid Date", () => {
    mockUseRuntimeState.mockReturnValue(
      state({ dueAt: "not-a-date", reason: null, watchSummary: null }),
    );
    expect(renderBanner()).toBeNull();
  });

  it("clears its interval on unmount", () => {
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T20:57:00.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    const { unmount } = render(
      createElement(SessionSleepBanner, { sessionId: SESSION }),
    );
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it("derives the first shown remainder from the current clock, not from mount time", () => {
    // The panel stays mounted for hours with nothing to show; then the agent
    // defers and pausedWake appears. Reading a mount-time `now` here would
    // print the age of the window instead of the time until the wake.
    mockUseRuntimeState.mockReturnValue(state(undefined));
    const { rerender } = render(
      createElement(SessionSleepBanner, { sessionId: SESSION }),
    );

    vi.setSystemTime(new Date("2026-07-30T23:27:00.000Z"));
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T23:57:00.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    rerender(createElement(SessionSleepBanner, { sessionId: SESSION }));

    // No tick advanced: the very first paint must already be honest.
    const banner = screen.queryByTestId("session-sleep-banner");
    expect(banner?.textContent).toContain("30 min");
    expect(banner?.textContent).not.toContain("3 h");
  });

  it("clears its interval when the wake stops being pending", () => {
    // The wake row was claimed or cancelled while the banner was mounted: the
    // banner disappears AND stops ticking, rather than leaving a 1s timer
    // running against a deadline nobody is waiting for any more.
    mockUseRuntimeState.mockReturnValue(
      state({
        dueAt: "2026-07-30T20:57:00.000Z",
        reason: null,
        watchSummary: null,
      }),
    );
    const { rerender } = render(
      createElement(SessionSleepBanner, { sessionId: SESSION }),
    );
    expect(screen.queryByTestId("session-sleep-banner")).not.toBeNull();

    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    mockUseRuntimeState.mockReturnValue(state(undefined));
    rerender(createElement(SessionSleepBanner, { sessionId: SESSION }));

    expect(screen.queryByTestId("session-sleep-banner")).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });
});
