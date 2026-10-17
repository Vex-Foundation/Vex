import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { greetingPoolForHour } from "../../../../lib/greeting.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEngineBridgeStub } from "../../../../test/engine-bridge-stub.js";
import type { Result } from "@shared/ipc/result.js";
import type {
  ChatSubmitInput,
  ChatSubmitResult,
} from "@shared/schemas/chat.js";
import type { AbortableInvocation } from "@shared/types/bridge/common.js";
import type {
  SessionCreateInput,
  SessionDeleteResult,
  SessionListItem,
} from "@shared/schemas/sessions.js";
import type { HealthReport } from "@shared/schemas/system.js";
import type { UserProfile } from "@shared/schemas/user-profile.js";
import { sessionKeys } from "../../../../lib/api/sessions.js";
import { createQueryClient } from "../../../../app/queryClient.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { SPREAD_TEST_WIDTH, setWindowWidth } from "./_appshell-render.js";

// Phase 2b: the Settings ShellScreen hosts the wizard step forms, whose
// module graph (icons, RHF, brand marks) is far beyond this suite's
// partial mocks. The screen has its own suite; a stub keeps THIS suite's
// AppShell import light.
// `screenFault.on` makes the stub throw while rendering: the centre boundary
// test below needs a page that fails.
const screenFault = vi.hoisted(() => ({ on: false }));
vi.mock("../../screens/SettingsScreen.js", () => ({
  SettingsScreen: () => {
    if (screenFault.on) throw new Error("settings page fault");
    return null;
  },
}));

// Same reason: the Agent Scan ShellScreen pulls the virtualizer and the whole
// agent-scan feed module graph. This suite asserts the menu ROUTE, not the
// screen — Agent Scan has its own suite.
vi.mock("../../screens/AgentScanScreen.js", () => ({
  AgentScanScreen: () => null,
}));

vi.mock("../../lighterTrading/LighterCenter.js", () => ({
  LighterCenter: ({ zenMode }: { readonly zenMode: boolean }) => (
    <div data-testid="lighter-center" data-zen-mode={zenMode ? "true" : undefined} />
  ),
}));

vi.mock("../../lighterTrading/LighterSidebar.js", () => ({
  LighterSidebar: ({
    collapsed,
    onToggleSidebar,
    zenMode,
    zenAssistantOpen,
    zenControlsOpen,
    onToggleZen,
    onToggleZenControls,
    onToggleZenAssistant,
  }: {
    readonly collapsed: boolean;
    readonly onToggleSidebar: () => void;
    readonly zenMode: boolean;
    readonly zenAssistantOpen: boolean;
    readonly zenControlsOpen: boolean;
    readonly onToggleZen: () => void;
    readonly onToggleZenControls: () => void;
    readonly onToggleZenAssistant: () => void;
  }) => (
    <aside
      data-vex-area="lighter-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
    >
      <button
        type="button"
        aria-label={collapsed ? "Open markets and sessions" : "Close markets and sessions"}
        onClick={onToggleSidebar}
      />
      {!zenMode ? (
        <button
          type="button"
          aria-label="Enter Zen Mode"
          onClick={onToggleZen}
        />
      ) : !zenControlsOpen ? (
        <button type="button" aria-label="Show Zen controls" onClick={onToggleZenControls} />
      ) : (
        <>
          <button type="button" aria-label="Exit Zen Mode" onClick={onToggleZen} />
          <button type="button" aria-label="Hide Zen controls" onClick={onToggleZenControls} />
          <button
            type="button"
            aria-label={zenAssistantOpen ? "Close Vex" : "Ask Vex"}
            onClick={onToggleZenAssistant}
          />
        </>
      )}
    </aside>
  ),
}));

// Every brand mark stubs to null, whatever its name: the marks are
// presentation-only here, and a hand-listed mock breaks the whole suite
// file each time a component references a new mark.
vi.mock("@thesvg/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thesvg/react")>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, () => null]));
});

// Stage 4: the always-mounted BookPanel renders SessionRuntimeBar (in the
// RUNTIME & COST block) → ModelBrandIcon, which statically imports ~20 brand
// icons from "@thesvg/react". Mock the component so this suite's partial
// @thesvg mock (AppShell.tsx's own icons) stays sufficient and the runtime
// bar's model-name path is isolated from the icon lib.
vi.mock("../../../wizard/steps/provider/ModelBrandIcon.js", () => ({
  ModelBrandIcon: () => null,
}));

const { AppShell } = await import("../../AppShell.js");

const sessionsListMock = vi.fn<() => Promise<Result<readonly SessionListItem[]>>>();
const sessionsGetMock = vi.fn<
  (input: { readonly id: string }) => Promise<Result<SessionListItem | null>>
>();
const sessionsCreateMock = vi.fn<
  (input: SessionCreateInput) => Promise<Result<SessionListItem>>
>();
const sessionsSetPinnedMock = vi.fn<
  (input: { readonly id: string; readonly pinned: boolean }) => Promise<Result<SessionListItem | null>>
>();
const sessionsDeleteMock = vi.fn<
  (input: { readonly id: string }) => Promise<Result<SessionDeleteResult>>
>();
const chatSubmitMock = vi.fn<
  (input: ChatSubmitInput) => AbortableInvocation<ChatSubmitResult>
>();
const healthMock = vi.fn<() => Promise<Result<HealthReport>>>();
const getUserProfileMock = vi.fn<() => Promise<Result<UserProfile>>>();
const setUserProfileMock = vi.fn<(profile: UserProfile) => Promise<Result<UserProfile>>>();
const messagesListMock = vi.fn();
const shellBackdropReadMock = vi.fn();
const missionGetDraftMock = vi.fn();
const runtimeGetStateMock = vi.fn();
let reducedMotion = false;
const motionChanges = new EventTarget();
const originalMatchMedia = window.matchMedia;

afterAll(() => { window.matchMedia = originalMatchMedia; });

