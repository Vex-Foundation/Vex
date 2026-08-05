import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));

vi.mock("../../../../components/icons/icon-glyphs.js", () => ({
  PlusIcon: "PlusIcon",
  AnalyticsUpIcon: "AnalyticsUpIcon",
  DownloadIcon: "DownloadIcon",
  MessageSquareIcon: "MessageSquareIcon",
  // S5 act ledger — ToolLedger/toolGlyph.ts imports these four.
  GlobeIcon: "GlobeIcon",
  FileIcon: "FileIcon",
  TerminalIcon: "TerminalIcon",
  WrenchIcon: "WrenchIcon",
  CircleAlertIcon: "CircleAlertIcon",
  ArchiveIcon: "ArchiveIcon",
  ChevronDownIcon: "ChevronDownIcon",
  ChevronLeftIcon: "ChevronLeftIcon",
  ChevronRightIcon: "ChevronRightIcon",
  ArrowUpIcon: "ArrowUpIcon",
  ArrowDataTransferHorizontalIcon: "ArrowDataTransferHorizontalIcon",
  ArrowUpRightIcon: "ArrowUpRightIcon",
  CoinsSwapIcon: "CoinsSwapIcon",
  // Chronos: SidebarProfile's "How Vex works" menu entry.
  BookOpenIcon: "BookOpenIcon",
  BridgeIcon: "BridgeIcon",
  BubbleChatSparkIcon: "BubbleChatSparkIcon",
  BugIcon: "BugIcon",
  XIcon: "XIcon",
  ChartCandlestickIcon: "ChartCandlestickIcon",
  CircleCheckBigIcon: "CircleCheckBigIcon",
  Clock03Icon: "Clock03Icon",
  DatabaseLightningIcon: "DatabaseLightningIcon",
  Trash2Icon: "Trash2Icon",
  FlameIcon: "FlameIcon",
  ChartLineData01Icon: "ChartLineData01Icon",
  FilterHorizontalIcon: "FilterHorizontalIcon",
  BrainIcon: "BrainIcon",
  MapPinIcon: "MapPinIcon",
  PanelLeftCloseIcon: "PanelLeftCloseIcon",
  PanelLeftOpenIcon: "PanelLeftOpenIcon",
  PanelRightCloseIcon: "PanelRightCloseIcon",
  PanelRightOpenIcon: "PanelRightOpenIcon",
  SearchIcon: "SearchIcon",
  CircleStopIcon: "CircleStopIcon",
  RadarIcon: "RadarIcon",
  Settings2Icon: "Settings2Icon",
  Shield02Icon: "Shield02Icon",
  SparklesIcon: "SparklesIcon",
  StarIcon: "StarIcon",
  TargetIcon: "TargetIcon",
  PercentIcon: "PercentIcon",
  // Chronos: SidebarProfile's "Personalize" menu entry (opens VexSetupDialog).
  UserPenIcon: "UserPenIcon",
  // Welcome Portfolio tab (BookPanel's welcome stage): handle + card icons.
  WalletIcon: "WalletIcon",
  ZapIcon: "ZapIcon",
}));

// Phase 2b: the Settings ShellScreen hosts the wizard step forms, whose
// module graph (icons, RHF, brand marks) is far beyond this suite's
// partial mocks. The screen has its own suite; a stub keeps THIS suite's
// AppShell import light.
vi.mock("../../screens/SettingsScreen.js", () => ({
  SettingsScreen: () => null,
}));

// Same reason: the Agent Scan ShellScreen pulls the virtualizer and the whole
// agent-scan feed module graph. This suite asserts the menu ROUTE, not the
// screen — Agent Scan has its own suite.
vi.mock("../../screens/AgentScanScreen.js", () => ({
  AgentScanScreen: () => null,
}));

vi.mock("@thesvg/react", () => ({
  Docker: () => null,
  Ethereum: () => null,
  Solana: () => null,
  Base: () => null,
  Robinhood: () => null,
  Polygon: () => null,
  Optimism: () => null,
  BnbChain: () => null,
  Tether: () => null,
  Circle: () => null,
  Chainlink: () => null,
  Postgresql: () => null,
  Bitcoin: () => null,
  Bnb: () => null,
  DaiStablecoin: () => null,
  Usdc: () => null,
}));

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
const missionGetDraftMock = vi.fn();
const runtimeGetStateMock = vi.fn();

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
    show?: () => void;
  };
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModalPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function closePolyfill(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
  if (typeof proto.show !== "function") {
    proto.show = function showPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }

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
    },
  });
});

