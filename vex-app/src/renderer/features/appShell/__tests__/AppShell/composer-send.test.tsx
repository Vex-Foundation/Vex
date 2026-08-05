import { fireEvent, screen, waitFor } from "@testing-library/react";
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
import { sessionKeys } from "../../../../lib/api/sessions.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  createShellRenderers,
  makeAgentRow,
  makeHealthReport,
  localIsoDaysAgo,
} from "./_appshell-render.js";

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
  XIcon: "XIcon",
  CoinsSwapIcon: "CoinsSwapIcon",
  BridgeIcon: "BridgeIcon",
  BubbleChatSparkIcon: "BubbleChatSparkIcon",
  BugIcon: "BugIcon",
  ChartCandlestickIcon: "ChartCandlestickIcon",
  CircleCheckBigIcon: "CircleCheckBigIcon",
  Clock03Icon: "Clock03Icon",
  DatabaseLightningIcon: "DatabaseLightningIcon",
  Trash2Icon: "Trash2Icon",
  FlameIcon: "FlameIcon",
  RocketIcon: "RocketIcon",
  FilterHorizontalIcon: "FilterHorizontalIcon",
  ChartLineData01Icon: "ChartLineData01Icon",
  BrainIcon: "BrainIcon",
  MapPinIcon: "MapPinIcon",
  PanelLeftCloseIcon: "PanelLeftCloseIcon",
  PanelLeftOpenIcon: "PanelLeftOpenIcon",
  PanelRightCloseIcon: "PanelRightCloseIcon",
  PanelRightOpenIcon: "PanelRightOpenIcon",
  SearchIcon: "SearchIcon",
  RadarIcon: "RadarIcon",
  Settings2Icon: "Settings2Icon",
  Shield02Icon: "Shield02Icon",
  SparklesIcon: "SparklesIcon",
  StarIcon: "StarIcon",
  CircleStopIcon: "CircleStopIcon",
  TargetIcon: "TargetIcon",
  PercentIcon: "PercentIcon",
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
const { renderShell } = createShellRenderers(AppShell);

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
    expect(
      await screen.findByRole("button", { name: /hunt trending memecoins/i }),
    ).not.toBeNull();
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
      expect(
        screen.queryByRole("button", { name: /hunt trending memecoins/i }),
      ).toBeNull(),
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
