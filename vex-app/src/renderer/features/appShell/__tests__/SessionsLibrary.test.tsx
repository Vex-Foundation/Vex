import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { SessionModeFilter } from "../../../stores/uiStore.js";

interface MockStoreState {
  readonly activeSessionId: string | null;
  readonly sessionModeFilter: SessionModeFilter;
  readonly setActiveSessionId: (id: string | null) => void;
  readonly setShellRoute: (route: { readonly kind: string }) => void;
  readonly setSessionModeFilter: (filter: SessionModeFilter) => void;
}

const harness = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  rows: [] as SessionListItem[],
  state: null as MockStoreState | null,
}));

function publishState(next: MockStoreState): void {
  harness.state = next;
  for (const listener of harness.listeners) listener();
}

function resetStore(filter: SessionModeFilter = "all"): void {
  const makeState = (sessionModeFilter: SessionModeFilter): MockStoreState => ({
    activeSessionId: null,
    sessionModeFilter,
    setActiveSessionId: (activeSessionId) => {
      publishState({ ...makeState(sessionModeFilter), activeSessionId });
    },
    setShellRoute: () => {},
    setSessionModeFilter: (nextFilter) => {
      publishState(makeState(nextFilter));
    },
  });
  harness.state = makeState(filter);
}

vi.mock("../../../stores/uiStore.js", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useUiStore: <T,>(selector: (state: MockStoreState) => T): T =>
      useSyncExternalStore(
        (listener) => {
          harness.listeners.add(listener);
          return () => harness.listeners.delete(listener);
        },
        () => selector(harness.state!),
        () => selector(harness.state!),
      ),
  };
});

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionsList: () => ({
    isLoading: false,
    data: { ok: true, data: harness.rows },
  }),
  useSetSessionPinned: () => ({
    isPending: false,
    variables: undefined,
    mutate: vi.fn(),
  }),
  useDeleteSession: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("../SessionRows.js", () => ({
  SessionGroups: ({
    groups,
  }: {
    readonly groups: ReadonlyArray<{
      readonly rows: readonly SessionListItem[];
    }>;
  }) => (
    <ul aria-label="Filtered session rows">
      {groups.flatMap((group) => group.rows).map((row) => (
        <li key={row.id}>{row.title ?? row.initialGoal}</li>
      ))}
    </ul>
  ),
}));

vi.mock("../SessionDeleteDialog.js", () => ({
  SessionDeleteDialog: () => null,
}));

vi.mock("../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));

const { SessionsLibrary } = await import("../SessionsLibrary.js");

describe("SessionsLibrary search and filters", () => {
  beforeEach(() => {
    harness.listeners.clear();
    harness.rows = [
      makeRow("one", "Arbitrum LP Rebalance", "agent"),
      makeRow("two", "Daily gas report", "mission"),
      makeRow("three", "Token research", "agent"),
    ];
    resetStore();
  });

  it("focuses title search and filters the register with an accurate count", () => {
    render(<SessionsLibrary />);

    const search = screen.getByRole("searchbox", {
      name: "Search session titles",
    });
    expect(document.activeElement).toBe(search);
    expect(screen.getByText("3 sessions stored locally")).toBeTruthy();

    fireEvent.change(search, { target: { value: "gas" } });

    expect(screen.getByText("1 of 3 sessions")).toBeTruthy();
    expect(screen.getByText("Daily gas report")).toBeTruthy();
    expect(screen.queryByText("Arbitrum LP Rebalance")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect((search as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(screen.getByText("3 sessions stored locally")).toBeTruthy();
  });

  it("shows and updates the shared All / Agent / Mission filter", () => {
    resetStore("agent");
    render(<SessionsLibrary />);

    expect(
      screen.getByRole("button", { name: "Agent" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("2 of 3 sessions")).toBeTruthy();
    expect(screen.queryByText("Daily gas report")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Mission" }));

    expect(
      screen.getByRole("button", { name: "Mission" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("1 of 3 sessions")).toBeTruthy();
    expect(screen.getByText("Daily gas report")).toBeTruthy();
    expect(screen.queryByText("Token research")).toBeNull();
  });

  it("offers one reset action when search and mode filters have no results", () => {
    resetStore("mission");
    render(<SessionsLibrary />);

    const search = screen.getByRole("searchbox", {
      name: "Search session titles",
    });
    fireEvent.change(search, { target: { value: "arbitrum" } });

    expect(
      screen.getByText("No sessions match your current search and filters."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));

    expect((search as HTMLInputElement).value).toBe("");
    expect(
      screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("3 sessions stored locally")).toBeTruthy();
  });
});

function makeRow(
  id: string,
  title: string,
  mode: SessionListItem["mode"],
): SessionListItem {
  return {
    id,
    mode,
    permission: "restricted",
    title,
    initialGoal: null,
    startedAt: "2026-07-12T10:00:00.000Z",
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
  };
}