beforeAll(() => {
  window.matchMedia = (query) => ({
    get matches() { return query === "(prefers-reduced-motion: reduce)" && reducedMotion; },
    media: query,
    onchange: null,
    addEventListener: motionChanges.addEventListener.bind(motionChanges),
    removeEventListener: motionChanges.removeEventListener.bind(motionChanges),
    dispatchEvent: motionChanges.dispatchEvent.bind(motionChanges),
    addListener: () => {},
    removeListener: () => {},
  });
  // jsdom does not implement ResizeObserver, which SessionsList uses for
  // fit-to-height. The component's effect feature-detects it, so without a
  // stub it just leaves containerHeight at 0 (the planned fallback) — but
  // a stub keeps test failures honest if we ever assert on observed sizes.
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverPolyfill {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
      ResizeObserverPolyfill as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  // The reference window (docs/design/R3-MINIMAL.md section 2): jsdom's own
  // 1024 is under the medium tier, where the left sidebar is its rail.
  setWindowWidth(SPREAD_TEST_WIDTH);
  reducedMotion = false;
  window.localStorage.clear();
  sessionsListMock.mockReset();
  sessionsGetMock.mockReset();
  sessionsCreateMock.mockReset();
  sessionsSetPinnedMock.mockReset();
  sessionsDeleteMock.mockReset();
  chatSubmitMock.mockReset();
  healthMock.mockReset();
  getUserProfileMock.mockReset();
  setUserProfileMock.mockReset();
  missionGetDraftMock.mockReset();
  runtimeGetStateMock.mockReset();
  // SessionComposer queries mission.getDraft + runtime.getState as soon as a
  // session is active (Send gate moved to activeSessionId). Benign defaults:
  // no draft, no run status (free text allowed).
  missionGetDraftMock.mockResolvedValue({ ok: true, data: null });
  runtimeGetStateMock.mockResolvedValue({ ok: true, data: { status: null } });
  useUiStore.setState({
    theme: "chronos",
    sidebarOpen: true,
    leftOpen: true,
    vexOpenChat: true,
    vexOpenPages: false,
    vexOpenLighter: false,
    showAvatar: true,
    sidebarNarrowExpanded: false,
    currentView: "appShell",
    wizardEntryMode: "setup",
    unlockReturnView: "appShell",
    logBuffer: [],
    sessionModeFilter: "all",
    activeSessionId: null,
    shellRoute: { kind: "none" },
    createSessionOpen: false,
    createSessionInitialTurn: null,
  });
  sessionsListMock.mockResolvedValue({ ok: true, data: [] });
  sessionsGetMock.mockResolvedValue({ ok: true, data: null });
  sessionsCreateMock.mockImplementation(async (input) => {
    const row: SessionListItem = {
      id: "a6bf4f85-e645-4df7-9bc5-70ec2eb0bd51",
      mode: input.mode,
      permission: input.permission,
      title: input.name,
      initialGoal: null,
      startedAt: localIsoDaysAgo(0),
      endedAt: null,
      missionStatus: null,
      pinnedAt: null,
    };
    return { ok: true, data: row };
  });
  sessionsSetPinnedMock.mockImplementation(async ({ id, pinned }) => {
    return {
      ok: true,
      data: {
        id,
        mode: "agent",
        permission: "restricted",
        title: "Pinned row",
        initialGoal: null,
        startedAt: localIsoDaysAgo(0),
        endedAt: null,
        missionStatus: null,
        pinnedAt: pinned ? new Date().toISOString() : null,
      },
    };
  });
  sessionsDeleteMock.mockResolvedValue({ ok: true, data: { outcome: "removed" } });
  chatSubmitMock.mockReturnValue({
    promise: Promise.resolve({
      ok: true,
      data: {
        text: "Message sent.",
        toolCallsMade: 0,
        pendingApprovals: [],
        stopReason: null,
        missionStatus: null,
        treatedAsInitialGoal: false,
      },
    }),
    cancel: vi.fn(),
  });
  healthMock.mockResolvedValue({ ok: true, data: makeHealthReport("ok") });
  // Chronos: SidebarProfile reads the "Vex setup" user profile to decide the
  // name-line ask vs. the saved displayName. Default = no profile saved yet.
  getUserProfileMock.mockResolvedValue({
    ok: true,
    data: { displayName: null, instructionsMd: null, workDescription: null },
  });
  messagesListMock.mockResolvedValue({
    ok: true,
    data: { items: [], nextCursor: null, hasMore: false },
  });
  shellBackdropReadMock.mockReset();
  shellBackdropReadMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      sessions: {
        list: sessionsListMock,
        get: sessionsGetMock,
        create: sessionsCreateMock,
        setPinned: sessionsSetPinnedMock,
        delete: sessionsDeleteMock,
      },
      chat: {
        submit: chatSubmitMock,
      },
      mission: {
        getDraft: missionGetDraftMock,
      },
      runtime: {
        getState: runtimeGetStateMock,
      },
      system: {
        health: healthMock,
      },
      settings: {
        getUserProfile: getUserProfileMock,
        setUserProfile: setUserProfileMock,
      },
      // Stage 8-2b: a selected-session SessionPanel mounts SessionTranscript,
      // which pages through window.vex.messages.list. Default = empty page.
      messages: {
        list: messagesListMock,
      },
      // Agent integration puzzle 2/09 + F5: SessionPanel mounts the engine
      // live-sync hooks, which subscribe to the engine bridge. The shared stub
      // supplies the FULL bridge surface, so adding a subscriber does not
      // break every AppShell test at once.
      engine: makeEngineBridgeStub(),
      // T1: the sidebar mounts VexTokenCardCompact → useVexMarket reads
      // getVexSnapshot + subscribes onVexUpdate. Stubs keep the widget in its
      // loading state without a live market feed.
      market: {
        getVexSnapshot: () => Promise.resolve({ ok: true, data: null }),
        onVexUpdate: () => () => {},
      },
      // Chronos: the SidebarProfile menu gates its Memory entry on the
      // capabilities feature flag.
      capabilities: {
        get: () =>
          Promise.resolve({ ok: true, data: { features: { memory: true } } }),
      },
      // The Vex sidebar's plate reads the user's own image once per mount.
      // Default = none set, so the shipped print paints.
      shellBackdrop: {
        read: shellBackdropReadMock,
      },
    },
  });
});

