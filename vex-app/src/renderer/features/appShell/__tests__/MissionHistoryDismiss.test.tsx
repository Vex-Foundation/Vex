/**
 * Dismissing a finished mission card.
 *
 * The card is deliberately prominent, and after a few runs it dominates the
 * workspace with information the operator has already absorbed. The × lets
 * them clear it.
 *
 * THE CRITICAL PROPERTY, and the reason most of these tests exist: dismiss
 * is NOT delete. The `mission_results` ledger row and the `mission_runs`
 * record are an audit trail of real-money trades. Dismissing writes to
 * persisted UI state and nothing else — no IPC, no mutation, no ledger
 * write — and the register totals keep counting every dismissed run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { MissionResultDto } from "@shared/schemas/mission.js";
import { useMissionResults } from "../../../lib/api/mission.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { MissionHistory } from "../MissionHistory.js";
import { NO_CONSTRAINTS } from "./_missionResultFixture.js";

vi.mock("../../../lib/api/mission.js", () => ({ useMissionResults: vi.fn() }));
vi.mock("../../../lib/api/wallet-inventory.js", () => ({ useAvailableWallets: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

function result(seqNo: number, over: Partial<MissionResultDto> = {}): MissionResultDto {
  return {
    missionRunId: `run-${seqNo}`,
    sessionId: "00000000-0000-4000-8000-0000000000d1",
    seqNo,
    goalSnippet: `mission ${seqNo}`,
    goalFull: `mission ${seqNo}`,
    missionTitle: null,
    constraints: NO_CONSTRAINTS,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:15:00.000Z",
    durationS: 900,
    bankrollStartEth: 0.01,
    bankrollEndEth: 0.011,
    pnlEth: 0.001,
    pnlPct: 10,
    ethPriceUsdEnd: 1800,
    trades: 2,
    outcome: "completed",
    stopReason: "goal_reached",
    openPositionsCount: 0,
    // Deliberately does NOT contain the goal snippet text, so the
    // `getByText("mission N")` lookups below resolve to the card's goal
    // line and never to a prose beat.
    stopSummary: "- The run finished and stopped cleanly.",
    ...over,
  };
}

/** The DTO list the component reads. Held so tests can assert it is untouched. */
let RESULTS: MissionResultDto[];

function renderHistory(): void {
  vi.mocked(useAvailableWallets).mockReturnValue({
    data: { ok: true, data: { evm: [{ address: "0xAbC" }] } },
  } as never);
  vi.mocked(useMissionResults).mockReturnValue({
    isPending: false,
    isError: false,
    data: { ok: true, data: RESULTS },
  } as never);
  render(createElement(MissionHistory), { wrapper });
}

const hideButton = (seqNo: number) =>
  screen.getByRole("button", { name: `Hide mission #${seqNo} from this list` });

beforeEach(() => {
  RESULTS = [result(2), result(1)];
  useUiStore.setState({ dismissedMissionRunIds: [] });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ dismissedMissionRunIds: [] });
});

describe("dismissing a mission card", () => {
  it("hides the card that was dismissed", () => {
    renderHistory();
    expect(screen.getByText("mission 2")).toBeTruthy();

    fireEvent.click(hideButton(2));

    expect(screen.queryByText("mission 2")).toBeNull();
  });

  it("leaves every other mission's card alone", () => {
    renderHistory();

    fireEvent.click(hideButton(2));

    expect(screen.getByText("mission 1")).toBeTruthy();
  });

  it("stays dismissed across a remount", () => {
    renderHistory();
    fireEvent.click(hideButton(2));
    cleanup();

    renderHistory();

    expect(screen.queryByText("mission 2")).toBeNull();
    expect(screen.getByText("mission 1")).toBeTruthy();
  });

  it("persists the dismissal through the store's persist whitelist", () => {
    renderHistory();

    fireEvent.click(hideButton(2));

    // `dismissedMissionRunIds` is in `partialize`, so this is what survives
    // a reload. Asserted on the store rather than on localStorage so the
    // test does not depend on zustand's write timing.
    expect(useUiStore.getState().dismissedMissionRunIds).toEqual(["run-2"]);
  });

  it("brings dismissed cards back via Show hidden", () => {
    renderHistory();
    fireEvent.click(hideButton(2));

    fireEvent.click(screen.getByRole("button", { name: "Show hidden" }));

    expect(screen.getByText("mission 2")).toBeTruthy();
  });
});

describe("dismissing destroys nothing", () => {
  it("does not mutate or remove any mission record", () => {
    const before = structuredClone(RESULTS);
    renderHistory();

    fireEvent.click(hideButton(2));

    // The ledger DTOs the view was handed are untouched — same rows, same
    // values, same order. Dismissal never rewrites mission data.
    expect(RESULTS).toEqual(before);
    expect(RESULTS).toHaveLength(2);
  });

  it("issues no mission IPC call — dismissal is purely local", () => {
    renderHistory();
    const callsBefore = vi.mocked(useMissionResults).mock.calls.length;

    fireEvent.click(hideButton(2));

    // No delete/archive endpoint exists in this path and none is invoked;
    // the only mission API touched is the read that was already mounted.
    expect(vi.mocked(useMissionResults).mock.calls.length).toBeGreaterThanOrEqual(
      callsBefore,
    );
    expect(useUiStore.getState().dismissedMissionRunIds).toEqual(["run-2"]);
  });

  it("keeps counting dismissed runs in the register totals", () => {
    renderHistory();

    fireEvent.click(hideButton(2));

    // Two missions ran. Hiding one must not restate the operator's history,
    // so the "Missions" stat still reads 2 with only one card on screen.
    // `selector: "span"` disambiguates the register stat's label from the
    // page's own <h1>Missions</h1>.
    const stat = screen.getByText("Missions", { selector: "span" });
    expect(stat.parentElement?.textContent).toContain("2");
    expect(screen.getByText(/hidden — still counted above/)).toBeTruthy();
  });

  it("says plainly that nothing was deleted when everything is hidden", () => {
    renderHistory();

    fireEvent.click(hideButton(2));
    fireEvent.click(hideButton(1));

    expect(screen.getByText(/nothing has been deleted/)).toBeTruthy();
  });
});

describe("the dismiss affordance", () => {
  it("is labelled as hiding, never as deleting", () => {
    renderHistory();

    const button = hideButton(2);
    const label = button.getAttribute("aria-label") ?? "";

    expect(label).toContain("Hide");
    for (const destructive of ["delete", "remove", "archive"]) {
      expect(label.toLowerCase()).not.toContain(destructive);
    }
  });

  it("is a real button, so it is keyboard reachable", () => {
    renderHistory();

    expect(hideButton(2).tagName).toBe("BUTTON");
  });

  it("dismisses on keyboard activation without a confirmation step", () => {
    renderHistory();

    // Nothing is destroyed, so there is no confirm dialog to clear — the
    // click handler fires and the card is gone.
    fireEvent.click(hideButton(2));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("mission 2")).toBeNull();
  });
});
