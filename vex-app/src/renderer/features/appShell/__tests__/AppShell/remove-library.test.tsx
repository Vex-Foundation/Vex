import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  makeSessionRows,
  localIsoDaysAgo,
} from "./_appshell-render.js";

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
  it("opens a session from the Sessions screen: row click closes the screen and selects it", async () => {
    sessionsListMock.mockResolvedValue({
      ok: true,
      data: makeSessionRows(),
    });

    renderShell();
    await screen.findAllByText("Arbitrum LP Rebalance");
    // The menu-click open path is pinned in shell-sidebar.test.tsx; here the
    // store drives the screen so the row-select contract stays isolated.
    useUiStore.getState().setShellRoute({ kind: "sessions", origin: null });

    const overlay = await screen.findByRole("dialog", { name: "Sessions" });
    const libraryRows = await within(overlay).findAllByText(
      "Arbitrum LP Rebalance",
    );
    // Climb to the enclosing <button> — fireEvent.click on the inner text
    // triggers React's synthetic system regardless of the target tag.
    fireEvent.click(libraryRows[0]!);
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
    expect(useUiStore.getState().activeSessionId).toBe(
      "fb7bf453-df76-43e9-b756-02c3b717f242",
    );
  });

  it("opens the remove dialog when the trash button is clicked", async () => {
    sessionsListMock.mockResolvedValueOnce({
      ok: true,
      data: [makeAgentRow("Remove me")],
    });
    renderShell();
    const trashButtons = await screen.findAllByRole("button", { name: "Remove session" });
    fireEvent.click(trashButtons[0]!);
    expect(await screen.findByRole("dialog", { name: /Remove session\?/i })).not.toBeNull();
    expect(screen.getByText(/Remove "Remove me"/)).not.toBeNull();
  });

  it("confirms removal, calls IPC, clears active session, and closes the dialog", async () => {
    const row = makeAgentRow("Goodbye");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    const trashButtons = await screen.findAllByRole("button", { name: "Remove session" });
    fireEvent.click(trashButtons[0]!);
    const confirmBtn = await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(sessionsDeleteMock).toHaveBeenCalledTimes(1));
    expect(sessionsDeleteMock).toHaveBeenCalledWith({ id: row.id });
    await waitFor(() => expect(useUiStore.getState().activeSessionId).toBeNull());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Remove session\?/i })).toBeNull(),
    );
  });

  it("keeps the dialog open and surfaces blocked-active copy when main refuses removal", async () => {
    const row = makeAgentRow("Mission alive");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsDeleteMock.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "blocked_active_mission" },
    });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove session" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(sessionsDeleteMock).toHaveBeenCalledTimes(1));
    await screen.findByText(/this mission is still active/i);
    expect(useUiStore.getState().activeSessionId).toBe(row.id);
  });

  it("surfaces blocked-pending copy without mutating cache", async () => {
    const row = makeAgentRow("Awaiting your nod");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsDeleteMock.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "blocked_pending_approval" },
    });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove session" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await screen.findByText(/pending approval/i);
    expect(useUiStore.getState().activeSessionId).toBe(row.id);
  });

  it("surfaces state_changed copy without mutating cache and lets the user retry", async () => {
    const row = makeAgentRow("Race-loser");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsDeleteMock.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "state_changed" },
    });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove session" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await screen.findByText(/state changed/i);
    expect(useUiStore.getState().activeSessionId).toBe(row.id);
  });

  it("clears active session + closes dialog when outcome is already_removed", async () => {
    const row = makeAgentRow("Stale list");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsDeleteMock.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "already_removed" },
    });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove session" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(useUiStore.getState().activeSessionId).toBeNull());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Remove session\?/i })).toBeNull(),
    );
  });

  it("clears active session when outcome is not_found", async () => {
    const row = makeAgentRow("Ghost row");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsDeleteMock.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "not_found" },
    });
    useUiStore.setState({ activeSessionId: row.id });

    renderShell();
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove session" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(useUiStore.getState().activeSessionId).toBeNull());
  });

  it("Sessions screen removes through the same dialog + IPC path", async () => {
    const row = makeAgentRow("Library-resident");
    sessionsListMock.mockResolvedValue({ ok: true, data: [row] });

    renderShell();
    useUiStore.getState().setShellRoute({ kind: "sessions", origin: null });

    // With the Sessions screen open, both the sidebar and the library render
    // the same row → two trash buttons total. Click the library one (last).
    const trashButtons = await screen.findAllByRole("button", { name: "Remove session" });
    expect(trashButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(trashButtons[trashButtons.length - 1]!);

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(sessionsDeleteMock).toHaveBeenCalledWith({ id: row.id }));
  });

  it("Cancel button closes the dialog without calling IPC", async () => {
    const row = makeAgentRow("Cancel me");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });

    renderShell();
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove session" }))[0]!);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);

    expect(sessionsDeleteMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Remove session\?/i })).toBeNull(),
    );
  });
});
