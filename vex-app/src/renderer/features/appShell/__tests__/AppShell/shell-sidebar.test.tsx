import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

// Zen's row is the chart's toolbar (`ZenRow.tsx`): the desk draws its keys
// from the shell's Zen controls. Folded, it is the fold key and Exit Zen.
vi.mock("../../lighterTrading/LighterCenter.js", () => ({
  LighterCenter: ({ zenMode, zenControls }: {
    readonly zenMode: boolean;
    readonly zenControls?: import("../../lighterTrading/ZenRow.js").ZenControls;
  }) => (
    <div data-testid="lighter-center" data-zen-mode={zenMode ? "true" : undefined}>
      {zenMode && zenControls !== undefined ? (
        <>
          {zenControls.controlsOpen ? (
            <button
              type="button"
              aria-label={zenControls.assistantOpen ? "Close Vex" : "Ask Vex"}
              onClick={zenControls.onToggleAssistant}
            />
          ) : null}
          <button
            type="button"
            aria-label={zenControls.controlsOpen ? "Hide Zen controls" : "Show Zen controls"}
            onClick={zenControls.onToggleControls}
          />
          <button type="button" aria-label="Exit Zen Mode" onClick={zenControls.onExit} />
        </>
      ) : null}
    </div>
  ),
}));

