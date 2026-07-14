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
  Fuel01Icon: "Fuel01Icon",
  FilterHorizontalIcon: "FilterHorizontalIcon",
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
  it("arms an inline Retry on a retryable provider error and re-sends the same message", async () => {
    const row = makeAgentRow("Retry chat");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });
    chatSubmitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "provider.unavailable",
          domain: "chat",
          message: "No inference provider is available.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: "c",
        },
      }),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("Retry chat");
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatSubmitMock).toHaveBeenCalledTimes(1));
    await screen.findByText("No inference provider is available.");
    const retry = await screen.findByRole("button", {
      name: "Retry sending the message",
    });
    // Retryable agent error → the message lives behind Retry; draft NOT restored.
    await waitFor(() => expect(draft.value).toBe(""));

    fireEvent.click(retry);
    await waitFor(() => expect(chatSubmitMock).toHaveBeenCalledTimes(2));
    expect(chatSubmitMock).toHaveBeenLastCalledWith({
      sessionId: row.id,
      message: "do the thing",
    });
  });

  it("does not double-submit when Retry is clicked twice before the first settles", async () => {
    const row = makeAgentRow("Retry guard");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });
    chatSubmitMock.mockReturnValueOnce({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "provider.unavailable",
          domain: "chat",
          message: "No inference provider is available.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: "c",
        },
      }),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("Retry guard");
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const retry = await screen.findByRole("button", {
      name: "Retry sending the message",
    });

    // The retry submit never settles → the in-flight ref (+ disabled button)
    // guarantee a second click cannot start a second submit.
    chatSubmitMock.mockReturnValue({
      promise: new Promise<never>(() => {}),
      cancel: vi.fn(),
    });
    chatSubmitMock.mockClear();
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(chatSubmitMock).toHaveBeenCalledTimes(1));
    expect(chatSubmitMock).toHaveBeenCalledTimes(1);
  });

  it("does not arm Retry for a non-retryable error and restores the draft", async () => {
    const row = makeAgentRow("No retry");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });
    chatSubmitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "chat",
          message: "Unable to process the message.",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: "c",
        },
      }),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("No retry");
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText("Unable to process the message.");
    // Non-retryable → no Retry button; the message is restored to the draft.
    expect(
      screen.queryByRole("button", { name: "Retry sending the message" }),
    ).toBeNull();
    await waitFor(() => expect(draft.value).toBe("keep me"));
  });

  it("does not arm Retry for a retryable error in a resolved MISSION session (mode gate fails closed)", async () => {
    const missionRow: SessionListItem = {
      id: "77777777-7777-4777-8777-777777777777",
      mode: "mission",
      permission: "restricted",
      title: "Mission no retry",
      initialGoal: null,
      startedAt: localIsoDaysAgo(0),
      endedAt: null,
      missionStatus: null,
      pinnedAt: null,
    };
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [missionRow] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: missionRow });
    useUiStore.setState({ activeSessionId: missionRow.id });
    chatSubmitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "provider.unavailable",
          domain: "chat",
          message: "No inference provider is available.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: "c",
        },
      }),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("Mission no retry");
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "mission goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText("No inference provider is available.");
    // Retryable but mission mode → the agent-mode gate fails closed: no Retry,
    // draft restored (mission error handling is owned by later phases).
    expect(
      screen.queryByRole("button", { name: "Retry sending the message" }),
    ).toBeNull();
    await waitFor(() => expect(draft.value).toBe("mission goal"));
  });

  it("clears the notice + Retry when the session is switched after a failure (no cross-session resend)", async () => {
    const a: SessionListItem = {
      ...makeAgentRow("Session A"),
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const b: SessionListItem = {
      ...makeAgentRow("Session B"),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    sessionsListMock.mockResolvedValue({ ok: true, data: [a, b] });
    sessionsGetMock.mockImplementation(async ({ id }) => ({
      ok: true,
      data: id === a.id ? a : b,
    }));
    useUiStore.setState({ activeSessionId: a.id });
    chatSubmitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "provider.unavailable",
          domain: "chat",
          message: "No inference provider is available.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: "c",
        },
      }),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("Session A");
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "msg for A" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Retry sending the message" });
    chatSubmitMock.mockClear();

    // Switch to session B via the sidebar → the notice + its Retry must clear,
    // and nothing may resend A's message into B.
    fireEvent.click(screen.getAllByText("Session B")[0]!);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry sending the message" }),
      ).toBeNull(),
    );
    expect(chatSubmitMock).not.toHaveBeenCalled();
  });

  it("swaps Send for a Stop button while a turn streams and cancels it (9-5b)", async () => {
    const row = makeAgentRow("Stoppable chat");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });

    const cancel = vi.fn();
    // Never settles → the mutation stays pending so the Stop control stays mounted.
    chatSubmitMock.mockReturnValue({
      promise: new Promise<Result<ChatSubmitResult>>(() => {}),
      cancel,
    });

    renderShell();
    await screen.findByText("Stoppable chat");

    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "Long-running research" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const stopBtn = await screen.findByRole("button", { name: "Stop generating" });
    // Pins the fix: a submit-typed Stop would re-run onSubmit (re-sending the
    // draft) instead of only cancelling the turn.
    expect(stopBtn.getAttribute("type")).toBe("button");
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

    fireEvent.click(stopBtn);
    expect(cancel).toHaveBeenCalledTimes(1);
    // type="button": clicking Stop must not fire a second submit.
    expect(chatSubmitMock).toHaveBeenCalledTimes(1);

    // Stop acknowledged → the key hard-cuts to a disabled Stopping circle
    // and the chrome-row hint carries the "Stopping…" label (no spinner).
    const stopping = await screen.findByRole("button", { name: "Stopping" });
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Stopping…")).toBeTruthy();
  });

  it("shows 'Stopped.' (not 'Message sent.') when a turn stops with no partial (9-5b)", async () => {
    const row = makeAgentRow("Stop early");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });

    chatSubmitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          text: null,
          toolCallsMade: 0,
          pendingApprovals: [],
          stopReason: "user_stopped",
          missionStatus: null,
          treatedAsInitialGoal: false,
        },
      }),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("Stop early");

    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "do something" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText("Stopped.");
    expect(screen.queryByText("Message sent.")).toBeNull();
  });

  it("enables + submits Send via activeSessionId even while the detail query is unresolved (bug A)", async () => {
    const row = makeAgentRow("Detail pending");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    // sessions.get never resolves → the detail object (activeSession) stays
    // null. Send must still work because it gates on activeSessionId.
    sessionsGetMock.mockReturnValue(new Promise<Result<SessionListItem | null>>(() => {}));
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    const draft = (await screen.findByLabelText("Session draft")) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "hello while loading" } });

    const send = screen.getByRole("button", { name: "Send message" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(chatSubmitMock).toHaveBeenCalledTimes(1));
    expect(chatSubmitMock).toHaveBeenCalledWith({
      sessionId: row.id,
      message: "hello while loading",
    });
    // activeSessionId is set but the detail (activeSession) is still unresolved
    // → quick-action chips stay hidden even though the transcript query
    // succeeded empty (gated on a resolved activeSession, no flicker).
    expect(screen.queryByRole("button", { name: /wallet balances/i })).toBeNull();
  });

  it("enables Send when the detail query errors (bug A)", async () => {
    const row = makeAgentRow("Detail error");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "sessions",
        message: "boom",
        retryable: true,
        userActionable: false,
        redacted: true,
        correlationId: "c",
      },
    });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    const draft = (await screen.findByLabelText("Session draft")) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "send despite error" } });
    const send = screen.getByRole("button", { name: "Send message" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(chatSubmitMock).toHaveBeenCalledWith({
        sessionId: row.id,
        message: "send despite error",
      }),
    );
    // Errored detail → activeSession null → chips hidden (no flicker).
    expect(screen.queryByRole("button", { name: /wallet balances/i })).toBeNull();
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
