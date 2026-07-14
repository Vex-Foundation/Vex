import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { sessionKeys } from "../../../../lib/api/sessions.js";
import { createQueryClient } from "../../../../app/queryClient.js";
import { useUiStore } from "../../../../stores/uiStore.js";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));

vi.mock("@hugeicons/core-free-icons", () => ({
  Add01Icon: "Add01Icon",
  AiChat01Icon: "AiChat01Icon",
  // S5 act ledger — ToolLedger/toolGlyph.ts imports these four.
  AiWebBrowsingIcon: "AiWebBrowsingIcon",
  File01Icon: "File01Icon",
  TerminalIcon: "TerminalIcon",
  Wrench01Icon: "Wrench01Icon",
  AlertCircleIcon: "AlertCircleIcon",
  Archive02Icon: "Archive02Icon",
  ArrowDown01Icon: "ArrowDown01Icon",
  ArrowLeft01Icon: "ArrowLeft01Icon",
  ArrowRight01Icon: "ArrowRight01Icon",
  ArrowUp01Icon: "ArrowUp01Icon",
  BitcoinWalletIcon: "BitcoinWalletIcon",
  BridgeIcon: "BridgeIcon",
  BubbleChatSparkIcon: "BubbleChatSparkIcon",
  Bug02Icon: "Bug02Icon",
  ChartCandlestickIcon: "ChartCandlestickIcon",
  CheckmarkCircle02Icon: "CheckmarkCircle02Icon",
  Clock03Icon: "Clock03Icon",
  DatabaseLightningIcon: "DatabaseLightningIcon",
  Delete02Icon: "Delete02Icon",
  Exchange01Icon: "Exchange01Icon",
  FilterHorizontalIcon: "FilterHorizontalIcon",
  Fuel01Icon: "Fuel01Icon",
  Brain01Icon: "Brain01Icon",
  MapPinIcon: "MapPinIcon",
  PanelLeftCloseIcon: "PanelLeftCloseIcon",
  PanelLeftOpenIcon: "PanelLeftOpenIcon",
  PanelRightCloseIcon: "PanelRightCloseIcon",
  PanelRightOpenIcon: "PanelRightOpenIcon",
  Search01Icon: "Search01Icon",
  Settings02Icon: "Settings02Icon",
  Shield02Icon: "Shield02Icon",
  SparklesIcon: "SparklesIcon",
  StarIcon: "StarIcon",
  StopCircleIcon: "StopCircleIcon",
  Target02Icon: "Target02Icon",
  Wallet01Icon: "Wallet01Icon",
  ZapIcon: "ZapIcon",
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
  missionGetDraftMock.mockReset();
  runtimeGetStateMock.mockReset();
  // SessionComposer queries mission.getDraft + runtime.getState as soon as a
  // session is active (Send gate moved to activeSessionId). Benign defaults:
  // no draft, no run status (free text allowed).
  missionGetDraftMock.mockResolvedValue({ ok: true, data: null });
  runtimeGetStateMock.mockResolvedValue({ ok: true, data: { status: null } });
  useUiStore.setState({
    sidebarOpen: true,
    currentView: "appShell",
    wizardEntryMode: "setup",
    unlockReturnView: "appShell",
    logBuffer: [],
    sessionModeFilter: "all",
    activeSessionId: null,
    appShellView: "session",
    createSessionOpen: false,
    createSessionInitialMessage: null,
    pendingFirstMessage: null,
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
      // Stage 8-2b: a selected-session SessionPanel mounts SessionTranscript,
      // which pages through window.vex.messages.list. Default = empty page.
      messages: {
        list: messagesListMock,
      },
      // HL Phase 4a: AppShell mounts the Hyperliquid positions live-sync hook
      // (`useHyperliquidPositions`), which subscribes via window.vex.hyperliquid.
      // No-op stubs keep shell tests independent of the HL bridge surface.
      hyperliquid: {
        getPositions: vi.fn().mockResolvedValue({ ok: true, data: { sessionId: "", positions: [] } }),
        getCandles: vi.fn().mockResolvedValue({ ok: true, data: { coin: "", interval: "1h", candles: [] } }),
        listRiskProposals: vi.fn().mockResolvedValue({ ok: true, data: { sessionId: "", proposals: [] } }),
        confirmRiskProposal: vi.fn(),
        onPositionsUpdate: () => () => {},
        onRiskProposalUpdate: () => () => {},
        onWorkspaceMode: () => () => {},
        exitWorkspace: vi.fn(),
      },
      // Agent integration puzzle 2/09 + F5: SessionPanel mounts
      // `useTranscriptLiveSync` + `useStreamPreviewSync` +
      // `useControlStateLiveSync`, which subscribe to the engine bridge. Stubs
      // return a no-op unsubscribe so tests that exercise the panel don't crash
      // on missing bridge surface.
      engine: {
        onTranscriptAppend: () => () => {},
        onStreamDelta: () => () => {},
        onControlState: () => () => {},
      },
      // T1: the sidebar mounts VexTokenCardCompact → useVexMarket reads
      // getVexSnapshot + subscribes onVexUpdate. Stubs keep the widget in its
      // loading state without a live market feed.
      market: {
        getVexSnapshot: () => Promise.resolve({ ok: true, data: null }),
        onVexUpdate: () => () => {},
      },
    },
  });
});

