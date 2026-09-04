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

// Phase 2b: the Settings ShellScreen hosts the wizard step forms, whose
// module graph (icons, RHF, brand marks) is far beyond this suite's
// partial mocks. The screen has its own suite; a stub keeps THIS suite's
// AppShell import light.
vi.mock("../../screens/SettingsScreen.js", () => ({
  SettingsScreen: () => null,
}));

vi.mock("../../lighterTrading/LighterTradingDialog.js", () => ({
  LighterTradingDialog: () => null,
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
  it("surfaces a timed-out turn after tool activity without offering a blind Retry", async () => {
    const row = makeAgentRow("Timed-out chat");
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [row] });
    sessionsGetMock.mockResolvedValue({ ok: true, data: row });
    useUiStore.setState({ activeSessionId: row.id });
    chatSubmitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: {
          text: null,
          toolCallsMade: 3,
          pendingApprovals: [],
          stopReason: "timeout",
          missionStatus: null,
          treatedAsInitialGoal: false,
        },
      }),
      cancel: vi.fn(),
    });

    renderShell();
    await screen.findByText("Timed-out chat");
    const draft = screen.getByLabelText("Session draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "bridge in one shot" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText(
      "Vex stopped before completing the task because this turn timed out. Review the transcript before trying again; earlier steps may have completed.",
    );
    expect(
      screen.queryByRole("button", { name: "Retry sending the message" }),
    ).toBeNull();
    expect(draft.value).toBe("");
    expect(chatSubmitMock).toHaveBeenCalledTimes(1);
  });

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

});
