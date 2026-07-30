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
import type { ModelsListAvailableResult } from "@shared/schemas/models.js";
import type { ReasoningCapability } from "@shared/schemas/reasoning.js";
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
  Add01Icon: "Add01Icon",
  AnalyticsUpIcon: "AnalyticsUpIcon",
  Download01Icon: "Download01Icon",
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
  // Chronos screens redesign — ShellScreen (close) + TokenHistoryScreen
  // (entry-kind glyphs), both statically imported via AppShell → ShellScreens.
  ArrowDataTransferHorizontalIcon: "ArrowDataTransferHorizontalIcon",
  ArrowUpRight01Icon: "ArrowUpRight01Icon",
  Cancel01Icon: "Cancel01Icon",
  CoinsSwapIcon: "CoinsSwapIcon",
  BitcoinWalletIcon: "BitcoinWalletIcon",
  BridgeIcon: "BridgeIcon",
  BubbleChatSparkIcon: "BubbleChatSparkIcon",
  Bug02Icon: "Bug02Icon",
  ChartCandlestickIcon: "ChartCandlestickIcon",
  CheckmarkCircle02Icon: "CheckmarkCircle02Icon",
  Clock03Icon: "Clock03Icon",
  DatabaseLightningIcon: "DatabaseLightningIcon",
  Delete02Icon: "Delete02Icon",
  FireIcon: "FireIcon",
  ChartLineData01Icon: "ChartLineData01Icon",
  FilterHorizontalIcon: "FilterHorizontalIcon",
  Brain01Icon: "Brain01Icon",
  MapPinIcon: "MapPinIcon",
  PanelLeftCloseIcon: "PanelLeftCloseIcon",
  PanelLeftOpenIcon: "PanelLeftOpenIcon",
  PanelRightCloseIcon: "PanelRightCloseIcon",
  PanelRightOpenIcon: "PanelRightOpenIcon",
  Search01Icon: "Search01Icon",
  Radar01Icon: "Radar01Icon",
  Settings02Icon: "Settings02Icon",
  Shield02Icon: "Shield02Icon",
  SparklesIcon: "SparklesIcon",
  StarIcon: "StarIcon",
  StopCircleIcon: "StopCircleIcon",
  Target02Icon: "Target02Icon",
  PercentSquareIcon: "PercentSquareIcon",
  // Welcome Portfolio tab (BookPanel's welcome stage): handle + card icons.
  Wallet01Icon: "Wallet01Icon",
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
// E1/E2: the composer now sources reasoning capability from the GLOBAL
// models query on BOTH stages (welcome and in-session) instead of the
// per-session query — every test in this file that mounts the shell needs
// this stubbed. Defaults to "unconfigured" (resolved, no capability) so the
// existing welcome→create assertions below (no `reasoningEffort` key) keep
// holding without every test needing to know about capability.
const modelsListAvailableMock = vi.fn<
  () => Promise<Result<ModelsListAvailableResult>>
>();

function reasoningModelsResult(
  reasoning: ReasoningCapability | null,
): Result<ModelsListAvailableResult> {
  return {
    ok: true,
    data: {
      source: "global_default",
      fetchedAt: null,
      models: [
        {
          providerId: "openrouter",
          modelId: "anthropic/claude-sonnet-4",
          displayName: "anthropic/claude-sonnet-4",
          brand: "openrouter",
          contextLength: null,
          pricingInputPerMillion: null,
          pricingOutputPerMillion: null,
          reasoning,
        },
      ],
    },
  };
}

function fullEffortCapability(
  over: Partial<ReasoningCapability> = {},
): ReasoningCapability {
  return {
    supportedEfforts: ["high", "medium", "low", "none"],
    defaultEffort: null,
    defaultEnabled: null,
    mandatory: false,
    ...over,
  };
}

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
  modelsListAvailableMock.mockReset();
  // SessionComposer queries mission.getDraft + runtime.getState as soon as a
  // session is active (Send gate moved to activeSessionId). Benign defaults:
  // no draft, no run status (free text allowed).
  missionGetDraftMock.mockResolvedValue({ ok: true, data: null });
  runtimeGetStateMock.mockResolvedValue({ ok: true, data: { status: null } });
  // Default: resolved, no capability — keeps every EXISTING assertion below
  // (first hand-off submit carries no `reasoningEffort`) holding without
  // requiring every test to know about the models query. Tests that pin the
  // capability-driven behavior override this per-test.
  modelsListAvailableMock.mockResolvedValue({
    ok: true,
    data: { source: "unconfigured", models: [], fetchedAt: null },
  });
  useUiStore.setState({
    sidebarOpen: true,
    currentView: "appShell",
    wizardEntryMode: "setup",
    unlockReturnView: "appShell",
    logBuffer: [],
    sessionModeFilter: "all",
    activeSessionId: null,
    shellScreen: "none",
    shellScreenOrigin: null,
    createSessionOpen: false,
    createSessionInitialTurn: null,
    // `NEW_SESSION_ID` is a fixed constant every test's session-create mock
    // returns, so a value left here by an earlier test (e.g. a welcome
    // reasoning pick that rode into the store) would otherwise bleed into
    // the next test's assertions on this same key — mirrors the reset
    // `composer-reasoning-select.test.tsx` already does.
    reasoningEffortBySession: {},
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
      models: {
        listAvailable: modelsListAvailableMock,
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
  it("shows the PREVIEW build badge on the no-session welcome stage", async () => {
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [] });
    useUiStore.setState({ activeSessionId: null });
    renderShell();

    // The PREVIEW wordmark badge is the welcome sentinel now — the H1
    // display statement is deleted (owner decree 2026-07-21).
    await screen.findByText("PREVIEW · v0.0.0-test");
    expect(
      screen.queryByRole("heading", { name: /What should I execute/i }),
    ).toBeNull();
  });

  it("welcome composer Send opens the creator with the draft carried + name pre-filled (welcome→create)", async () => {
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [] });
    useUiStore.setState({ activeSessionId: null });
    renderShell();

    const draft = (await screen.findByLabelText("Session draft")) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "research TAO liquidity" } });
    const send = screen.getByRole("button", { name: "Send message" });
    // Enabled in welcome with a draft — it is the create entry point now.
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);

    await screen.findByRole("heading", { name: "New session" });
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("research TAO liquidity");
  });

  it("welcome→create hands the typed first message to the new session's composer", async () => {
    sessionsListMock.mockResolvedValueOnce({ ok: true, data: [] });
    useUiStore.setState({ activeSessionId: null });
    renderShell();

    const draft = (await screen.findByLabelText("Session draft")) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "research TAO liquidity" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("heading", { name: "New session" });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(chatSubmitMock).toHaveBeenCalledWith({
        sessionId: "a6bf4f85-e645-4df7-9bc5-70ec2eb0bd51",
        message: "research TAO liquidity",
      }),
    );
  });

});