describe("AppShell", () => {
  it("submits composer text to the active session via chat IPC", async () => {
    const row = makeAgentRow("Quick chat");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    await screen.findByText("Quick chat");

    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, {
      target: { value: "Research $TAO liquidity and thesis" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatSubmitMock).toHaveBeenCalledTimes(1));
    expect(chatSubmitMock).toHaveBeenCalledWith({
      sessionId: row.id,
      message: "Research $TAO liquidity and thesis",
    });
    await waitFor(() => expect(draft.value).toBe(""));
    // Batch 3: a plain chat send no longer shows a redundant "Message sent."
    // notice — the reply renders in the transcript instead.
    expect(screen.queryByText("Message sent.")).toBeNull();
  });

  it("shows quick-action chips in an empty session and hides them once it has messages", async () => {
    const row = makeAgentRow("Chips");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });
    // Empty transcript (default mock) → chips are visible as conversation starters.
    renderShell();
    await screen.findByText("Chips");
    expect(await screen.findByRole("button", { name: /wallet balances/i })).not.toBeNull();
  });

  it("hides quick-action chips once the session transcript has messages", async () => {
    const row = makeAgentRow("Has msgs");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });
    messagesListMock.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: 1,
            sessionId: row.id,
            role: "user",
            kind: "text",
            content: "hi vex",
            createdAt: new Date().toISOString(),
            toolCallId: null,
            toolName: null,
            toolCalls: null,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    renderShell();
    await screen.findByText("hi vex");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /wallet balances/i })).toBeNull(),
    );
  });

  it("ENTER in the draft sends the message and clears the input", async () => {
    const row = makeAgentRow("Enter send");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    await screen.findByText("Enter send");

    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "gm vex" } });
    fireEvent.keyDown(draft, { key: "Enter" });

    await waitFor(() => expect(chatSubmitMock).toHaveBeenCalledTimes(1));
    expect(chatSubmitMock).toHaveBeenCalledWith({ sessionId: row.id, message: "gm vex" });
    await waitFor(() => expect(draft.value).toBe(""));
  });

  it("Shift+Enter does NOT send (keeps the draft for a newline)", async () => {
    const row = makeAgentRow("Shift enter");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    await screen.findByText("Shift enter");

    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "line one" } });
    fireEvent.keyDown(draft, { key: "Enter", shiftKey: true });

    expect(chatSubmitMock).not.toHaveBeenCalled();
    expect(draft.value).toBe("line one");
  });

  it("ENTER while a turn is pending does not start a second submit (pending guard, not empty guard)", async () => {
    const row = makeAgentRow("Pending guard");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });
    // Never settles → the turn stays pending (Stop stays mounted).
    chatSubmitMock.mockReturnValue({
      promise: new Promise<never>(() => {}),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("Pending guard");

    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "first" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    await waitFor(() => expect(chatSubmitMock).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Stop generating" });

    // Type a NEW non-empty draft (so the empty-message guard is NOT what blocks)
    // and press Enter again — the pending guard must keep it at one submit.
    fireEvent.change(draft, { target: { value: "second" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(chatSubmitMock).toHaveBeenCalledTimes(1);
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
