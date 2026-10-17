import { fireEvent, render, screen, within } from "@testing-library/react";
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

const actions = vi.hoisted(() => ({
  pin: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionsList: () => ({
    isLoading: false,
    data: { ok: true, data: harness.rows },
  }),
  useSetSessionPinned: () => ({
    isPending: false,
    variables: undefined,
    mutate: actions.pin,
  }),
  useRenameSession: () => ({
    isPending: false,
    mutate: actions.rename,
  }),
  useDeleteSession: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("../SessionDeleteDialog.js", () => ({
  SessionDeleteDialog: () => null,
}));

const { SessionsLibrary } = await import("../SessionsLibrary.js");

describe("SessionsLibrary search and filters", () => {
  beforeEach(() => {
    harness.listeners.clear();
    actions.pin.mockClear();
    actions.rename.mockClear();
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

  it("draws two-line rows: the title over the mode and permission, and a state word for a live mission", () => {
    harness.rows = [
      { ...makeRow("one", "Arbitrum LP Rebalance", "mission"), missionStatus: "running" },
      { ...makeRow("two", "Agent session", "agent"), permission: "full" },
    ];
    render(<SessionsLibrary />);

    const first = screen.getByRole("button", { name: /Arbitrum LP Rebalance/ });
    expect(within(first).getByText("Mission · Restricted")).toBeTruthy();
    expect(within(first).getByText("Running")).toBeTruthy();
    const second = screen.getByRole("button", { name: /Agent session/ });
    expect(within(second).getByText("Agent · Full access")).toBeTruthy();
    // No state, so the row shows its time only.
    expect(within(second).queryByText("Running")).toBeNull();
  });

  it("groups the register by day under 12 point heads and says how the keys work", () => {
    render(<SessionsLibrary />);

    expect(screen.getByRole("heading", { name: "Older" })).toBeTruthy();
    expect(
      screen.getByText(/Double click a title to rename it\./),
    ).toBeTruthy();
  });

  it("renames in place on a double click: Enter commits, Escape cancels, unchanged is a cancel", () => {
    render(<SessionsLibrary />);

    fireEvent.doubleClick(screen.getByRole("button", { name: /Token research/ }));
    const input = screen.getByRole("textbox", { name: "Rename session" });
    fireEvent.change(input, { target: { value: "  Token research v2  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.rename).toHaveBeenCalledWith({
      id: "three",
      name: "Token research v2",
    });
    expect(screen.queryByRole("textbox", { name: "Rename session" })).toBeNull();

    actions.rename.mockClear();
    fireEvent.doubleClick(screen.getByRole("button", { name: /Daily gas report/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename session" }), {
      target: { value: "Something else" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename session" }), {
      key: "Escape",
    });
    expect(actions.rename).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByRole("button", { name: /Daily gas report/ }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename session" }), {
      key: "Enter",
    });
    expect(actions.rename).not.toHaveBeenCalled();
  });

  it("pins from the row's own key without selecting the session", () => {
    render(<SessionsLibrary />);

    const [pinKey] = screen.getAllByRole("button", { name: "Pin session" });
    if (pinKey === undefined) throw new Error("no Pin session key in the register");
    fireEvent.click(pinKey);
    expect(actions.pin).toHaveBeenCalledWith({ id: "one", pinned: true });
    expect(harness.state?.activeSessionId).toBeNull();
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
