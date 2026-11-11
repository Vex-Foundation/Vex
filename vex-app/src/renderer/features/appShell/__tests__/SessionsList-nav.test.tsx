/**
 * THE LEFT SIDEBAR (docs/design/R3-MINIMAL.md section 4), close range: the
 * nav and its selected row, the search mode and its tabs, the sessions by
 * name with their state words, and the 56px rail.
 *
 * The geometry half is pinned against the stylesheet, because jsdom lays
 * nothing out: at 1280 the left track is 224, and the V10 page content that
 * overlapped there (a fixed 300px page, a ticker, a filter row) is gone. No
 * rule in `left-sidebar.css` may set a width wider than the 224 track, and
 * the column itself fills its track and may shrink.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { LineIcon, type LineIconName } from "../../../components/icons/line/index.js";
import { useUiStore } from "../../../stores/uiStore.js";

const harness = vi.hoisted(() => ({
  rows: [] as SessionListItem[],
  enterLighter: vi.fn(),
}));

vi.mock("../../../lib/api/sessions.js", () => ({
  useSessionModel: () => ({ data: undefined }),
  useSessionsList: () => ({
    isLoading: false,
    isError: false,
    data: { ok: true, data: harness.rows },
  }),
  useSetSessionPinned: () => ({ isPending: false, variables: undefined, mutate: vi.fn() }),
  useDeleteSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRenameSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("../SessionDeleteDialog.js", () => ({ SessionDeleteDialog: () => null }));
vi.mock("../SidebarProfile.js", () => ({
  SidebarProfile: ({ sidebarOpen }: { readonly sidebarOpen: boolean }) => (
    <div data-testid="account" data-open={sidebarOpen ? "true" : "false"} />
  ),
}));
vi.mock("../lighterTrading/workspace-command.js", () => ({
  enterLighterMode: () => harness.enterLighter(),
}));

const { SessionsList } = await import("../SessionsList.js");

const NOW = new Date();
const today = (hour: number): string =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour).toISOString();

function row(over: Partial<SessionListItem>): SessionListItem {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    mode: "agent",
    permission: "restricted",
    title: "Agent session",
    initialGoal: null,
    startedAt: today(9),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...over,
  };
}

const ROWS: SessionListItem[] = [
  row({ id: "10000000-0000-4000-8000-000000000001", title: "Portfolio Check" }),
  row({
    id: "10000000-0000-4000-8000-000000000002",
    mode: "mission",
    title: "Arbitrum LP Rebalance",
    missionStatus: "running",
  }),
  row({
    id: "10000000-0000-4000-8000-000000000003",
    mode: "mission",
    title: "Open BTC Perp Position",
    missionStatus: "paused_user",
  }),
  row({
    id: "10000000-0000-4000-8000-000000000004",
    title: "Daily gas report",
    pinnedAt: today(8),
  }),
];

function renderSidebar(collapsed = false): {
  readonly onCreate: ReturnType<typeof vi.fn>;
  readonly onToggle: ReturnType<typeof vi.fn>;
  readonly rerender: (next: boolean) => void;
} {
  const onCreate = vi.fn();
  const onToggle = vi.fn();
  const view = render(
    <SessionsList onCreate={onCreate} collapsed={collapsed} onToggleSidebar={onToggle} />,
  );
  return {
    onCreate,
    onToggle,
    rerender: (next) =>
      view.rerender(
        <SessionsList onCreate={onCreate} collapsed={next} onToggleSidebar={onToggle} />,
      ),
  };
}

const nav = (): HTMLElement => screen.getByRole("navigation", { name: "Main" });
const navRow = (name: string): HTMLElement => within(nav()).getByRole("button", { name });

beforeEach(() => {
  harness.rows = ROWS;
  harness.enterLighter.mockReset();
  useUiStore.setState({
    runtimeMode: "agent",
    shellRoute: { kind: "none" },
    sessionModeFilter: "all",
    activeSessionId: null,
    signingState: "idle",
  });
});

describe("the nav", () => {
  it("lists Chat, Missions, Watchlist, Portfolio, Agent Scan, Lighter, Studio, Board and Settings, in order", () => {
    // docs/design/H3-DESKTOP.md section 4.6: H3's order, with desktop's own
    // page names where H3 says Markets and Activity (the owner's decision).
    // The words stay in sentence case in the source; the row's label style
    // sets the caps.
    renderSidebar();
    expect(within(nav()).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Chat",
      "Missions",
      "Watchlist",
      "Portfolio",
      "Agent Scan",
      "Lighter",
      "Studio",
      "Board",
      "Settings",
    ]);
    expect(navRow("Chat").getAttribute("aria-current")).toBe("page");
    for (const button of within(nav()).getAllByRole("button")) {
      expect(button.classList.contains("vex-ls-nrow--nav")).toBe(true);
    }
  });

  it("draws H3's nav glyphs, and desktop's own three in their line drawings", () => {
    // docs/design/H3-DESKTOP.md section 4.6 (S5-04).
    renderSidebar();
    const drawn = (name: string): string =>
      navRow(name).querySelector("svg")?.innerHTML ?? "missing";
    const glyph = (name: LineIconName): string => {
      const view = render(<LineIcon name={name} />);
      const markup = view.container.querySelector("svg")?.innerHTML ?? "";
      view.unmount();
      return markup;
    };
    const expected: readonly (readonly [string, LineIconName])[] = [
      ["Chat", "h3-chat"],
      ["Missions", "h3-missions"],
      ["Watchlist", "h3-markets"],
      ["Portfolio", "h3-portfolio"],
      ["Agent Scan", "h3-activity"],
      ["Lighter", "lighter"],
      ["Studio", "studio"],
      ["Board", "board"],
      ["Settings", "h3-settings"],
    ];
    for (const [row, name] of expected) expect(drawn(row), row).toBe(glyph(name));
    expect(
      screen.getByRole("button", { name: "New chat" }).querySelector("svg")?.innerHTML,
    ).toBe(glyph("h3-new-chat"));
  });

  it("Watchlist opens its page and Agent Scan its full feed", () => {
    renderSidebar();
    fireEvent.click(navRow("Watchlist"));
    expect(useUiStore.getState().shellRoute.kind).toBe("watchlist");
    expect(navRow("Watchlist").getAttribute("aria-current")).toBe("page");

    fireEvent.click(navRow("Agent Scan"));
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("agentScan");
    if (route.kind === "agentScan") expect(route.sessionId).toBeNull();
    expect(navRow("Agent Scan").getAttribute("aria-current")).toBe("page");
    expect(navRow("Portfolio").hasAttribute("aria-current")).toBe(false);
    // H3's own words for these two rows are not desktop's.
    expect(within(nav()).queryByRole("button", { name: "Markets" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Activity" })).toBeNull();
  });

  it("opens the page routes in the centre and moves the selected row with them", () => {
    renderSidebar();
    fireEvent.click(navRow("Portfolio"));
    expect(useUiStore.getState().shellRoute.kind).toBe("portfolio");
    expect(navRow("Portfolio").getAttribute("aria-current")).toBe("page");
    expect(navRow("Chat").hasAttribute("aria-current")).toBe(false);

    fireEvent.click(navRow("Board"));
    expect(useUiStore.getState().shellRoute.kind).toBe("board");

    fireEvent.click(navRow("Settings"));
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("settings");
    if (route.kind === "settings") expect(route.section).toBeNull();

    fireEvent.click(navRow("Chat"));
    expect(useUiStore.getState().shellRoute.kind).toBe("none");
    expect(navRow("Chat").getAttribute("aria-current")).toBe("page");
  });

  it("a chat clicked from a page opens in the centre and closes the page", () => {
    renderSidebar();
    fireEvent.click(navRow("Portfolio"));
    expect(useUiStore.getState().shellRoute.kind).toBe("portfolio");

    fireEvent.click(screen.getByText("Daily gas report"));

    expect(useUiStore.getState().activeSessionId).toBe("10000000-0000-4000-8000-000000000004");
    expect(useUiStore.getState().shellRoute.kind).toBe("none");
    expect(navRow("Chat").getAttribute("aria-current")).toBe("page");
  });

  it("switches to Studio, and enters Lighter through the desk's own command", () => {
    renderSidebar();
    fireEvent.click(navRow("Studio"));
    expect(useUiStore.getState().runtimeMode).toBe("studio");

    act(() => useUiStore.setState({ runtimeMode: "agent" }));
    fireEvent.click(navRow("Lighter"));
    expect(harness.enterLighter).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
  });

  it("Missions opens the search on its Mission tab and filters to missions", () => {
    renderSidebar();
    fireEvent.click(navRow("Missions"));
    expect(useUiStore.getState().sessionModeFilter).toBe("mission");
    expect(screen.getByRole("searchbox", { name: "Search chats" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Mission" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Arbitrum LP Rebalance")).not.toBeNull();
    expect(screen.queryByText("Portfolio Check")).toBeNull();
    // The way to start one stays above the list, named for what it starts.
    expect(screen.getByRole("button", { name: "New mission" })).not.toBeNull();

    // Escape brings back the sections; the Mission tab holds, so Missions
    // stays the selected row and the key still says New mission.
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search chats" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "New mission" })).not.toBeNull();
    expect(navRow("Missions").getAttribute("aria-current")).toBe("page");

    fireEvent.click(navRow("Chat"));
    expect(useUiStore.getState().sessionModeFilter).toBe("all");
    expect(screen.getByRole("button", { name: "New chat" })).not.toBeNull();
  });
});

describe("the selected nav row follows the real destination", () => {
  const MISSION_ID = "10000000-0000-4000-8000-000000000002";
  const AGENT_ID = "10000000-0000-4000-8000-000000000001";
  const selectedRows = (): readonly string[] =>
    within(nav())
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-current"))
      .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");

  it("a mission chat selects Missions, an agent chat selects Chat", () => {
    renderSidebar();
    act(() => useUiStore.setState({ activeSessionId: MISSION_ID }));
    expect(selectedRows()).toEqual(["Missions"]);
    expect(navRow("Missions").getAttribute("aria-current")).toBe("page");

    act(() => useUiStore.setState({ activeSessionId: AGENT_ID }));
    expect(selectedRows()).toEqual(["Chat"]);
  });

  it("a mission chat selects Missions on the rail too", () => {
    renderSidebar(true);
    act(() => useUiStore.setState({ activeSessionId: MISSION_ID }));
    expect(selectedRows()).toEqual(["Missions"]);
  });

  it("Memory, Sessions, How Vex works and Needs you select no row, whatever chat is open", () => {
    renderSidebar();
    act(() => useUiStore.setState({ activeSessionId: MISSION_ID }));
    for (const kind of ["memory", "sessions", "howItWorks", "needsYou"] as const) {
      act(() => useUiStore.setState({ shellRoute: { kind, origin: null } }));
      expect(selectedRows()).toEqual([]);
    }
    // And the row comes back with the page that leaves.
    act(() => useUiStore.setState({ shellRoute: { kind: "none" } }));
    expect(selectedRows()).toEqual(["Missions"]);
  });
});

describe("New chat and the search mode", () => {
  it("draws New chat and the Search chats field as the column's first two H3 cells", () => {
    // docs/design/H3-DESKTOP.md section 1.4: NEW CHAT on the cell fill, then
    // the field, always open (VEX Cloud's): no row that opens into it. Its
    // placeholder is the name a screen reader hears.
    renderSidebar();
    const body = document.querySelector(".vex-ls-body");
    const [first, second] = Array.from(body?.children ?? []);
    expect(first?.classList.contains("vex-ls-nrow--new")).toBe(true);
    expect(first?.textContent).toBe("New chat");
    expect(second?.classList.contains("vex-ls-search")).toBe(true);
    const field = within(second as HTMLElement).getByRole("searchbox", { name: "Search chats" });
    expect(field.getAttribute("placeholder")).toBe("Search chats");
    expect(screen.queryByRole("button", { name: "Search chats" })).toBeNull();
    // The nav stands under it until a query is typed.
    expect(nav()).not.toBeNull();
    // No Clear key while the field is empty, and no Esc keycap.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close search" })).toBeNull();
  });

  it("New chat opens the creator", () => {
    const { onCreate } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("a typed query brings the All, Agent and Mission tabs, counted, in the nav's place", () => {
    renderSidebar();
    const field = screen.getByRole("searchbox", { name: "Search chats" });
    field.focus();
    // A press or a focus alone moves nothing.
    expect(nav()).not.toBeNull();
    // "r" is in every title, so the counts are the whole list's.
    fireEvent.change(field, { target: { value: "r" } });
    // The field keeps its node and its focus as the mode comes in.
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toBe(field);
    expect(document.activeElement).toBe(field);
    // The nav makes way for the tabs; New chat stays above the field.
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).not.toBeNull();

    // "Chat", never "session", in every word a person reads (Appendix A.2).
    expect(screen.getByRole("tablist", { name: "Filter chats" })).not.toBeNull();
    const tabs = screen.getAllByRole("tab");
    // A tab's name is its word; the count beside it is decoration.
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(screen.getByRole("tab", { name: "All" }).textContent).toBe("All4");
    expect(screen.getByRole("tab", { name: "Agent" }).textContent).toBe("Agent2");
    expect(screen.getByRole("tab", { name: "Mission" }).textContent).toBe("Mission2");

    fireEvent.change(field, { target: { value: "btc" } });
    expect(screen.getByRole("tab", { name: "All" }).textContent).toBe("All1");
    expect(document.querySelector(".vex-ls-row__t mark")?.textContent).toBe("BTC");
    expect(screen.queryByText("Portfolio Check")).toBeNull();
    expect(screen.getByText(/Esc closes search/)).not.toBeNull();
  });

  it("Clear search stands only while there is a query, empties it and focuses the field", () => {
    const { onCreate } = renderSidebar();
    const field = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(field, { target: { value: "btc" } });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((field as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(field);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.getByText("Portfolio Check")).not.toBeNull();
  });

  it("Escape with a query clears it and keeps the focus; with an empty field it brings back the sections", () => {
    renderSidebar();
    const field = screen.getByRole("searchbox", { name: "Search chats" });
    field.focus();
    fireEvent.change(field, { target: { value: "btc" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(field);
    // Still in the search mode: the tabs hold until the empty field's Escape.
    expect(screen.getByRole("tablist", { name: "Filter chats" })).not.toBeNull();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(nav()).not.toBeNull();
  });

  it("Escape closes the search wherever the focus is, unless something else took it", () => {
    renderSidebar();
    fireEvent.click(navRow("Missions"));
    // The focus left the field for a tab.
    const tab = screen.getByRole("tab", { name: "Agent" });
    tab.focus();
    fireEvent.click(tab);
    // A key another surface already handled stays theirs.
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(screen.getByRole("tablist")).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(nav()).not.toBeNull();
  });

  it("the Agent tab leaves with the search, so the list is never filtered out of sight", () => {
    renderSidebar();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("tab", { name: "Agent" }));
    expect(useUiStore.getState().sessionModeFilter).toBe("agent");
    // The first Escape clears the query, the second leaves the search.
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(useUiStore.getState().sessionModeFilter).toBe("all");
    expect(screen.getByText("Arbitrum LP Rebalance")).not.toBeNull();
  });
});

describe("the search's result, spoken (VEX Cloud's chat-list.tsx)", () => {
  const announcer = (): HTMLElement | null =>
    document.querySelector<HTMLElement>("[data-vex-area='chats-search-announcer']");

  it("says how many chats a resting query found, politely, and names the results", () => {
    vi.useFakeTimers();
    try {
      renderSidebar();
      expect(announcer()?.getAttribute("aria-live")).toBe("polite");
      expect(announcer()?.textContent).toBe("");
      const field = screen.getByRole("searchbox", { name: "Search chats" });
      fireEvent.change(field, { target: { value: "btc" } });
      // Nothing while the query is still moving.
      expect(announcer()?.textContent).toBe("");
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(announcer()?.textContent).toBe("1 chat found");
      expect(screen.getByRole("group", { name: "Search results" })).not.toBeNull();

      fireEvent.change(field, { target: { value: "r" } });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(announcer()?.textContent).toBe("4 chats found");

      fireEvent.change(field, { target: { value: "zzz" } });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(announcer()?.textContent).toBe("No chats match your search.");

      // A cleared query says nothing, and the chats are no longer results.
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(announcer()?.textContent).toBe("");
      expect(screen.queryByRole("group", { name: "Search results" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks a new query that finds the same count again", () => {
    vi.useFakeTimers();
    try {
      renderSidebar();
      const field = screen.getByRole("searchbox", { name: "Search chats" });
      fireEvent.change(field, { target: { value: "btc" } });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      const first = announcer()?.textContent;
      fireEvent.change(field, { target: { value: "gas" } });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(announcer()?.textContent).not.toBe(first);
      expect(announcer()?.textContent?.trim()).toBe("1 chat found");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the sessions by name", () => {
  it("heads the list with CHATS, its groups one level under it", () => {
    // docs/design/H3-DESKTOP.md section 1.4: the CHATS heading, then the
    // groups; the words in sentence case, the caps from the class.
    renderSidebar();
    const chats = screen.getByRole("heading", { level: 2, name: "Chats" });
    expect(chats.classList.contains("vex-ls-chats")).toBe(true);
    // It stands above the scroller, so it stays while the list scrolls.
    expect(chats.nextElementSibling?.classList.contains("vex-ls-sessions")).toBe(true);
    expect(screen.getByRole("heading", { level: 3, name: "Pinned" })).not.toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Today" })).not.toBeNull();
    // The search mode heads its matches with the tabs instead.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a" } });
    expect(screen.queryByRole("heading", { name: "Chats" })).toBeNull();
  });

  it("groups them under Pinned and Today and speaks the mission states in words", () => {
    renderSidebar();
    expect(screen.getByRole("heading", { name: "Pinned" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Today" })).not.toBeNull();
    const running = screen.getByText("Arbitrum LP Rebalance").closest("[data-vex-ls-item]");
    expect(running?.querySelector(".vex-ls-row__state")?.textContent).toBe("Running");
    const paused = screen.getByText("Open BTC Perp Position").closest("[data-vex-ls-item]");
    expect(paused?.querySelector(".vex-ls-row__state")?.textContent).toBe("Paused");
    const plain = screen.getByText("Portfolio Check").closest("[data-vex-ls-item]");
    expect(plain?.querySelector(".vex-ls-row__time")).not.toBeNull();
  });

  it("selects a session by name, and the open one reads as current", () => {
    renderSidebar();
    fireEvent.click(screen.getByText("Portfolio Check"));
    expect(useUiStore.getState().activeSessionId).toBe("10000000-0000-4000-8000-000000000001");
    expect(
      screen.getByText("Portfolio Check").closest("button")?.getAttribute("aria-current"),
    ).toBe("true");
  });

  it("puts the account row at the foot, open", () => {
    renderSidebar();
    const foot = document.querySelector(".vex-ls-foot");
    expect(foot?.querySelector("[data-testid='account']")?.getAttribute("data-open")).toBe("true");
  });
});

describe("the rail", () => {
  it("keeps the Expand key, New chat, Search and the nav as named keys", () => {
    renderSidebar(true);
    const aside = document.querySelector("[data-vex-area='sessions-sidebar']");
    expect(aside?.getAttribute("data-vex-sidebar-open")).toBe("false");
    // The Expand key heads the rail; the old Chats key is gone.
    const keys = Array.from(aside?.querySelectorAll(".vex-ls-body button") ?? []);
    expect(keys[0]?.getAttribute("aria-label")).toBe("Expand sidebar");
    expect(screen.queryByRole("button", { name: "Chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" }).textContent).toBe("");
    expect(navRow("Portfolio").textContent).toBe("");
    expect(within(nav()).getAllByRole("button")).toHaveLength(9);
    // No session rows on the rail; the account is the box alone.
    expect(document.querySelector("[data-vex-ls-item]")).toBeNull();
    expect(screen.getByTestId("account").getAttribute("data-open")).toBe("false");
  });

  it("stacks the rail's H3 cells in the open column's order, with no stray rule or gap", () => {
    // docs/design/H3-DESKTOP.md sections 1.10 and 4.12 (S5-08): the Expand
    // key, NEW CHAT, Search chats, then the nav block, each a full-width cell.
    renderSidebar(true);
    const body = document.querySelector("[data-vex-area='sessions-sidebar'] .vex-ls-body");
    const cells = Array.from(body?.children ?? []).map((el) =>
      el.classList.contains("vex-ls-nav")
        ? "nav"
        : (Array.from(el.classList).find((c) => c.startsWith("vex-ls-nrow--")) ?? el.className),
    );
    expect(cells).toEqual(["vex-ls-nrow--expand", "vex-ls-nrow--new", "vex-ls-nrow--search", "nav"]);
    expect(document.querySelector(".vex-ls-rule, .vex-ls-gap")).toBeNull();
    expect(screen.getByRole("button", { name: "Search chats" }).textContent).toBe("");
  });

  it("opens the sidebar from the Expand key, and from Search straight into the field", () => {
    const { onToggle, rerender } = renderSidebar(true);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(onToggle).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
    rerender(false);
    // Opened, the column's field takes the focus; the sections stay.
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search chats" }));
    expect(nav()).not.toBeNull();
  });

  it("opens the sidebar on the list when Chat or Missions is pressed on the rail", () => {
    const { onToggle } = renderSidebar(true);
    fireEvent.click(navRow("Chat"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(navRow("Missions"));
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().sessionModeFilter).toBe("mission");
    // Elsewhere on the rail the nav never toggles.
    fireEvent.click(navRow("Portfolio"));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("never toggles from Chat on the open sidebar", () => {
    const { onToggle } = renderSidebar(false);
    fireEvent.click(navRow("Chat"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("on the Lighter desk's rail, has no Expand key and never opens", () => {
    const onToggle = vi.fn();
    render(
      <SessionsList onCreate={vi.fn()} collapsed expandable={false} onToggleSidebar={onToggle} />,
    );
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
    fireEvent.click(navRow("Chat"));
    fireEvent.click(navRow("Missions"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("the column fits its track at every seam", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(
    path.join(here, "..", "..", "..", "styles", "global-css", "left-sidebar.css"),
    "utf8",
  );

  it("steps its words up from 1920, since the column never zooms (VEX Cloud's left.css)", () => {
    const at = css.indexOf("@media (min-width: 1920px) {");
    expect(at).toBeGreaterThan(-1);
    const wide = css.slice(at, css.indexOf("\n}\n", at));
    const sizeOf = (selectors: string): string =>
      new RegExp(`${selectors.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{\\s*font-size: (\\d+)px;`).exec(wide)?.[1] ?? "none";
    expect(sizeOf(".vex-ls-nrow--new,\n  .vex-ls-nrow--nav")).toBe("14");
    expect(sizeOf(".vex-ls-group,\n  .vex-ls-row__state,\n  .vex-ls-row__time")).toBe("12");
    expect(sizeOf(".vex-ls-row__select,\n  .vex-ls-search__input")).toBe("15");
    // The block follows the base sizes, so it wins on order.
    expect(at).toBeGreaterThan(css.indexOf(".vex-ls-row__time {"));
    expect(at).toBeGreaterThan(css.indexOf(".vex-ls-search__input {"));
  });

  it("fills its track and may shrink below its content", () => {
    const block = /\.vex-ls \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/width: 100%;/);
    expect(block).toMatch(/min-width: 0;/);
  });

  it("sets no width wider than the 224px medium track", () => {
    const widths = Array.from(css.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)).map(
      (m) => Number(m[1]),
    );
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.filter((w) => w > 224)).toEqual([]);
  });

  it("truncates every name and label instead of pushing past the edge", () => {
    for (const selector of [".vex-ls-row__t", ".vex-ls-nrow__label"]) {
      const at = css.indexOf(`${selector} {`);
      expect(at, `${selector} has a rule`).toBeGreaterThan(-1);
      const block = css.slice(at, css.indexOf("}", at));
      expect(block).toMatch(/text-overflow: ellipsis/);
      expect(block).toMatch(/min-width: 0/);
    }
  });
});
