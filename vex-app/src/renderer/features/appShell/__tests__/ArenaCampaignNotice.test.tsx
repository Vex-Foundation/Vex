/**
 * ArenaCampaignNotice - the welcome screen's way into the Lighter desk during
 * the Perps Trading Arena. The phase comes from a frozen clock; the button
 * pins the desk to Robinhood Chain and enters Lighter mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { ArenaCampaignNotice } from "../ArenaCampaignNotice.js";
import { arenaCampaignPhase } from "../lighterTrading/arena-campaign.js";

beforeEach(() => {
  vi.useFakeTimers();
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
  it("announces the start before the window opens", () => {
    vi.setSystemTime(new Date("2026-09-17T17:30:00Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status").textContent).toContain(
      "Perps Trading Arena starts Sep 18, 11:00 UTC, on Lighter Robinhood Chain.",
    );
    expect(screen.getByRole("status").dataset["phase"]).toBe("upcoming");
  });

  it("says live through the end day while the window is open", () => {
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    render(<ArenaCampaignNotice />);
    expect(screen.getByRole("status").textContent).toContain(
      "Perps Trading Arena is live on Lighter Robinhood Chain through Oct 16.",
    );
  });

  it("renders nothing once the window has closed", () => {
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    const { container } = render(<ArenaCampaignNotice />);
    expect(container.firstChild).toBeNull();
  });

  it("Open the desk pins the venue to Robinhood Chain and enters Lighter mode", () => {
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    render(<ArenaCampaignNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Open the desk" }));
    expect(useLighterAnalysisStore.getState().desk.environment).toBe("rhc");
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
  });
});