describe("AppShell", () => {
  it("renders the Vex shell hero and the profile footer with the night-shift hallmark", async () => {
    renderShell();

    // The rebrand hero headline is back (accepted mockup, 2026-08-20,
    // greeting form), pinned close-range in SessionWelcomeHero.test.tsx.
    expect(
      screen.getByRole("heading", {
        name: (accessibleName: string) =>
          greetingPoolForHour(new Date().getHours()).some(
            (variant) =>
              !variant.withName && variant.text === accessibleName,
          ),
      }),
    ).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /New chat/i }).length).toBeGreaterThan(0);
    // Healthy runtime → the profile subtitle speaks the Chronos hallmark.
    await screen.findByText("The night shift is active.");
    // The bare version stamp lives in the SESSION rail's collapse header;
    // on the welcome stage the right edge is the floating Portfolio tab
    // (no version chrome) and the hero carries only the eyebrow tooltip.
    expect(screen.queryByText("v0.0.0-test")).toBeNull();
    expect(screen.queryByText(/^PREVIEW · v/)).toBeNull();
  });

  it("profile menu carries seven actions including Lock Vex", async () => {
    renderShell();
    await screen.findByText("The night shift is active.");

    fireEvent.click(screen.getByRole("button", { name: /Open menu/i }));
    // The status row speaks ONE short word (the long RuntimeLedger strings
    // are retired), beside the Docker/Postgres marks.
    expect(screen.getByText("Connected")).not.toBeNull();
    expect(screen.queryByText("Connected to local runtime")).toBeNull();

    // The profile actions each carry a hint subline. The
    // Missions entry/screen is retired (owner: Sessions covers it); Agent Scan
    // sits between Sessions and How Vex works.
    for (const entry of [
      "Personalize",
      "Memory",
      "Sessions",
      "Agent Scan",
      "How Vex works",
      "Settings",
      "Lock Vex",
    ]) {
      expect(
        screen.getByRole("menuitem", { name: new RegExp(entry, "i") }),
      ).not.toBeNull();
    }
    // Seven ACTION entries; the runtime provenance row rides the menu footer
    // as a disabled (non-actionable) row.
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems.filter((item) => !item.hasAttribute("disabled"))).toHaveLength(7);
    expect(menuItems).toHaveLength(8);
    expect(screen.queryByRole("menuitem", { name: /Missions/i })).toBeNull();
    expect(screen.queryByText("Results ledger")).toBeNull();
    expect(screen.getByText("What Vex has learned")).not.toBeNull();
    expect(screen.getByText("Find any conversation")).not.toBeNull();
    expect(screen.getByText("Every move, verified on-chain")).not.toBeNull();
    expect(screen.getByText("Start here - the five-minute tour")).not.toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: /^Memory/i }));
    expect(useUiStore.getState().shellRoute.kind).toBe("memory");
    useUiStore.getState().setShellRoute({ kind: "none" });

    // Agent Scan opens its own full-app ShellScreen, expanding from the row.
    fireEvent.click(screen.getByRole("button", { name: /Open menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Agent Scan/i }));
    expect(useUiStore.getState().shellRoute.kind).toBe("agentScan");
    useUiStore.getState().setShellRoute({ kind: "none" });

    // Settings opens the in-shell Settings ShellScreen (Phase 2b — the
    // reconfigure-wizard door is retired): the route carries the row's
    // rect origin and a null section (the landing register), and the
    // view machine never leaves the shell.
    fireEvent.click(screen.getByRole("button", { name: /Open menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Settings/i }));
    const settingsRoute = useUiStore.getState().shellRoute;
    expect(settingsRoute.kind).toBe("settings");
    if (settingsRoute.kind !== "settings") throw new Error("route kind mismatch");
    expect(settingsRoute.section).toBeNull();
    expect(useUiStore.getState().currentView).not.toBe("wizard");
    useUiStore.getState().setShellRoute({ kind: "none" });
  });

  it.each(["Escape", "outside", "selection"])("profile menu retains an inert exit after %s until its own animation ends", async (dismissal) => {
    renderShell();
    await screen.findByText("The night shift is active.");
    const trigger = screen.getByRole("button", { name: /Open menu/i });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu.classList.contains("vex-profile-menu")).toBe(true);
    expect(menu.getAttribute("data-state")).toBe("open");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger);

    if (dismissal === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (dismissal === "outside") fireEvent.pointerDown(document.body);
    else {
      fireEvent.click(screen.getByRole("menuitem", { name: /Settings/i }));
      expect(useUiStore.getState().shellRoute.kind).toBe("settings");
    }
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(menu.isConnected).toBe(true);
    expect(menu.getAttribute("data-state")).toBe("closing");
    expect(menu.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    finishMenuAnimation(menu, "vex-profile-menu-enter");
    const menuButton = menu.querySelector("button");
    if (menuButton === null) throw new Error("The retained menu has no button");
    finishMenuAnimation(menuButton);
    expect(menu.isConnected).toBe(true);
    finishMenuAnimation(menu);
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("reopening the profile menu cancels an exit without a stale event closing it", async () => {
    renderShell();
    await screen.findByText("The night shift is active.");
    const trigger = screen.getByRole("button", { name: /Open menu/i });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    fireEvent.click(trigger);
    expect(menu.getAttribute("data-state")).toBe("closing");
    fireEvent.click(trigger);
    finishMenuAnimation(menu);
    expect(screen.getByRole("menu")).toBe(menu);
    expect(menu.hasAttribute("inert")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens and removes the profile menu immediately with reduced motion", async () => {
    reducedMotion = true;
    renderShell();
    await screen.findByText("The night shift is active.");
    const trigger = screen.getByRole("button", { name: /Open menu/i });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    fireEvent.click(trigger);
    expect(menu.isConnected).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("removes a closing profile menu when reduced motion becomes active", async () => {
    renderShell();
    await screen.findByText("The night shift is active.");
    const trigger = screen.getByRole("button", { name: /Open menu/i });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    fireEvent.click(trigger);
    expect(menu.isConnected).toBe(true);
    act(() => {
      reducedMotion = true;
      motionChanges.dispatchEvent(new Event("change"));
    });
    expect(menu.isConnected).toBe(false);
  });

  it("Sessions menu entry opens the Sessions screen mounting the sessions library", async () => {
    renderShell();
    await screen.findByText("The night shift is active.");

    fireEvent.click(screen.getByRole("button", { name: /Open menu/i }));
    // Accessible row name = label + hint subline, so anchor on the label.
    fireEvent.click(screen.getByRole("menuitem", { name: /^Sessions/i }));

    expect(useUiStore.getState().shellRoute.kind).toBe("sessions");
    // The full-app screen chrome + the library register inside it.
    const overlay = await screen.findByRole("dialog", { name: "Sessions" });
    expect(
      overlay.querySelector("[data-vex-screen='sessions-library']"),
    ).not.toBeNull();
    expect(
      screen.getByRole("searchbox", { name: /Search session titles/i }),
    ).not.toBeNull();

    // Escape closes the screen.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("shows no pulsing dots anywhere - status is color + words, never motion", async () => {
    const view = renderShell();
    await screen.findByText("The night shift is active.");
    fireEvent.click(screen.getByRole("button", { name: /Open menu/i }));
    expect(view.container.querySelectorAll(".vex-pulse-dot")).toHaveLength(0);
  });

  it("retires the sidebar Browse-all row (the Sessions screen replaces it)", async () => {
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: makeSessionRows() });
    renderShell();
    await screen.findByText("Portfolio Check");
    expect(
      screen.queryByRole("button", { name: /Browse all|Open sessions library/i }),
    ).toBeNull();
  });

  it("profile row asks what to call the user when no display name is saved yet", async () => {
    renderShell();
    // Default mock: displayName null → the gentle ask, not the "Vex" fallback.
    await screen.findByText("What should Vex call you?");
  });

  it("profile row shows the saved display name once one is set", async () => {
    getUserProfileMock.mockResolvedValue({
      ok: true,
      data: { displayName: "Kuba", instructionsMd: null, workDescription: null },
    });
    renderShell();
    await screen.findByText("Kuba");
  });

  it("profile menu offers Personalize, opening the Vex setup dialog", async () => {
    renderShell();
    await screen.findByText("What should Vex call you?");

    fireEvent.click(screen.getByRole("button", { name: /Open menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Personalize/i }));

    expect(screen.getByText("Instructions for Vex")).not.toBeNull();
  });

  it("opens the rail search from the magnifier and filters session titles live", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();
    await screen.findByText("Portfolio Check");

    fireEvent.click(screen.getByRole("button", { name: /Search sessions/i }));
    const input = screen.getByRole("searchbox", { name: /Search sessions/i });
    fireEvent.change(input, { target: { value: "arbitrum" } });
    // The match is marked, so the title is the mark plus the rest: the row's
    // select button still carries the whole name.
    expect(screen.getByRole("button", { name: /Arbitrum LP Rebalance/ })).not.toBeNull();
    expect(screen.queryByText("Portfolio Check")).toBeNull();

    // Escape closes the field AND clears the filter.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByRole("searchbox", { name: /Search sessions/i }),
    ).toBeNull();
    expect(screen.getByText("Portfolio Check")).not.toBeNull();
  });

  it("groups recent sessions into Today, Yesterday, and Older", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();

    await screen.findByText("Today");
    expect(screen.getByText("Yesterday")).not.toBeNull();
    expect(screen.getByText("Older")).not.toBeNull();
    expect(screen.getAllByText("Arbitrum LP Rebalance").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Open BTC Perp Position").length).toBeGreaterThan(0);
  });

  // Owner QA round 2: the rail drew an always-visible native HORIZONTAL bar
  // along its bottom. Two causes, both closed here - a bare `overflow-y-auto`
  // computes overflow-x to `auto`, and this was the one long list in the app
  // that never opted into the overlay treatment the other three use.
  it("scrolls the session list vertically ONLY, on the app's overlay scrollbar", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();
    await screen.findByText("Portfolio Check");

    const scroller = document.querySelector<HTMLElement>(
      "aside [data-rail-control].overflow-y-auto",
    );
    expect(scroller).not.toBeNull();
    const classes = scroller!.className;
    // Horizontal overflow is CLIPPED, never a bar.
    expect(classes).toContain("overflow-x-clip");
    // The shared thin + auto-hide treatment (scrollbars.css), same as the
    // transcript, the BOOK rail, and the composer field.
    expect(classes).toContain("vex-scroll");
    expect(classes).toContain("vex-scroll-overlay");

    // ...and the JS half is wired: that skin only paints while the element
    // carries `data-vex-scrolling`.
    expect(scroller!.hasAttribute("data-vex-scrolling")).toBe(false);
    act(() => {
      scroller!.dispatchEvent(new Event("scroll"));
    });
    expect(scroller!.hasAttribute("data-vex-scrolling")).toBe(true);
  });

  it("filters the sidebar by mission mode", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();
    await screen.findByText("Portfolio Check");

    // The Missions nav row opens the search on its Mission tab.
    fireEvent.click(screen.getByRole("button", { name: "Missions" }));
    expect(screen.getByRole("tab", { name: "Mission" }).getAttribute("aria-selected")).toBe("true");

    expect(screen.getAllByText("Arbitrum LP Rebalance").length).toBeGreaterThan(0);
    expect(screen.queryByText("Portfolio Check")).toBeNull();
  });

  it("mounts the print in the Vex sidebar's plate, not on the left page", () => {
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();

    // The left sidebar is paper: no print under the sessions index any more.
    const page = view.container.querySelector("[data-vex-area='left-page']");
    expect(page?.querySelector("img")).toBeNull();
    expect(page?.querySelector("[data-vex-area='sessions-sidebar']")).not.toBeNull();
    // The print window is Vex's: the day and the night print, CSS shows the
    // one for the room, and her hologram stands in it.
    const plate = view.container.querySelector(
      "[data-vex-area='vex-sidebar'] [data-vex-area='vex-portrait-plate']",
    );
    expect(plate).not.toBeNull();
    expect(
      Array.from(plate?.querySelectorAll("img") ?? []).map((img) => img.getAttribute("src")),
    ).toEqual(["/art/plateau.jpg", "/art/plateau-night.jpg"]);
    expect(plate?.querySelector("[data-vex-k2='sidebar']")).not.toBeNull();
    // Nothing veils the print.
    expect(plate?.hasAttribute("data-vex-backdrop-dimmed")).toBe(false);
  });

  it("paints the user's own image in the Vex sidebar's plate when one is set, in the print's place", async () => {
    const url = "app://vex/user-backdrop/bg_0123456789abcdef0123456789abcdef";
    shellBackdropReadMock.mockResolvedValue({
      ok: true,
      data: {
        backdrop: {
          imageId: "bg_0123456789abcdef0123456789abcdef",
          url,
          mime: "image/png",
          width: 1920,
          height: 1080,
          byteLength: 4096,
        },
      },
    });
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();
    const plate = view.container.querySelector("[data-vex-area='vex-portrait-plate']");
    expect(plate).not.toBeNull();
    await waitFor(() => {
      expect(plate?.getAttribute("data-vex-backdrop-source")).toBe("custom");
    });
    // ONE image, the user's, instead of both prints, in Vex's column.
    const images = plate?.querySelectorAll("img") ?? [];
    expect(images.length).toBe(1);
    expect(images[0]?.getAttribute("src")).toBe(url);
    expect(plate?.closest("[data-vex-area='vex-sidebar']")).not.toBeNull();
  });

  it("applies the Chronos theme to the shell root as data-vex-theme", () => {
    const view = renderShell();
    const root = view.container.querySelector('[data-vex-screen="appShell"]');
    expect(root?.getAttribute("data-vex-theme")).toBe("chronos");
  });

  it("closes the left sidebar to its rail and opens it again from the Chats key", async () => {
    const view = renderShell();
    const sidebar = view.container.querySelector("[data-vex-area='sessions-sidebar']");
    const page = view.container.querySelector("[data-vex-area='left-page']");

    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("true");
    expect(page?.getAttribute("data-vex-left-page")).toBe("page");
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse sessions sidebar/i }),
    );
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("false");
    expect(page?.getAttribute("data-vex-left-page")).toBe("spine");
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("true");
    expect(page?.getAttribute("data-vex-left-page")).toBe("page");
  });

  it("keeps the Lighter center mounted while its top navigation drawer toggles", () => {
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: false });
    const view = renderShell();
    const sidebar = view.container.querySelector("[data-vex-area='lighter-sidebar']");

    expect(screen.queryByTestId("lighter-center")).not.toBeNull();
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /Open markets and sessions/i }));
    expect(screen.queryByTestId("lighter-center")).not.toBeNull();
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Close markets and sessions/i }));
    expect(screen.queryByTestId("lighter-center")).not.toBeNull();
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("false");
    act(() => useUiStore.getState().setRuntimeMode("agent"));
  });

  it("places the Lighter title row in the centre column and keeps the content columns full-height", () => {
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: false });
    const view = renderShell();
    const topbar = view.container.querySelector("[data-vex-area='lighter-sidebar']");
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const centerColumn = screen.getByTestId("lighter-center").parentElement?.parentElement;
    const vexColumn = view.container.querySelector("[data-vex-area='vex-sidebar']")?.parentElement;
    const columns = [centerColumn, vexColumn];

    // The title row is the centre's head row, under the running head (W4-2).
    expect(topbar?.parentElement?.classList.contains("vex-shell-centre")).toBe(true);
    expect(frame?.style.paddingTop).toBe("");
    // Lighter always uses the left rail, and it mounts the real sidebar on it.
    expect(frame?.style.gridTemplateColumns).toMatch(/^56px minmax\(0, 1fr\) /);
    expect(
      view.container
        .querySelector("[data-vex-area='left-page'] [data-vex-area='sessions-sidebar']")
        ?.getAttribute("data-rail"),
    ).toBe("true");

    for (const column of columns) {
      expect(column).not.toBeNull();
      expect(column?.classList.contains("h-full")).toBe(true);
      expect(column?.classList.contains("min-h-0")).toBe(true);
    }
    act(() => useUiStore.getState().setRuntimeMode("agent"));
  });

  it("gives Zen Mode the full chart track and overlays a contextual Vex panel", () => {
    useUiStore.setState({
      runtimeMode: "lighter",
      activeSessionId: "s-1",
      sidebarNarrowExpanded: false,
      vexOpenLighter: true,
    });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");

    fireEvent.click(screen.getByRole("button", { name: "Enter Zen Mode" }));
    expect(frame?.getAttribute("data-lighter-zen")).toBe("true");
    expect(frame?.getAttribute("data-lighter-zen-controls")).toBe("closed");
    expect(frame?.style.paddingTop).toBe("");
    expect(frame?.style.gridTemplateColumns).toBe("0px minmax(0, 1fr) 0px");
    expect(screen.getByTestId("lighter-center").getAttribute("data-zen-mode")).toBe("true");
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Show Zen controls" }));
    expect(frame?.getAttribute("data-lighter-zen-controls")).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Ask Vex" }));
    expect(frame?.getAttribute("data-lighter-zen-assistant")).toBe("open");
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.getAttribute("data-lighter-zen")).toBe("true");
    expect(frame?.hasAttribute("data-lighter-zen-assistant")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.getAttribute("data-lighter-zen")).toBe("true");
    expect(frame?.getAttribute("data-lighter-zen-controls")).toBe("closed");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.hasAttribute("data-lighter-zen")).toBe(false);
    expect(frame?.style.gridTemplateColumns).not.toBe("0px minmax(0, 1fr) 0px");
    act(() => useUiStore.getState().setRuntimeMode("agent"));
  });

  it("sizes the Lighter agent independently from the portfolio preference", () => {
    const previousBookWidth = useUiStore.getState().bookWidth;
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: false, vexOpenLighter: true, bookWidth: 300 });
    useLighterAnalysisStore.getState().saveDesk({ chatShare: 0.32 });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    // 1440 x 0.32 = 460.8, rounded by the solver.
    expect(frame?.style.gridTemplateColumns).toBe("56px minmax(0, 1fr) 461px");
    act(() => useLighterAnalysisStore.getState().saveDesk({ chatShare: 310 / window.innerWidth }));
    expect(frame?.style.gridTemplateColumns).toBe("56px minmax(0, 1fr) 310px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize the Vex panel" }), { key: "ArrowLeft" });
    expect(frame?.style.gridTemplateColumns).toBe("56px minmax(0, 1fr) 334px");
    expect(useLighterAnalysisStore.getState().desk.chatShare).toBeCloseTo(334 / window.innerWidth);
    expect(useUiStore.getState().bookWidth).toBe(300);
    act(() => {
      useUiStore.getState().setRuntimeMode("agent");
      useUiStore.getState().setBookWidth(previousBookWidth);
      useLighterAnalysisStore.getState().saveDesk({ chatShare: 0.32 });
    });
  });

  it("keeps the Vex panel open while the top navigation drawer is open", () => {
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: true, vexOpenLighter: true });
    const view = renderShell();
    const panel = view.container.querySelector("[data-vex-area='vex-sidebar']");
    expect(panel?.getAttribute("data-vex-vex-open")).toBe("true");
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Close markets and sessions/i }));
    expect(panel?.getAttribute("data-vex-vex-open")).toBe("true");
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
    act(() => useUiStore.getState().setRuntimeMode("agent"));
  });

  it("crowns the sidebar rail with the static logo mark, not a VEX wordmark", () => {
    const view = renderShell();
    const sidebar = view.container.querySelector(
      "[data-vex-area='sessions-sidebar']",
    );
    // The rail brand is now a plain <img> logo mark (the particle canvas was
    // retired) — [data-vex-home-mark], the clean monogram. The mark carries no
    // text wordmark (the "no VEX wordmark" contract is pinned in full by
    // SidebarHomeSigil.test.tsx; the rail's $VEX widget legitimately says VEX).
    const mark = sidebar?.querySelector("[data-vex-home-mark]");
    expect(mark).not.toBeNull();
    expect(mark?.querySelector("svg path")).not.toBeNull();
    expect(mark?.textContent).toBe("");
  });

  it("keeps the $VEX widget out of the left sidebar and off the welcome stage", async () => {
    // The left sidebar says where you are (docs/design/R3-MINIMAL.md section
    // 4); the $VEX line moves to the Portfolio page.
    const view = renderShell();
    await screen.findByText("The night shift is active.");
    const sidebar = view.container.querySelector(
      "[data-vex-area='sessions-sidebar']",
    );
    expect(sidebar).not.toBeNull();
    expect(
      sidebar?.querySelector("[data-vex-area='vex-token-compact']"),
    ).toBeNull();
    const panel = view.container.querySelector(
      "[data-vex-area='session-panel']",
    );
    expect(
      panel?.querySelector("[data-vex-area='vex-token-compact']"),
    ).toBeNull();
  });

  it("keeps the open sidebar inside its track at the 1279, 1280, 1359 and 1360 seams", () => {
    // The wave 1 defect: at 1280 the left track is 224 and the V10 page
    // content ran past it. The R3 column fills its track (left-sidebar.css,
    // pinned in SessionsList-nav.test.tsx) and is never given a width here.
    useUiStore.setState({ activeSessionId: "s-1" });
    const at = (width: number): { columns: string | undefined; open: string | null; inline: string } => {
      setWindowWidth(width);
      const view = renderShell();
      const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
      const sidebar = view.container.querySelector<HTMLElement>("[data-vex-area='sessions-sidebar']");
      const result = {
        columns: frame?.style.gridTemplateColumns,
        open: sidebar?.getAttribute("data-vex-sidebar-open") ?? null,
        inline: sidebar?.style.width ?? "",
      };
      view.unmount();
      return result;
    };
    expect(at(1279)).toEqual({ columns: "224px minmax(0, 1fr) 240px", open: "true", inline: "" });
    expect(at(1280)).toEqual({ columns: "224px minmax(0, 1fr) 240px", open: "true", inline: "" });
    expect(at(1359)).toEqual({ columns: "224px minmax(0, 1fr) 240px", open: "true", inline: "" });
    expect(at(1360)).toEqual({ columns: "264px minmax(0, 1fr) 256px", open: "true", inline: "" });
    // Under the medium tier an open Vex keeps the left at its rail.
    expect(at(1179)).toEqual({ columns: "56px minmax(0, 1fr) 224px", open: "false", inline: "" });
  });

  it("solves the three tracks from the solver (left 264, centre, Vex 256 at 1440)", () => {
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame).not.toBeNull();
    // jsdom: no ResizeObserver, viewport = window.innerWidth. The welcome
    // stage has no right column: Vex sits in the centre there.
    expect(frame?.style.gridTemplateColumns).toBe("264px minmax(0, 1fr) 0px");
    expect(frame?.getAttribute("data-vex-tier")).toBe("wide");
    expect(frame?.style.getPropertyValue("--vex-vex-track")).toBe("0px");
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")).toBeNull();
    expect(view.container.querySelector("[data-vex-area='welcome-portfolio']")).toBeNull();

    // A session: Vex opens at her wide width beside the transcript.
    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(frame?.style.gridTemplateColumns).toBe("264px minmax(0, 1fr) 256px");
    expect(
      view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open"),
    ).toBe("true");
    // The running head reserves the caption buttons against the right track.
    expect(frame?.style.getPropertyValue("--vex-vex-track")).toBe("256px");
    expect(frame?.style.getPropertyValue("--vex-overlay-left")).toBe("264px");
  });

  it("follows the spec's tiers at 1280, 1024 and 1000 x 720", () => {
    useUiStore.setState({ activeSessionId: "s-1" });
    const solved = (width: number): string | undefined => {
      setWindowWidth(width);
      const view = renderShell();
      const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
      const columns = frame?.style.gridTemplateColumns;
      view.unmount();
      return columns;
    };
    expect(solved(1280)).toBe("224px minmax(0, 1fr) 240px");
    expect(solved(1024)).toBe("56px minmax(0, 1fr) 224px");
    expect(solved(1000)).toBe("56px minmax(0, 1fr) 224px");
  });

  it("under 1180 keeps the left at its rail, with its cap across the head row", () => {
    setWindowWidth(1024);
    useUiStore.setState({ activeSessionId: "s-1" });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.getAttribute("data-vex-tier")).toBe("narrow");
    expect(frame?.getAttribute("data-vex-sidebar-collapsed")).toBe("true");
    const page = view.container.querySelector("[data-vex-area='left-page']");
    expect(page?.getAttribute("data-vex-left-page")).toBe("spine");
    expect(page?.querySelector(".vex-left-page__cap")).not.toBeNull();
  });

  it("under 1180 a re-opened left closes Vex (derived), and showing Vex folds it back", () => {
    setWindowWidth(1024);
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.style.gridTemplateColumns).toBe("56px minmax(0, 1fr) 224px");

    // The left re-opened under 1180 (the sidebar's own key flips this
    // override; the key itself is the left sidebar's suite).
    act(() => useUiStore.getState().setSidebarNarrowExpanded(true));
    // Vex closes to zero width; the stored choice is untouched.
    expect(frame?.style.gridTemplateColumns).toBe("224px minmax(0, 1fr) 0px");
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(
      view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open"),
    ).toBe("false");

    // Showing her again (the title bar's token chip) folds the left back.
    act(() => useUiStore.getState().setVexOpen(true));
    expect(frame?.style.gridTemplateColumns).toBe("56px minmax(0, 1fr) 224px");
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
  });

  it("a page opened from the welcome keeps its name and the token chip in the title bar", () => {
    const view = renderShell();
    const head = (): Element | null =>
      view.container.querySelector("[data-vex-area='shell-status-strip']");
    // The bare welcome: nothing to say, no chip (Vex stands in the centre).
    expect(head()?.hasAttribute("data-empty")).toBe(true);
    expect(view.container.querySelector("[data-vex-area='vex-token-chip']")).toBeNull();

    // A page covers the welcome and is not part of it.
    act(() => useUiStore.getState().navigate("portfolio"));
    expect(head()?.hasAttribute("data-empty")).toBe(false);
    expect(
      view.container.querySelector("[data-vex-area='title-bar-title']")?.textContent,
    ).toBe("Portfolio");
    expect(view.container.querySelector("[data-vex-area='vex-token-chip']")).not.toBeNull();

    // Back on the welcome, the stage is as it was.
    act(() => useUiStore.getState().navigate("chat"));
    expect(head()?.hasAttribute("data-empty")).toBe(true);
  });

  it("retires the gutter; every head row stays a drag region", () => {
    const view = renderShell();
    expect(view.container.querySelector("[data-vex-area='shell-gutter']")).toBeNull();
    expect(view.container.querySelector("[data-vex-running-head-fold]")).toBeNull();
    const head = view.container.querySelector("[data-vex-area='shell-status-strip']");
    expect(head?.classList.contains("vex-drag")).toBe(true);
    // The welcome head has nothing to say: its rule is clear.
    expect(head?.hasAttribute("data-empty")).toBe(true);
    // The open sidebar's head row clears the macOS traffic lights.
    const sidebarHead = view.container.querySelector("[data-vex-area='sessions-sidebar'] header");
    expect(sidebarHead?.classList.contains("vex-drag")).toBe(true);
    expect(sidebarHead?.classList.contains("vex-lights-start")).toBe(true);
  });

  it("keeps the right track NUMERIC on both sides of the welcome<->session edge", () => {
    // `auto` <-> length is not interpolable, so under the frame's 300ms
    // grid-template-columns transition an `auto` track was re-solved against
    // the newly mounted right column and swept it through the centre (owner
    // QA item 8). Every state must emit a length.
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const lastTrack = (): string =>
      (frame?.style.gridTemplateColumns ?? "").split(" ").at(-1) ?? "";

    // Welcome: exactly zero, still a length.
    expect(lastTrack()).toBe("0px");
    // Session stage: Vex open, then hidden to zero width.
    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(lastTrack()).toBe("256px");
    act(() => useUiStore.getState().setVexOpen(false));
    expect(lastTrack()).toBe("0px");
    act(() => useUiStore.getState().setVexOpen(true));
    // Every track of the frame is a length around the centre.
    expect(frame?.style.gridTemplateColumns).toMatch(/^\d+px minmax\(0, 1fr\) \d+px$/);
  });

  it("mounts no sidebar drag handle: the left and Vex widths are fixed", () => {
    const view = renderShell();
    expect(view.container.querySelector(".vex-shell-handle")).toBeNull();
    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(view.container.querySelector(".vex-shell-handle")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Collapse sessions sidebar/i }),
    );
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    // The closed left is the fixed 56px rail.
    expect(frame?.style.gridTemplateColumns).toBe("56px minmax(0, 1fr) 256px");
    expect(view.container.querySelector(".vex-shell-handle")).toBeNull();
  });

  it("no longer reads the stored drag width: the left column keeps its spec width", () => {
    const view = renderShell();
    act(() => useUiStore.getState().setSidebarWidth(342));
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.style.gridTemplateColumns).toBe("264px minmax(0, 1fr) 0px");
  });

  it("hides Vex by default on the table pages and opens the page inside the centre", () => {
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true, vexOpenPages: false });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.style.gridTemplateColumns).toBe("264px minmax(0, 1fr) 256px");

    act(() => useUiStore.getState().navigate("portfolio"));
    expect(frame?.style.gridTemplateColumns).toBe("264px minmax(0, 1fr) 0px");
    const page = view.container.querySelector("[data-vex-area='shell-screen']");
    expect(page?.getAttribute("aria-label")).toBe("Portfolio");
    // Inside the centre column: both sidebars stay standing beside it.
    expect(page?.closest(".vex-shell-centre")).not.toBeNull();
    expect(view.container.querySelector("[data-vex-area='sessions-sidebar']")).not.toBeNull();

    // Back in the chat, Vex is open again: hiding her on a page never closed her there.
    act(() => useUiStore.getState().navigate("chat"));
    expect(frame?.style.gridTemplateColumns).toBe("264px minmax(0, 1fr) 256px");
  });

  it("keeps the way into Studio on screen across the welcome<->session edge", () => {
    // THE DEFECT, at the seat where it was measured (UX after-audit N1). The
    // way out of agent mode once rendered on the welcome HERO only, so
    // selecting a session unmounted the hero and took it off the screen.
    // Close-range suites cannot see this; only the assembled shell can show
    // that the control survives a stage change. The R3 sidebar's nav carries
    // Studio as a row (docs/design/R3-MINIMAL.md section 4), open and on the
    // rail alike, whatever the centre shows; the sidebar carries no capsule.
    const view = renderShell();
    const sidebar = (): HTMLElement | null =>
      view.container.querySelector("[data-vex-area='sessions-sidebar']");
    const studioRow = (): HTMLElement | undefined =>
      Array.from(
        sidebar()?.querySelectorAll<HTMLElement>("nav[aria-label='Main'] button") ?? [],
      ).find((button) => (button.getAttribute("aria-label") ?? button.textContent) === "Studio");

    expect(studioRow()).toBeDefined();
    expect(sidebar()?.querySelector("[role='radiogroup']")).toBeNull();

    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(studioRow()).toBeDefined();
    expect(sidebar()?.querySelector("[role='radiogroup']")).toBeNull();

    // Closed to its rail the row is a named key, still there (the switch
    // itself is pinned close range in SessionsList-nav.test.tsx).
    fireEvent.click(screen.getByRole("button", { name: /Collapse sessions sidebar/i }));
    expect(sidebar()?.getAttribute("data-vex-sidebar-open")).toBe("false");
    expect(studioRow()?.getAttribute("aria-label")).toBe("Studio");
  });
});