vi.mock("../../lighterTrading/LighterSidebar.js", () => ({
  LighterSidebar: ({
    collapsed,
    onToggleSidebar,
    onEnterZen,
  }: {
    readonly collapsed: boolean;
    readonly onToggleSidebar: () => void;
    readonly onEnterZen: () => void;
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
      <button type="button" aria-label="Enter Zen Mode" onClick={onEnterZen} />
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
  it("renders the Vex shell hero and the account cell with H3's words", async () => {
    renderShell();

    // The welcome's greeting, H3's one line (docs/design/H3-DESKTOP.md
    // Appendix A.4), pinned close-range in SessionWelcomeHero.test.tsx.
    expect(screen.getByRole("heading", { name: "Ready when you are." })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /New chat/i }).length).toBeGreaterThan(0);
    // Healthy runtime → the account cell says H3's "Account and settings"
    // (docs/design/H3-DESKTOP.md Appendix A.2), its trigger naming the
    // runtime's word.
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });
    const account = document.querySelector("[data-vex-area='account-cell']");
    expect(account?.textContent).toContain("Account and settings");
    expect(screen.queryByText("The night shift is active.")).toBeNull();
    // The bare version stamp lives in the SESSION rail's collapse header;
    // on the welcome stage the right edge is the floating Portfolio tab
    // (no version chrome) and the hero carries only the eyebrow tooltip.
    expect(screen.queryByText("v0.0.0-test")).toBeNull();
    expect(screen.queryByText(/^PREVIEW · v/)).toBeNull();
  });

  it("profile menu carries seven actions including Lock Vex", async () => {
    renderShell();
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });

    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    // The status row speaks ONE short word (the long RuntimeLedger strings
    // are retired), beside the Postgres mark.
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
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Agent Scan/i }));
    expect(useUiStore.getState().shellRoute.kind).toBe("agentScan");
    useUiStore.getState().setShellRoute({ kind: "none" });

    // Settings opens the in-shell Settings ShellScreen (Phase 2b — the
    // reconfigure-wizard door is retired): the route carries the row's
    // rect origin and a null section (the landing register), and the
    // view machine never leaves the shell.
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
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
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });
    const trigger = screen.getByRole("button", { name: /account and settings/i });
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
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });
    const trigger = screen.getByRole("button", { name: /account and settings/i });
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
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });
    const trigger = screen.getByRole("button", { name: /account and settings/i });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    fireEvent.click(trigger);
    expect(menu.isConnected).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("removes a closing profile menu when reduced motion becomes active", async () => {
    renderShell();
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });
    const trigger = screen.getByRole("button", { name: /account and settings/i });
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
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });

    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    // Accessible row name = label + hint subline, so anchor on the label.
    fireEvent.click(screen.getByRole("menuitem", { name: /^Sessions/i }));

    expect(useUiStore.getState().shellRoute.kind).toBe("sessions");
    // The full-app screen chrome + the library register inside it.
    const overlay = await screen.findByRole("region", { name: "Sessions" });
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
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });
    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /account and settings/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Personalize/i }));

    expect(screen.getByText("Instructions for Vex")).not.toBeNull();
  });

  it("filters chat titles live from the always-open search field", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();
    await screen.findByText("Portfolio Check");

    // The field is always open (H3-DESKTOP.md section 1.4): no row opens it.
    expect(screen.queryByRole("button", { name: /Search chats/i })).toBeNull();
    const input = screen.getByRole("searchbox", { name: /Search chats/i });
    fireEvent.change(input, { target: { value: "arbitrum" } });
    // The match is marked, so the title is the mark plus the rest: the row's
    // select button still carries the whole name.
    // Scoped to the chats list: Vex's console names a running mission in its
    // missions row too (docs/design/H3-DESKTOP.md section 1.5).
    const list = document.querySelector<HTMLElement>("[data-vex-area='sessions-sidebar']");
    if (list === null) throw new Error("the sessions sidebar is missing");
    expect(within(list).getByRole("button", { name: /Arbitrum LP Rebalance/ })).not.toBeNull();
    expect(screen.queryByText("Portfolio Check")).toBeNull();

    // Escape clears the filter; the field stays open.
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Portfolio Check")).not.toBeNull();
  });

  it("groups recent sessions into Today, Yesterday, and Earlier (H3-DESKTOP.md Appendix A.2)", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();

    await screen.findByText("Today");
    expect(screen.getByText("Yesterday")).not.toBeNull();
    expect(screen.getByText("Earlier")).not.toBeNull();
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

  it("stands Kimm's portrait card at the top of Vex's panel, and none on the left page", () => {
    // docs/design/H3-DESKTOP.md section 6.3: D2's panel opens on her
    // portrait card (her field and her still); no section, no wipe, no
    // strip, no corner key, no print window and no other figure.
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();

    // The left sidebar is paper: no print under the sessions index any more.
    const page = view.container.querySelector("[data-vex-area='left-page']");
    expect(page?.querySelector("img")).toBeNull();
    expect(page?.querySelector("[data-vex-area='sessions-sidebar']")).not.toBeNull();
    const card = view.container.querySelector(
      "[data-vex-area='vex-sidebar'] [data-vex-area='vex-portrait-card'] [data-vex-area='kimm-panel']",
    );
    expect(card).not.toBeNull();
    expect(view.container.querySelector("[data-vex-area='kimm-section']")).toBeNull();
    expect(view.container.querySelector("[data-vex-area='kimm-key']")).toBeNull();
    expect(view.container.querySelector("[data-vex-area='kimm-hint']")).toBeNull();
    // Her art is the app's own (VEX Cloud's renders in public/art/kimm/), never a stand-in.
    expect(card?.getAttribute("data-kimm-art")).toBe("ready");
    expect(card?.querySelector("img.vex-kimm-panel__figure")?.getAttribute("src")).toMatch(
      /^\/art\/kimm\/still-[a-z]+\.webp$/,
    );
    expect(card?.innerHTML).not.toMatch(/kimm-standin-/);
  });

  it("applies the Chronos theme to the shell root as data-vex-theme", () => {
    const view = renderShell();
    const root = view.container.querySelector('[data-vex-screen="appShell"]');
    expect(root?.getAttribute("data-vex-theme")).toBe("chronos");
  });

  it("closes the left sidebar to its rail and opens it again from the Expand key", async () => {
    const view = renderShell();
    const sidebar = view.container.querySelector("[data-vex-area='sessions-sidebar']");
    const page = view.container.querySelector("[data-vex-area='left-page']");

    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("true");
    expect(page?.getAttribute("data-vex-left-page")).toBe("page");
    fireEvent.click(
      screen.getByRole("button", { name: /^Collapse sidebar$/i }),
    );
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("false");
    expect(page?.getAttribute("data-vex-left-page")).toBe("spine");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
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

  it("draws the desk's title row in the header's title cell, over the 76 rail", () => {
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: false });
    const view = renderShell();
    const topbar = view.container.querySelector("[data-vex-area='lighter-sidebar']");
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const centerColumn = screen.getByTestId("lighter-center").parentElement?.parentElement;
    const vexColumn = view.container.querySelector("[data-vex-area='vex-sidebar']")?.parentElement;
    const columns = [centerColumn, vexColumn];

    // The desk's head is the header's title cell (H3-DESKTOP.md section 4.9).
    expect(topbar?.closest("[data-vex-head-cell='title']")?.hasAttribute("data-vex-desk-head")).toBe(true);
    expect(topbar?.closest(".vex-shell-centre")).toBeNull();
    // The rail at 76 under the header's logo cell, the account cell under it.
    expect(frame?.style.gridTemplateColumns).toMatch(/^76px minmax\(0, 1fr\) /);
    expect(
      view.container
        .querySelector("[data-vex-area='left-page'] [data-vex-area='sessions-sidebar']")
        ?.getAttribute("data-rail"),
    ).toBe("true");
    expect(view.container.querySelector("[data-vex-area='account-cell']")).not.toBeNull();
    expect(view.container.querySelector("[data-vex-area='tagline-cell']")).toBeNull();

    for (const column of columns) {
      expect(column).not.toBeNull();
      expect(column?.classList.contains("h-full")).toBe(true);
      expect(column?.classList.contains("min-h-0")).toBe(true);
    }
    act(() => useUiStore.getState().setRuntimeMode("agent"));
  });

  it("opens the desk's rail to the 248 for the visit only, and starts the next visit on the rail", () => {
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: false, leftOpen: false });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.style.gridTemplateColumns).toMatch(/^76px /);
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(frame?.style.gridTemplateColumns).toMatch(/^248px /);
    // Never saved: the stored chats choice is untouched.
    expect(useUiStore.getState().leftOpen).toBe(false);
    act(() => useUiStore.getState().setRuntimeMode("agent"));
    act(() => useUiStore.getState().setRuntimeMode("lighter"));
    expect(frame?.style.gridTemplateColumns).toMatch(/^76px /);
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
    // Her desk chat stands over the chart in her column's seat, as wide as
    // her column on the desk (lighter-desk.css).
    expect(frame?.style.getPropertyValue("--lit-zen-seat")).toMatch(/^\d+(\.\d+)?px$/);
    expect(screen.getByTestId("lighter-center").getAttribute("data-zen-mode")).toBe("true");
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Show Zen controls" }));
    expect(frame?.getAttribute("data-lighter-zen-controls")).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Ask Vex" }));
    expect(frame?.getAttribute("data-lighter-zen-assistant")).toBe("open");
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open")).toBe("true");

    // Escape closes Zen's own panels, then Zen, and never her
    // (docs/design/H3-DESKTOP.md section 3.5).
    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.getAttribute("data-lighter-zen")).toBe("true");
    expect(frame?.getAttribute("data-lighter-zen-controls")).toBe("closed");
    expect(frame?.getAttribute("data-lighter-zen-assistant")).toBe("open");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.hasAttribute("data-lighter-zen")).toBe(false);
    expect(frame?.style.gridTemplateColumns).not.toBe("0px minmax(0, 1fr) 0px");
    // Out of Zen she is still open, on the desk's chat column.
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open")).toBe("true");
    act(() => useUiStore.getState().setRuntimeMode("agent"));
  });

  it("Escape in Zen never closes the Vex overlay, and leaving Zen keeps her open", () => {
    useUiStore.setState({
      runtimeMode: "lighter",
      activeSessionId: "s-1",
      sidebarNarrowExpanded: false,
      vexOpenLighter: false,
    });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const vexOpen = (): string | null | undefined =>
      view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open");
    fireEvent.click(screen.getByRole("button", { name: "Enter Zen Mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Zen controls" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Vex" }));
    expect(frame?.getAttribute("data-lighter-zen-assistant")).toBe("open");
    expect(vexOpen()).toBe("true");
    // The first Escape folds Zen's controls and leaves her open.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.getAttribute("data-lighter-zen-controls")).toBe("closed");
    expect(frame?.getAttribute("data-lighter-zen-assistant")).toBe("open");
    expect(vexOpen()).toBe("true");
    // The next leaves Zen, never closing her on the way: the desk's column
    // takes her (the stored choice opens).
    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.hasAttribute("data-lighter-zen")).toBe(false);
    expect(vexOpen()).toBe("true");
    expect(useUiStore.getState().vexOpenLighter).toBe(true);
    // Without her open, Escape leaves Zen and opens nothing.
    act(() => useUiStore.getState().setVexOpen(false));
    fireEvent.click(screen.getByRole("button", { name: "Enter Zen Mode" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(frame?.hasAttribute("data-lighter-zen")).toBe(false);
    expect(useUiStore.getState().vexOpenLighter).toBe(false);
    act(() => useUiStore.getState().setRuntimeMode("agent"));
  });

  it("keeps the Lighter desk's chat on the right, its drag handle on the chat's left edge", () => {
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: false, vexOpenLighter: true });
    useLighterAnalysisStore.getState().saveDesk({ chatShare: 0.32 });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.getAttribute("data-vex-frame")).toBe("desk");
    // The desk's order, in the DOM as on screen: rail | desk | chat.
    const order = Array.from(frame?.children ?? [])
      .map((el) =>
        el.classList.contains("vex-left-page") ? "chats"
          : el.classList.contains("vex-shell-vex") ? "vex"
            : el.classList.contains("vex-shell-centre") ? "chat"
              : null,
      )
      .filter((name) => name !== null);
    expect(order).toEqual(["chats", "chat", "vex"]);
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr) 461px");
    // H3's header and bottom rows over the desk (H3-DESKTOP.md section 4.9).
    expect(frame?.style.gridTemplateRows).toBe("var(--head-h) minmax(0, 1fr) var(--vex-h3-bottom-h)");
    // The handle grips the chat's left edge: 1440 - 461.
    const handle = screen.getByRole("separator", { name: "Resize the Vex panel" });
    expect(handle.style.left).toBe("979px");
    // A step to the left widens the chat on the right.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(frame?.style.gridTemplateColumns).toMatch(/^76px minmax\(0, 1fr\) 4\d\dpx$/);
    const after = Number(/(\d+)px$/.exec(frame?.style.gridTemplateColumns ?? "")?.[1]);
    expect(after).toBeGreaterThan(461);
    act(() => {
      useUiStore.getState().setRuntimeMode("agent");
      useLighterAnalysisStore.getState().saveDesk({ chatShare: 0.32 });
    });
  });

  it("sizes the Lighter agent independently from the portfolio preference", () => {
    const previousBookWidth = useUiStore.getState().bookWidth;
    useUiStore.setState({ runtimeMode: "lighter", sidebarNarrowExpanded: false, vexOpenLighter: true, bookWidth: 300 });
    useLighterAnalysisStore.getState().saveDesk({ chatShare: 0.32 });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    // 1440 x 0.32 = 460.8, rounded by the solver.
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr) 461px");
    act(() => useLighterAnalysisStore.getState().saveDesk({ chatShare: 310 / window.innerWidth }));
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr) 310px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize the Vex panel" }), { key: "ArrowLeft" });
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr) 334px");
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

  it("crowns the chats column with the static logo mark, not a VEX wordmark", () => {
    const view = renderShell();
    // The logo cell is the header's, over the chats column.
    const sidebar = view.container.querySelector(
      "[data-vex-area='shell-head'] [data-vex-head-cell='logo']",
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
    await screen.findByRole("button", { name: /, account and settings$/, description: "Runtime: Connected" });
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

  it("keeps the chats column inside its track at the 1023, 1024, 1279 and 1280 seams", () => {
    // The wave 1 defect: a sidebar's page content ran past its track. The
    // column fills its track (left-sidebar.css, pinned in
    // SessionsList-nav.test.tsx) and is never given a width here. H3's tiers
    // (docs/design/H3-DESKTOP.md sections 1.2 and 4.12): the band under 1024,
    // the chats the rail from 1024 to 1279, the stored choice from 1280.
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
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
    // Two tracks at every tier (D2, owner decision 2026-11-10): Vex has no
    // track, her panel lies over the chat. The band: the rail.
    expect(at(1023)).toEqual({ columns: "76px minmax(0, 1fr)", open: "false", inline: "" });
    // The medium tier: the rail.
    expect(at(1024)).toEqual({ columns: "76px minmax(0, 1fr)", open: "false", inline: "" });
    expect(at(1279)).toEqual({ columns: "76px minmax(0, 1fr)", open: "false", inline: "" });
    // From 1280 the stored choice, open by default.
    expect(at(1280)).toEqual({ columns: "248px minmax(0, 1fr)", open: "true", inline: "" });
    expect(at(1440)).toEqual({ columns: "248px minmax(0, 1fr)", open: "true", inline: "" });
  });

  it("solves the tracks from the D2 solver (chats 248, the chat 1192 to the edge, her panel 280 at 1440)", () => {
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame).not.toBeNull();
    // jsdom: no ResizeObserver, viewport = window.innerWidth. The welcome
    // keeps Vex's panel (docs/design/H3-DESKTOP.md section 6): two tracks,
    // her panel's room 280 at the chat's right.
    expect(frame?.style.gridTemplateColumns).toBe("248px minmax(0, 1fr)");
    expect(frame?.style.getPropertyValue("--vex-panel-w")).toBe("280px");
    expect(frame?.getAttribute("data-vex-panel")).toBe("shown");
    // H3's head | body | foot rows: the header row holds the header's cells,
    // the bottom row its cells (section 1.8).
    expect(frame?.style.gridTemplateRows).toBe("var(--head-h) minmax(0, 1fr) var(--vex-h3-foot)");
    expect(frame?.getAttribute("data-vex-frame")).toBe("h3");
    expect(frame?.getAttribute("data-vex-tier")).toBe("wide");
    expect(frame?.style.getPropertyValue("--vex-vex-track")).toBe("280px");
    expect(
      view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open"),
    ).toBe("true");
    // She stands in her column, not in the welcome's centre.
    expect(view.container.querySelector("[data-vex-welcome-stage]")).toBeNull();
    expect(view.container.querySelector("[data-vex-area='welcome-portfolio']")).toBeNull();

    // A session: the chat runs from the chats to the window's edge (1192),
    // her panel a fixed 280 over its right, the room left of it 912.
    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(frame?.style.gridTemplateColumns).toBe("248px minmax(0, 1fr)");
    expect(
      view.container.querySelector("[data-vex-area='vex-sidebar']")?.getAttribute("data-vex-vex-open"),
    ).toBe("true");
    expect(frame?.style.getPropertyValue("--vex-vex-track")).toBe("280px");
    expect(frame?.style.getPropertyValue("--vex-chat-track")).toBe("1192px");
    expect(frame?.style.getPropertyValue("--vex-panel-w")).toBe("280px");
    // A page starts where the chat does: right after the chats.
    expect(frame?.style.getPropertyValue("--vex-overlay-left")).toBe("248px");
    // The header's VEX cell is over her panel, sharing its 280 with the
    // caption reserve at the right end.
    const head = view.container.querySelector<HTMLElement>("[data-vex-area='shell-head']");
    expect(head?.style.gridTemplateColumns).toContain(
      "[funds-end vex-start] calc(280px - var(--overlay-w)) [vex-end reserve-start]",
    );
  });

  it("stands Vex's panel at the right edge, after the chat, in the DOM and in focus order", () => {
    // docs/design/H3-DESKTOP.md section 6: chats | chat | her panel. The DOM follows
    // the screen, so the sequential focus order does too: nothing in the
    // frame reorders focus with a positive tabindex.
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const order = Array.from(frame?.children ?? [])
      .map((el) =>
        el.classList.contains("vex-shell-head") ? "header"
          : el.classList.contains("vex-left-page") ? "chats"
            : el.classList.contains("vex-shell-vex") ? "vex"
              : el.classList.contains("vex-shell-centre") ? "chat"
                : null,
      )
      .filter((name) => name !== null);
    expect(order).toEqual(["header", "chats", "chat", "vex"]);
    expect(frame?.querySelector("[tabindex]:not([tabindex='-1']):not([tabindex='0'])")).toBeNull();

    // The chat's composer comes before her console's keys in focus order.
    const aside = view.container.querySelector<HTMLElement>("[data-vex-area='vex-sidebar']");
    if (aside === null) throw new Error("no Vex column");
    const consoleKey = within(aside).getByRole("button", { name: "Open activity" });
    const seat = view.container.querySelector("[data-vex-composer-seat]");
    if (seat === null) throw new Error("the composer seat is missing");
    expect(seat.compareDocumentPosition(consoleKey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.unmount();

    // Under 1024 her console is the line OVER the chat: it comes first.
    setWindowWidth(1000);
    const band = renderShell();
    const bandOrder = Array.from(
      band.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']")?.children ?? [],
    )
      .map((el) =>
        el.classList.contains("vex-left-page") ? "chats"
          : el.classList.contains("vex-shell-vex") ? "vex"
            : el.classList.contains("vex-shell-centre") ? "chat"
              : null,
      )
      .filter((name) => name !== null);
    expect(bandOrder).toEqual(["chats", "vex", "chat"]);
  });

  it("follows the tiers at 1280, 1024 and 1000 x 720", () => {
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const solved = (width: number): string | undefined => {
      setWindowWidth(width);
      const view = renderShell();
      const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
      const columns = frame?.style.gridTemplateColumns;
      view.unmount();
      return columns;
    };
    // The stored default window: 248 | 1032, her panel over its right.
    expect(solved(1280)).toBe("248px minmax(0, 1fr)");
    // Under 1280: the rail, 76 | 948.
    expect(solved(1024)).toBe("76px minmax(0, 1fr)");
    // The band: the rail and the chat, 76 | 924.
    expect(solved(1000)).toBe("76px minmax(0, 1fr)");
  });

  it("from 1024 to 1279 keeps the chats the rail, the header's logo cell over it", () => {
    setWindowWidth(1024);
    useUiStore.setState({ activeSessionId: "s-1", leftOpen: true });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.getAttribute("data-vex-tier")).toBe("medium");
    expect(frame?.getAttribute("data-vex-sidebar-collapsed")).toBe("true");
    const page = view.container.querySelector("[data-vex-area='left-page']");
    expect(page?.getAttribute("data-vex-left-page")).toBe("spine");
    // The header runs across the rail: no cap of the rail's own, and the
    // logo cell stands alone over it.
    expect(page?.querySelector(".vex-left-page__cap")).toBeNull();
    const chats = view.container.querySelector("[data-vex-area='shell-head'] [data-vex-head-cell='chats']");
    expect(chats?.hasAttribute("data-rail")).toBe(true);
    expect(chats?.querySelector("[data-vex-head-cell='sidebar-key']")).toBeNull();
  });

  it("from 1024 to 1279 the rail's key opens the chats panel over the chat, and no track moves", () => {
    // docs/design/H3-DESKTOP.md sections 4.12 and 6, the money rule (section
    // 3.6): under 1280 the chats are the rail at every moment; the key slides
    // the chats panel over the chat (which stands beside the rail in D2)
    // instead of widening the track.
    setWindowWidth(1024);
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true, leftOpen: true });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const panel = (): HTMLElement | null =>
      view.container.querySelector<HTMLElement>("[data-vex-area='chats-panel']");
    const scrim = (): HTMLElement | null =>
      view.container.querySelector<HTMLElement>("[data-vex-area='chats-scrim']");
    const columns = frame?.style.gridTemplateColumns;
    expect(columns).toBe("76px minmax(0, 1fr)");
    expect(panel()?.hasAttribute("data-open")).toBe(false);
    expect(panel()?.hasAttribute("inert")).toBe(true);
    // What the panel and its scrim lie over: the chat and Vex's panel, her
    // bars at its foot. Live while the panel is closed.
    const vexColumn = (): Element | null => view.container.querySelector(".vex-shell-vex");
    const bars = (): Element | null => view.container.querySelector("[data-vex-area='vex-column-bars']");
    expect(vexColumn()?.hasAttribute("inert")).toBe(false);
    expect(vexColumn()?.contains(bars() as Node)).toBe(true);
    expect(view.container.querySelector("[data-vex-area='tagline-cell']")).toBeNull();

    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-controls")).toBe("chats-panel");
    fireEvent.click(expand);
    expect(panel()?.hasAttribute("data-open")).toBe(true);
    expect(panel()?.hasAttribute("inert")).toBe(false);
    expect(scrim()?.hasAttribute("data-open")).toBe(true);
    // Over the chat: the scrim runs to the window's edge, and the chat rests
    // behind it until it closes.
    expect(scrim()?.hasAttribute("data-covers")).toBe(true);
    expect(view.container.querySelector(".vex-shell-centre")?.hasAttribute("inert")).toBe(true);
    // Under the scrim Vex's panel rests too (C3-F-08, VEX Cloud's inert
    // scope): Tab and a screen reader never reach her console through it.
    expect(vexColumn()?.hasAttribute("inert")).toBe(true);
    // Nothing in the grid changed, and nothing was written.
    expect(frame?.style.gridTemplateColumns).toBe(columns);
    expect(useUiStore.getState().leftOpen).toBe(true);
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
    // The panel follows the rail in the DOM, so focus reaches it from the key.
    const order = Array.from(frame?.children ?? []).map((el) => el.getAttribute("data-vex-area") ?? el.className);
    expect(order.indexOf("chats-panel")).toBe(order.indexOf("left-page") + 2);
    expect(within(panel() as HTMLElement).getByRole("heading", { name: "Chats" })).toBeTruthy();

    // The same key closes it; so does the scrim, and Escape from inside.
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(panel()?.hasAttribute("inert")).toBe(true);
    // Closed, the chat and her panel are live again.
    expect(view.container.querySelector(".vex-shell-centre")?.hasAttribute("inert")).toBe(false);
    expect(vexColumn()?.hasAttribute("inert")).toBe(false);
    expect(frame?.style.gridTemplateColumns).toBe(columns);
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    fireEvent.pointerDown(scrim() as HTMLElement);
    expect(panel()?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    const field = within(panel() as HTMLElement).getByRole("searchbox", { name: "Search chats" });
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(panel()?.hasAttribute("inert")).toBe(true);
    // A press outside closes it as well.
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    fireEvent.pointerDown(view.container.querySelector(".vex-shell-centre") as HTMLElement);
    expect(panel()?.hasAttribute("inert")).toBe(true);
    view.unmount();

    // From 1280 the key folds the track as ever, and there is no panel.
    setWindowWidth(1440);
    const wide = renderShell();
    expect(wide.container.querySelector("[data-vex-area='chats-panel']")).toBeNull();
    expect(
      wide.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']")?.style.gridTemplateColumns,
    ).toBe("248px minmax(0, 1fr)");
    wide.unmount();
  });

  // C3-B-01, F-08 (VEX Cloud's W3 review, `nav-parts.tsx`): while the chats
  // panel is open, what it lies over rests, so Tab never leaves the panel for
  // it: Vex's panel (her console and bars and, under 1024, the band, all
  // inside `.vex-shell-vex`), and the chat where the panel covers. AppShell
  // sets `inert` on Vex's element while the panel is open.
  it("rests Vex's panel while the chats panel's scrim lies over it, at 1024 and in the band", () => {
    for (const width of [1024, 1000]) {
      setWindowWidth(width);
      useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
      const view = renderShell();
      const vex = view.container.querySelector<HTMLElement>(".vex-shell-vex");
      expect(vex?.hasAttribute("inert")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expect(vex?.hasAttribute("inert")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(vex?.hasAttribute("inert")).toBe(false);
      view.unmount();
    }
  });

  it("opens the chats panel from the rail's search with its field focused", () => {
    setWindowWidth(1180);
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const panel = view.container.querySelector<HTMLElement>("[data-vex-area='chats-panel']");
    expect(panel?.hasAttribute("data-open")).toBe(true);
    expect(document.activeElement).toBe(
      within(panel as HTMLElement).getByRole("searchbox", { name: "Search chats" }),
    );
  });

  it("holds the account cell and the chat's foot in a 72 bottom row, her bars at her panel's foot", () => {
    // docs/design/H3-DESKTOP.md sections 1.8 and 6.5 (owner decision
    // 2026-11-10): the bottom row runs from the account cell to the window's
    // right edge, with no cell of hers; her bars are her panel's foot strip.
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.style.gridTemplateRows).toBe("var(--head-h) minmax(0, 1fr) var(--vex-h3-foot)");
    // The account row moved out of the sidebar into the account cell.
    const account = view.container.querySelector<HTMLElement>("[data-vex-area='account-cell']");
    expect(account?.querySelector("[data-vex-area='sidebar-profile']")).not.toBeNull();
    expect(
      view.container.querySelector("[data-vex-area='sessions-sidebar'] [data-vex-area='sidebar-profile']"),
    ).toBeNull();
    expect(view.container.querySelectorAll("[data-vex-area='sidebar-profile']")).toHaveLength(1);
    // No bars cell in the row any more.
    expect(view.container.querySelector("[data-vex-area='tagline-cell']")).toBeNull();
    expect(view.container.querySelector(".vex-shell-tagline")).toBeNull();
    // Her bars, no words, as the last part of her panel, after Open activity.
    const panel = view.container.querySelector<HTMLElement>("[data-vex-area='vex-column-body']");
    const bars = panel?.querySelector<HTMLElement>("[data-vex-area='vex-column-bars']");
    expect(bars?.querySelector("[data-vex-area='vex-foot']")?.getAttribute("data-vex-foot-words")).toBe("none");
    expect(bars?.querySelector("[data-vex-area='vex-bars']")).not.toBeNull();
    expect(bars?.querySelector(".vex-tagline")).toBeNull();
    expect(bars?.textContent).toBe("");
    expect(panel?.lastElementChild).toBe(bars);
    // Hidden, they go with her panel.
    act(() => useUiStore.getState().setVexOpen(false));
    expect(view.container.querySelector("[data-vex-area='vex-column-bars']")).toBeNull();
    expect(view.container.querySelector("[data-vex-area='vex-bars']")).toBeNull();
    act(() => useUiStore.getState().setVexOpen(true));
    // Each part follows its column in the DOM: chats, account, chat, Vex.
    const order = Array.from(frame?.children ?? [])
      .map((el) =>
        el.classList.contains("vex-left-page") ? "chats"
          : el.classList.contains("vex-shell-account") ? "account"
            : el.classList.contains("vex-shell-vex") ? "vex"
              : el.classList.contains("vex-shell-centre") ? "chat"
                : null,
      )
      .filter((name) => name !== null);
    expect(order).toEqual(["chats", "account", "chat", "vex"]);
    // Folded to the rail, the account cell is the rail's box.
    fireEvent.click(screen.getByRole("button", { name: /^Collapse sidebar$/i }));
    expect(account?.hasAttribute("data-rail")).toBe(true);
  });

  it("under 1024 seats Vex as the console line under the header, her band over the chat", () => {
    // docs/design/H3-DESKTOP.md section 1.10: no Vex track; a fourth row of
    // the frame, the 48 console line, and her band a box over the chat under
    // it, closed on every visit (the session's own choice, never persisted).
    setWindowWidth(1000);
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true, vexOpenNarrow: false });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.getAttribute("data-vex-seat")).toBe("band");
    expect(frame?.getAttribute("data-vex-band")).toBe("closed");
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr)");
    // No panel and no room for one: the band is drawn in the chat.
    expect(frame?.style.getPropertyValue("--vex-panel-w")).toBe("0px");
    expect(frame?.hasAttribute("data-vex-panel")).toBe(false);
    expect(frame?.style.gridTemplateRows).toBe("var(--head-h) 48px minmax(0, 1fr) var(--vex-h3-foot)");
    const aside = view.container.querySelector("[data-vex-area='vex-sidebar']");
    expect(aside?.getAttribute("data-vex-seat")).toBe("band");
    // The console line, with her state as its first key, and her band.
    const line = aside?.querySelector("[data-vex-area='vex-console-strip']");
    expect(line?.hasAttribute("data-band")).toBe(true);
    const lineKey = aside?.querySelector<HTMLElement>("[data-vex-area='vex-console-line-key']");
    expect(lineKey?.getAttribute("aria-label")).toBe("Show Vex");
    const section = aside?.querySelector("[data-vex-area='kimm-section']");
    expect(section?.getAttribute("data-kimm-seat")).toBe("band");
    expect(section?.getAttribute("data-kimm-open")).toBe("false");
    // No column stands under the header's VEX cell: it is as wide as what
    // it holds, at the right end.
    const head = view.container.querySelector<HTMLElement>("[data-vex-area='shell-head']");
    expect(head?.style.gridTemplateColumns).toContain("[funds-end vex-start] auto [vex-end");
    // Opening it writes the session's own choice, never the chat's.
    fireEvent.click(lineKey as HTMLElement);
    expect(useUiStore.getState().vexOpenNarrow).toBe(true);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(frame?.getAttribute("data-vex-band")).toBe("open");
    expect(section?.getAttribute("data-kimm-open")).toBe("true");
    // Its foot row closes it.
    fireEvent.click(within(section as HTMLElement).getByRole("button", { name: "Hide Vex" }));
    expect(useUiStore.getState().vexOpenNarrow).toBe(false);
    expect(frame?.getAttribute("data-vex-band")).toBe("closed");
    expect(frame?.style.gridTemplateRows).toBe("var(--head-h) 48px minmax(0, 1fr) var(--vex-h3-foot)");
    // A page under 1024 keeps the console line and her band.
    act(() => useUiStore.getState().navigate("portfolio"));
    expect(frame?.getAttribute("data-vex-seat")).toBe("band");
    expect(aside?.querySelector("[data-vex-area='vex-console-strip']")).not.toBeNull();
  });

  it("folds the console to the page strip on a table page with her closed, and back to her panel", () => {
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true, vexOpenPages: false });
    const view = renderShell();
    const aside = (): Element | null => view.container.querySelector("[data-vex-area='vex-sidebar']");
    const strip = (): Element | null => view.container.querySelector("[data-vex-area='vex-console-strip']");
    // In a chat her column stands: no strip.
    expect(strip()).toBeNull();
    act(() => useUiStore.getState().navigate("portfolio"));
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.getAttribute("data-vex-seat")).toBe("strip");
    expect(frame?.style.getPropertyValue("--vex-panel-w")).toBe("0px");
    expect(aside()?.getAttribute("data-vex-seat")).toBe("strip");
    expect(strip()?.textContent).toContain("Needs you");
    expect(strip()?.textContent).toContain("Open activity");
    // Shown on the page, her panel stands, keeping its room, and the strip goes.
    act(() => useUiStore.getState().setVexOpen(true));
    expect(frame?.getAttribute("data-vex-seat")).toBe("column");
    expect(frame?.style.getPropertyValue("--vex-panel-w")).toBe("280px");
    expect(strip()).toBeNull();
    expect(aside()?.querySelector("[data-vex-area='vex-console-top']")).not.toBeNull();
  });

  it("under 1024 the rail's key opens the chats panel over what is read, the chat resting behind it", () => {
    setWindowWidth(1000);
    useUiStore.setState({ activeSessionId: "s-1", leftOpen: true });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.getAttribute("data-vex-tier")).toBe("band");
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr)");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr)");
    expect(
      view.container.querySelector("[data-vex-area='chats-scrim']")?.hasAttribute("data-covers"),
    ).toBe(true);
    expect(view.container.querySelector(".vex-shell-centre")?.hasAttribute("inert")).toBe(true);
    // Her band and console line rest under it too.
    expect(view.container.querySelector(".vex-shell-vex")?.hasAttribute("inert")).toBe(true);
    expect(useUiStore.getState().leftOpen).toBe(true);
  });

  it("a page opened from the welcome keeps its name, and the Vex key its cell", () => {
    const view = renderShell();
    const head = (): Element | null =>
      view.container.querySelector("[data-vex-area='shell-status-strip']");
    // The bare welcome: no title to say, and the Vex key in its cell, her column
    // standing beside the welcome (H3-DESKTOP.md section 1.7).
    expect(head()?.hasAttribute("data-empty")).toBe(true);
    expect(view.container.querySelector("[data-vex-area='vex-key']")).not.toBeNull();

    // A page covers the welcome and is not part of it.
    act(() => useUiStore.getState().navigate("portfolio"));
    expect(head()?.hasAttribute("data-empty")).toBe(false);
    expect(
      view.container.querySelector("[data-vex-area='title-bar-title']")?.textContent,
    ).toBe("Portfolio");
    expect(view.container.querySelector("[data-vex-area='vex-key']")).not.toBeNull();

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
    // The welcome head has nothing to say.
    expect(head?.hasAttribute("data-empty")).toBe(true);
    // The header is one drag region, and so is each of its cells that is not
    // a control; the chats cell clears the macOS traffic lights.
    const header = view.container.querySelector("[data-vex-area='shell-head']");
    expect(header?.classList.contains("vex-drag")).toBe(true);
    for (const cell of ["chats", "vex-key", "title", "funds", "caption-reserve"]) {
      expect(
        header?.querySelector(`[data-vex-head-cell='${cell}']`)?.classList.contains("vex-drag"),
        cell,
      ).toBe(true);
    }
    const sidebarHead = header?.querySelector("[data-vex-head-cell='chats']");
    expect(sidebarHead?.classList.contains("vex-lights-start")).toBe(true);
    // The sidebar no longer draws a head row of its own under the header.
    expect(view.container.querySelector("[data-vex-area='sessions-sidebar'] header")).toBeNull();
  });

  it("keeps her panel's room a LENGTH on both sides of the welcome<->session edge", () => {
    // `auto` <-> length is not interpolable (owner QA item 8, when the frame
    // still animated its tracks): every state must emit lengths. D2 has two
    // tracks and her panel's room beside them (`--vex-panel-w`).
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const room = (): string => frame?.style.getPropertyValue("--vex-panel-w") ?? "";

    // Welcome: her panel stands there too, the same room as in a chat.
    expect(room()).toBe("280px");
    // Session stage: shown, then hidden (her room kept), the same room.
    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(room()).toBe("280px");
    act(() => useUiStore.getState().setVexOpen(false));
    expect(room()).toBe("280px");
    expect(frame?.getAttribute("data-vex-panel")).toBe("hidden");
    // A table page with her hidden folds her to its strip: zero, a length.
    act(() => useUiStore.getState().navigate("portfolio"));
    expect(room()).toBe("0px");
    act(() => useUiStore.getState().setVexOpen(true));
    expect(room()).toBe("280px");
    expect(frame?.getAttribute("data-vex-panel")).toBe("shown");
    // Every track of the frame is a length beside the chat's 1fr.
    expect(frame?.style.gridTemplateColumns).toMatch(/^\d+px minmax\(0, 1fr\)$/);
  });

  it("in a chat never moves a track for her: hiding Vex keeps her panel's room, at every size", () => {
    // docs/design/H3-DESKTOP.md sections 3.6 and 6.4, the money rule's first
    // leg: the chat's track and her panel's room are a function of the window
    // alone. The stored choice reaches whether her panel shows, never the
    // grid or the room, in the columns and in the band; under 1024 her band
    // follows the session's own choice (section 1.10).
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true, vexOpenNarrow: true });
    for (const width of [1000, 1023, 1024, 1280, 1366, 1440, 1920, 2560]) {
      const narrow = width < 1024;
      const show = (open: boolean): void => {
        if (narrow) useUiStore.getState().setVexOpenNarrow(open);
        else useUiStore.getState().setVexOpen(open);
      };
      setWindowWidth(width);
      const view = renderShell();
      const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
      const shown = {
        columns: frame?.style.gridTemplateColumns,
        rows: frame?.style.gridTemplateRows,
        room: frame?.style.getPropertyValue("--vex-panel-w"),
        chat: frame?.style.getPropertyValue("--vex-chat-track"),
        head: view.container.querySelector<HTMLElement>("[data-vex-area='shell-head']")?.style
          .gridTemplateColumns,
      };
      const aside = (): Element | null => view.container.querySelector("[data-vex-area='vex-sidebar']");
      // Shown: her band under 1024, her panel from 1024 up.
      const shownNow = (): string | null | undefined =>
        narrow
          ? aside()?.querySelector("[data-vex-area='kimm-section']")?.getAttribute("data-kimm-open")
          : aside()?.getAttribute("data-vex-shown");
      expect(shownNow(), String(width)).toBe("true");
      act(() => show(false));
      expect(
        {
          columns: frame?.style.gridTemplateColumns,
          rows: frame?.style.gridTemplateRows,
          room: frame?.style.getPropertyValue("--vex-panel-w"),
          chat: frame?.style.getPropertyValue("--vex-chat-track"),
          head: view.container.querySelector<HTMLElement>("[data-vex-area='shell-head']")?.style
            .gridTemplateColumns,
        },
        String(width),
      ).toEqual(shown);
      // Her room is kept; her panel went, the aside empty.
      expect(aside()?.getAttribute("data-vex-vex-open"), String(width)).toBe("true");
      expect(shownNow(), String(width)).toBe("false");
      if (!narrow) expect(aside()?.childElementCount, String(width)).toBe(0);
      // The stored flag is the same one the toggle always wrote; under 1024
      // the session's own, the chat's untouched.
      expect(useUiStore.getState().vexOpenChat).toBe(narrow);
      expect(useUiStore.getState().vexOpenNarrow).toBe(!narrow);
      act(() => show(true));
      view.unmount();
    }
  });

  it("never hides or shows her on Escape, wherever it is pressed", () => {
    // docs/design/H3-DESKTOP.md sections 3.5 and 4.4 (plan row S4-13): Esc
    // belongs to the money card and to what it is pressed in; her column
    // moves only on her key and the chord. The walk of every Escape handler
    // is `components/vex/kimm/__tests__/kimm-escape.test.ts`.
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();
    const column = (): Element | null => view.container.querySelector("[data-vex-area='vex-sidebar']");
    const places = (): (HTMLElement | null)[] => [
      document.body,
      view.container.querySelector<HTMLElement>("[data-vex-area='vex-column-foot'] button"),
      view.container.querySelector<HTMLElement>("[data-vex-area='vex-key']"),
      view.container.querySelector<HTMLElement>("[data-vex-area='vex-console-top'] button"),
      view.container.querySelector<HTMLElement>("[data-vex-composer-stage] textarea"),
    ];
    for (const open of [true, false]) {
      act(() => useUiStore.setState({ vexOpenChat: open }));
      for (const place of places()) {
        if (place === null) continue;
        place.focus();
        fireEvent.keyDown(place, { key: "Escape", code: "Escape" });
        fireEvent.keyUp(place, { key: "Escape", code: "Escape" });
        fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
        expect(useUiStore.getState().vexOpenChat, place.tagName).toBe(open);
        expect(column()?.getAttribute("data-vex-shown"), place.tagName).toBe(String(open));
      }
    }
    expect(places().filter((place) => place !== null).length).toBeGreaterThanOrEqual(3);
  });

  it("the header's VEX key flips the same flag both ways, the column standing", () => {
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    const view = renderShell();
    const aside = view.container.querySelector<HTMLElement>("[data-vex-area='vex-sidebar']");
    if (aside === null) throw new Error("no Vex column");
    // The column has no hide key of its own (D2, section 6.4): the header's
    // VEX key hides her whole column's body, the column's room stands, focus
    // stays on the key. The write lands at the press; nothing waits.
    expect(within(aside).queryAllByRole("button", { name: /^(Hide|Show) Vex$/ })).toHaveLength(0);
    const key = view.container.querySelector<HTMLElement>("[data-vex-area='vex-key']");
    if (key === null) throw new Error("no Vex key");
    expect(key.getAttribute("aria-label")).toBe("Hide Vex");
    key.focus();
    fireEvent.click(key);
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    expect(aside.getAttribute("data-vex-vex-open")).toBe("true");
    expect(aside.getAttribute("data-vex-shown")).toBe("false");
    expect(aside.childElementCount).toBe(0);
    expect(document.activeElement).toBe(key);
    expect(key.getAttribute("aria-label")).toBe("Show Vex");
    // The same key shows her again.
    fireEvent.click(key);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(aside.getAttribute("data-vex-shown")).toBe("true");
    expect(aside.querySelector("[data-vex-area='vex-portrait-card']")).not.toBeNull();
  });

  it("binds Ctrl+Shift+B at the shell: it opens and closes her from anywhere, a page included", () => {
    // docs/design/H3-DESKTOP.md section 4.4: one listener at the shell, not one
    // that lives only while a key is mounted. Reduced motion: no close episode.
    reducedMotion = true;
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true });
    renderShell();
    const chord = (target: EventTarget): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", {
        code: "KeyB",
        key: "B",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };
    // She closes, once, and the shell takes the key.
    expect(chord(document.body).defaultPrevented).toBe(true);
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    chord(document.body);
    expect(useUiStore.getState().vexOpenChat).toBe(true);

    // On a table page the chord writes the pages' own choice.
    act(() => useUiStore.getState().navigate("portfolio"));
    expect(useUiStore.getState().vexOpenPages).toBe(false);
    chord(document.body);
    expect(useUiStore.getState().vexOpenPages).toBe(true);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
  });

  it("mounts no sidebar drag handle: the left and Vex widths are fixed", () => {
    const view = renderShell();
    expect(view.container.querySelector(".vex-shell-handle")).toBeNull();
    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(view.container.querySelector(".vex-shell-handle")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /^Collapse sidebar$/i }),
    );
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    // The folded chats column is the fixed 76px rail; her panel keeps its 280.
    expect(frame?.style.gridTemplateColumns).toBe("76px minmax(0, 1fr)");
    expect(frame?.style.getPropertyValue("--vex-panel-w")).toBe("280px");
    expect(view.container.querySelector(".vex-shell-handle")).toBeNull();
  });

  it("no longer reads the stored drag width: the left column keeps its spec width", () => {
    const view = renderShell();
    act(() => useUiStore.getState().setSidebarWidth(342));
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    expect(frame?.style.gridTemplateColumns).toBe("248px minmax(0, 1fr)");
  });

  it("hides Vex by default on the table pages and opens the page inside the centre", () => {
    useUiStore.setState({ activeSessionId: "s-1", vexOpenChat: true, vexOpenPages: false });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const room = (): string | undefined => frame?.style.getPropertyValue("--vex-panel-w");
    expect(frame?.style.gridTemplateColumns).toBe("248px minmax(0, 1fr)");
    expect(room()).toBe("280px");

    act(() => useUiStore.getState().navigate("portfolio"));
    expect(frame?.style.gridTemplateColumns).toBe("248px minmax(0, 1fr)");
    expect(room()).toBe("0px");
    const page = view.container.querySelector("[data-vex-area='shell-screen']");
    expect(page?.getAttribute("aria-label")).toBe("Portfolio");
    // Inside the centre column: both sidebars stay standing beside it.
    expect(page?.closest(".vex-shell-centre")).not.toBeNull();
    expect(view.container.querySelector("[data-vex-area='sessions-sidebar']")).not.toBeNull();

    // Back in the chat, Vex is open again: hiding her on a page never closed her there.
    act(() => useUiStore.getState().navigate("chat"));
    expect(room()).toBe("280px");
    expect(frame?.getAttribute("data-vex-panel")).toBe("shown");
  });

  it("keeps Vex's panel across the welcome<->session edge: the same node, the same room", () => {
    // docs/design/H3-DESKTOP.md section 1.7: the welcome has her panel, so
    // the first message moves nothing beside the chat and remounts nothing.
    useUiStore.setState({ vexOpenChat: true });
    const view = renderShell();
    const frame = view.container.querySelector<HTMLElement>("[data-vex-area='shell-frame']");
    const aside = view.container.querySelector("[data-vex-area='vex-sidebar']");
    const before = [frame?.style.gridTemplateColumns, frame?.style.getPropertyValue("--vex-panel-w")];
    act(() => useUiStore.getState().setActiveSessionId("s-1"));
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")).toBe(aside);
    expect([frame?.style.gridTemplateColumns, frame?.style.getPropertyValue("--vex-panel-w")]).toEqual(before);
    act(() => useUiStore.getState().setActiveSessionId(null));
    expect(view.container.querySelector("[data-vex-area='vex-sidebar']")).toBe(aside);
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
    fireEvent.click(screen.getByRole("button", { name: /^Collapse sidebar$/i }));
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