describe("AppShell", () => {
  it("renders the Vex shell hero and the profile footer with the night-shift hallmark", async () => {
    renderShell();

    // The H1 display statement is DELETED (owner decree 2026-07-21): the
    // welcome crown is the [sigil + PREVIEW wordmark] logo row, pinned
    // close-range in SessionWelcomeHero.test.tsx and via the badge below.
    expect(
      screen.queryByRole("heading", { name: /What should I execute\?/i }),
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: /New session/i }).length).toBeGreaterThan(0);
    // Healthy runtime → the profile subtitle speaks the Chronos hallmark.
    await screen.findByText("The night shift is active.");
    // The bare version stamp lives in the SESSION rail's collapse header;
    // on the welcome stage the right edge is the floating Portfolio tab
    // (no version chrome) and the hero's PREVIEW badge carries the version.
    expect(screen.queryByText("v0.0.0-test")).toBeNull();
    expect(screen.getByText("PREVIEW · v0.0.0-test")).not.toBeNull();
  });

  it("profile menu carries exactly six entries (no Missions — Sessions covers it)", async () => {
    renderShell();
    await screen.findByText("The night shift is active.");

    fireEvent.click(screen.getByRole("button", { name: /Open menu/i }));
    // The status row speaks ONE short word (the long RuntimeLedger strings
    // are retired), beside the Docker/Postgres marks.
    expect(screen.getByText("Connected")).not.toBeNull();
    expect(screen.queryByText("Connected to local runtime")).toBeNull();

    // The six menu entries (each screen row with its hint subline) — the
    // Missions entry/screen is retired (owner: Sessions covers it); Agent Scan
    // sits between Sessions and How Vex works.
    for (const entry of [
      "Personalize",
      "Memory",
      "Sessions",
      "Agent Scan",
      "How Vex works",
      "Settings",
    ]) {
      expect(
        screen.getByRole("menuitem", { name: new RegExp(entry, "i") }),
      ).not.toBeNull();
    }
    expect(screen.getAllByRole("menuitem")).toHaveLength(6);
    expect(screen.queryByRole("menuitem", { name: /Missions/i })).toBeNull();
    expect(screen.queryByText("Results ledger")).toBeNull();
    expect(screen.getByText("What Vex has learned")).not.toBeNull();
    expect(screen.getByText("Find any conversation")).not.toBeNull();
    expect(screen.getByText("Every move, verified on-chain")).not.toBeNull();
    expect(screen.getByText("Start here — the five-minute tour")).not.toBeNull();

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

  it("shows no pulsing dots anywhere — status is color + words, never motion", async () => {
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
    expect(screen.getAllByText("Arbitrum LP Rebalance").length).toBeGreaterThan(0);
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

  it("filters the sidebar by mission mode", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();
    await screen.findByText("Portfolio Check");

    fireEvent.click(screen.getByRole("tab", { name: "Mission" }));

    expect(screen.getAllByText("Arbitrum LP Rebalance").length).toBeGreaterThan(0);
    expect(screen.queryByText("Portfolio Check")).toBeNull();
  });

  it("mounts the Eclipse photo backdrop layer behind the columns", () => {
    const view = renderShell();

    const backdrop = view.container.querySelector(
      "[data-vex-area='shell-backdrop']",
    );
    expect(backdrop).not.toBeNull();
    // Welcome/idle stage → the light veil (artwork is the protagonist).
    expect(backdrop?.getAttribute("data-vex-backdrop-dimmed")).toBe("false");
    expect(
      backdrop?.querySelector("img")?.getAttribute("src"),
    ).toBe("/backdrops/midnight-lake.webp");
  });

  it("applies the Chronos theme to the shell root as data-vex-theme", () => {
    const view = renderShell();
    const root = view.container.querySelector('[data-vex-screen="appShell"]');
    expect(root?.getAttribute("data-vex-theme")).toBe("chronos");
  });

  it("collapses and expands the glass sidebar", async () => {
    const view = renderShell();
    const sidebar = view.container.querySelector("[data-vex-area='sessions-sidebar']");

    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse sessions sidebar/i }),
    );
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: /Expand sessions sidebar/i }),
    );
    expect(sidebar?.getAttribute("data-vex-sidebar-open")).toBe("true");
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
    expect(mark?.tagName).toBe("IMG");
    expect(mark?.getAttribute("src")).toBe("/logo_clean.png");
    expect(mark?.textContent).toBe("");
  });

  it("mounts the compact $VEX widget in the sidebar rail, not on the welcome stage", async () => {
    const view = renderShell();
    const sidebar = view.container.querySelector(
      "[data-vex-area='sessions-sidebar']",
    );
    // The market bridge mock returns null → the widget shows its loading
    // skeleton, proving it lives in the rail.
    await waitFor(() => {
      expect(
        sidebar?.querySelector("[data-vex-area='vex-token-compact']"),
      ).not.toBeNull();
    });
    // The welcome panel no longer carries any market card — the stage is clean.
    const panel = view.container.querySelector(
      "[data-vex-area='session-panel']",
    );
    expect(
      panel?.querySelector("[data-vex-area='vex-token-compact']"),
    ).toBeNull();
  });

});

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