describe("the centre error boundary", () => {
  it("replaces a page that throws with the recovery card, both sidebars stay, and closing the page clears it", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      screenFault.on = true;
      const view = renderShell();
      act(() =>
        useUiStore.getState().setShellRoute({ kind: "settings", origin: null, section: null }),
      );

      const card = view.container.querySelector("[data-vex-error-boundary]");
      expect(card).not.toBeNull();
      expect(card?.getAttribute("data-extent")).toBe("region");
      // The card stands inside the centre column, between the two sidebars.
      expect(card?.closest(".vex-shell-centre")).not.toBeNull();
      expect(view.container.querySelector("[data-vex-area='sessions-sidebar']")).not.toBeNull();
      expect(view.container.querySelector("[data-vex-area='vex-sidebar']")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();

      // The page's own way out: closing it moves the route, which resets the boundary.
      screenFault.on = false;
      fireEvent.click(screen.getByRole("button", { name: "Close this page" }));
      expect(useUiStore.getState().shellRoute.kind).toBe("none");
      expect(view.container.querySelector("[data-vex-error-boundary]")).toBeNull();
    } finally {
      screenFault.on = false;
      consoleError.mockRestore();
    }
  });
});

/** jsdom lacks AnimationEvent, so React subscribes to its supported WebKit event. */
function finishMenuAnimation(element: Element, animationName = "vex-profile-menu-exit"): void {
  fireEvent(element, Object.assign(new Event("webkitAnimationEnd", { bubbles: true }), { animationName }));
}

