/**
 * ArenaCampaignNotice - the welcome screen's way into the Lighter desk during
 * the Perps Trading Arena. The phase comes from a frozen clock; the button
 * pins the desk to Robinhood Chain and enters Lighter mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  ArenaCampaignNotice,
  __resetArenaNoticeDismissalForTests,
} from "../ArenaCampaignNotice.js";
import { arenaCampaignPhase } from "../lighterTrading/arena-campaign.js";

beforeEach(() => {
  vi.useFakeTimers();
  __resetArenaNoticeDismissalForTests();
  useUiStore.setState({ runtimeMode: "agent", activeSessionId: null });
  useLighterAnalysisStore.getState().saveDesk({ environment: "core" });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("arenaCampaignPhase", () => {
  it("is upcoming before Sep 18 11:00 UTC, live until Oct 16 11:00 UTC, then over", () => {
    expect(arenaCampaignPhase(new Date("2026-09-18T10:59:59Z"))).toBe("upcoming");
    expect(arenaCampaignPhase(new Date("2026-09-18T11:00:00Z"))).toBe("live");
    expect(arenaCampaignPhase(new Date("2026-10-16T10:59:59Z"))).toBe("live");
    expect(arenaCampaignPhase(new Date("2026-10-16T11:00:00Z"))).toBe("over");
  });
});

describe("ArenaCampaignNotice", () => {
  it("updates event status while the welcome screen stays open", () => {
    vi.setSystemTime(new Date("2026-09-18T10:59:30Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByText("Upcoming event")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Perps Trading Arena" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Live now")).toBeTruthy();
    expect(screen.getByRole("status").dataset["phase"]).toBe("live");
  });
  it("announces the start before the window opens", () => {
    vi.setSystemTime(new Date("2026-09-17T17:30:00Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status").textContent).toContain(
      "Starts Sep 18",
    );
    expect(screen.getByRole("status").dataset["phase"]).toBe("upcoming");
  });

  it("says live through the end day while the window is open", () => {
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status").textContent).toContain(
      "Ends Oct 16",
    );
  });

  it("shows the blinking live dot only while the window is open", () => {
    vi.setSystemTime(new Date("2026-09-17T17:30:00Z"));
    const { container, rerender } = render(<ArenaCampaignNotice />);
    expect(container.querySelector(".vex-live-dot")).toBeNull();
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    rerender(<ArenaCampaignNotice key="live" />);
    expect(container.querySelector(".vex-live-dot")).not.toBeNull();
  });

  it("advertises the reward pool while the campaign runs", () => {
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status").textContent).toContain(
      "Rewards: Up to 5,000 USDC",
    );
  });

  it("drops the reward pill once the campaign closes", () => {
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status").textContent).not.toContain("Rewards:");
  });

  it("becomes a permanent Lighter entry once the campaign closes", () => {
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status").textContent).toContain(
      "Live markets · Vex analysis · Orders you approve",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Lighter" }));
    expect(useLighterAnalysisStore.getState().desk.environment).toBe("core");
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
  });

  it("Enter with Vex pins the venue to Robinhood Chain and enters Lighter mode", () => {
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    render(<ArenaCampaignNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Enter with Vex" }));
    expect(useLighterAnalysisStore.getState().desk.environment).toBe("rhc");
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
  });

  it("Dismiss hides the card for the session but returns after a reboot", () => {
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    const { unmount } = render(<ArenaCampaignNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    unmount();
    render(<ArenaCampaignNotice />);
    expect(screen.queryByRole("status")).toBeNull();
    unmount();
    __resetArenaNoticeDismissalForTests(); // the next app reboot starts fresh
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