function makeAgentRow(title: string): SessionListItem {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    mode: "agent",
    permission: "restricted",
    title,
    initialGoal: null,
    startedAt: localIsoDaysAgo(0),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
  };
}

function renderShell(): ReturnType<typeof render> & {
  readonly queryClient: QueryClient;
} {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: {
      retry: false,
    },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <AppShell />
    </QueryClientProvider>,
  );
  // Object.assign keeps the existing call-sites (which use `renderShell()`
  // without destructuring) working while letting new tests read the
  // QueryClient for direct cache assertions.
  return Object.assign(result, { queryClient: client });
}

// Same as `renderShell` but wrapped in <StrictMode> so dev mount-effect
// replay (subscribe → cleanup → subscribe) is exercised — the condition that
// detaches the chat MutationObserver mid-flight and froze `isPending`.
function renderShellStrict(): ReturnType<typeof render> {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <AppShell />
      </QueryClientProvider>
    </StrictMode>,
  );
}

function makeSessionRows(): readonly SessionListItem[] {
  return [
    {
      id: "fb7bf453-df76-43e9-b756-02c3b717f242",
      mode: "mission",
      permission: "restricted",
      title: "Arbitrum LP Rebalance",
      initialGoal: "Arbitrum LP Rebalance",
      startedAt: localIsoDaysAgo(0),
      endedAt: null,
      missionStatus: "running",
      pinnedAt: null,
    },
    {
      id: "2c7e7135-6d80-443c-b73e-b43717a09425",
      mode: "agent",
      permission: "restricted",
      title: null,
      initialGoal: null,
      startedAt: localIsoDaysAgo(0),
      endedAt: null,
      missionStatus: null,
      pinnedAt: null,
    },
    {
      id: "cf0788b8-87c7-4eb2-b4b9-4252779f906d",
      mode: "mission",
      permission: "full",
      title: "Open BTC Perp Position",
      initialGoal: "Open BTC Perp Position",
      startedAt: localIsoDaysAgo(1),
      endedAt: null,
      missionStatus: "paused_wake",
      pinnedAt: null,
    },
    {
      id: "db01d1f7-8b1e-4607-a59c-cda6a9ff1024",
      mode: "agent",
      permission: "restricted",
      title: "Portfolio Check",
      initialGoal: "Portfolio Check",
      startedAt: localIsoDaysAgo(3),
      endedAt: null,
      missionStatus: null,
      pinnedAt: null,
    },
  ];
}

function localIsoDaysAgo(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makeHealthReport(overall: HealthReport["overall"]): HealthReport {
  return {
    os: {
      platform: "linux",
      arch: "x64",
      release: "test",
      distro: "test",
      homedir: "/home/test",
      userDataDir: "/tmp/vex-test",
      appVersion: "0.0.0-test",
      electronVersion: "0.0.0-test",
      nodeVersion: "0.0.0-test",
    },
    network: {
      online: true,
      latencyMs: 1,
      probedAt: new Date("2026-05-19T12:00:00.000Z").toISOString(),
    },
    translocated: false,
    setupComplete: true,
    overall,
  };
}
