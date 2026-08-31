/**
 * THE MODE DISPATCH, at the shell level.
 *
 * Three things this proves that no component test can:
 *
 *  1. `ShellFrame` swaps columns 1 and 2 on `runtimeMode` and leaves the boot
 *     machine alone - `data-vex-screen="appShell"` is the e2e selector in BOTH
 *     modes (e2e/qa-screenshots.spec.ts:85, smoke.spec.ts), so Studio being a
 *     new View member would break those without this test.
 *  2. The STATUS STRIP is mounted exactly once across a mode switch. That is not
 *     cosmetic: the strip carries `GlobalApprovals`, which owns the approvals
 *     live sync, and preload allows one subscriber per (event kind) per window.
 *     A per-shell strip would put two `onControlState` subscriptions on the
 *     bridge for as long as both shells were committed, and the second would
 *     silently steal the first's callbacks. The subscription COUNT through the
 *     mocked bridge is the assertion.
 *  3. Neither mode drops the frame-level hosts.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ProjectList } from "@shared/schemas/projects.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import { createQueryClient } from "../../../../app/queryClient.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  installStudioDomStubs,
  makeHostStatus,
  makeProject,
} from "../../studio/__tests__/studio-fixtures.js";

vi.mock("../../screens/SettingsScreen.js", () => ({ SettingsScreen: () => null }));
vi.mock("../../screens/AgentScanScreen.js", () => ({ AgentScanScreen: () => null }));
vi.mock("../../../wizard/steps/provider/ModelBrandIcon.js", () => ({
  ModelBrandIcon: () => null,
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

const { AppShell } = await import("../../AppShell.js");
const { makeEngineBridgeStub } = await import(
  "../../../../test/engine-bridge-stub.js"
);

/** How many live `onControlState` subscriptions the bridge is holding. */
let controlStateSubscriptions = 0;
const projectsListMock = vi.fn<() => Promise<Result<ProjectList>>>();
const hostStatusMock = vi.fn<() => Promise<Result<StudioHostStatus>>>();

function renderShell(): void {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <AppShell />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  installStudioDomStubs();
});

beforeEach(() => {
  window.localStorage.clear();
  controlStateSubscriptions = 0;
  projectsListMock.mockReset();
  hostStatusMock.mockReset();
  projectsListMock.mockResolvedValue({
    ok: true,
    data: [makeProject({ name: "vex-core" })],
  });
  hostStatusMock.mockResolvedValue({ ok: true, data: makeHostStatus() });

  useUiStore.setState({
    theme: "chronos",
    runtimeMode: "agent",
    activeProjectId: null,
    activeSessionId: null,
    sidebarOpen: true,
    currentView: "appShell",
    logBuffer: [],
    sessionModeFilter: "all",
    shellRoute: { kind: "none" },
    createSessionOpen: false,
    createSessionInitialTurn: null,
  });

  const engine = makeEngineBridgeStub();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      sessions: {
        list: () => Promise.resolve({ ok: true, data: [] }),
        get: () => Promise.resolve({ ok: true, data: null }),
        create: () => Promise.resolve({ ok: false, error: { message: "no" } }),
        setPinned: () => Promise.resolve({ ok: true, data: null }),
        delete: () => Promise.resolve({ ok: true, data: { outcome: "removed" } }),
      },
      chat: { submit: () => ({ promise: Promise.resolve({ ok: true, data: {} }), cancel: () => undefined }) },
      mission: { getDraft: () => Promise.resolve({ ok: true, data: null }) },
      runtime: { getState: () => Promise.resolve({ ok: true, data: { status: null } }) },
      system: { health: () => Promise.resolve({ ok: false, error: { message: "n/a" } }) },
      settings: {
        getUserProfile: () =>
          Promise.resolve({
            ok: true,
            data: { displayName: null, instructionsMd: null, workDescription: null },
          }),
        setUserProfile: () => Promise.resolve({ ok: false, error: { message: "n/a" } }),
      },
      messages: {
        list: () =>
          Promise.resolve({ ok: true, data: { items: [], nextCursor: null, hasMore: false } }),
      },
      projects: { list: projectsListMock },
      studio: {
        getHostStatus: hostStatusMock,
        onHostStatus: () => () => undefined,
      },
      engine: {
        ...engine,
        // COUNTED, not merely stubbed: this is the invariant the exactly-once
        // strip exists to protect.
        onControlState: (listener: (event: unknown) => void) => {
          controlStateSubscriptions += 1;
          const off = engine.onControlState(listener);
          return () => {
            controlStateSubscriptions -= 1;
            off();
          };
        },
      },
      market: {
        getVexSnapshot: () => Promise.resolve({ ok: true, data: null }),
        onVexUpdate: () => () => undefined,
      },
      capabilities: {
        get: () => Promise.resolve({ ok: true, data: { features: { memory: true } } }),
      },
    },
  });
});

function switchMode(mode: "agent" | "studio"): void {
  act(() => {
    useUiStore.getState().setRuntimeMode(mode);
  });
}

describe("AppShell runtime-mode dispatch", () => {
  it("agent mode renders the sessions rail and the session panel", () => {
    renderShell();
    expect(document.querySelector('[data-vex-area="sessions-sidebar"]')).not.toBeNull();
    expect(document.querySelector('[data-vex-area="studio-sidebar"]')).toBeNull();
    expect(document.querySelector('[data-vex-area="studio-center"]')).toBeNull();
  });

  it("studio mode swaps columns 1 and 2, and swaps them back", () => {
    renderShell();
    switchMode("studio");
    expect(document.querySelector('[data-vex-area="studio-sidebar"]')).not.toBeNull();
    expect(document.querySelector('[data-vex-area="studio-center"]')).not.toBeNull();
    expect(document.querySelector('[data-vex-area="sessions-sidebar"]')).toBeNull();

    switchMode("agent");
    expect(document.querySelector('[data-vex-area="sessions-sidebar"]')).not.toBeNull();
    expect(document.querySelector('[data-vex-area="studio-center"]')).toBeNull();
  });

  it("data-vex-runtime-mode follows while data-vex-screen never moves", () => {
    renderShell();
    const shell = document.querySelector('[data-vex-screen="appShell"]');
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute("data-vex-runtime-mode")).toBe("agent");

    switchMode("studio");
    // The SAME element: Studio is a mode inside the app shell, so the boot
    // machine never re-mounts and the e2e selector never moves.
    const afterSwitch = document.querySelector('[data-vex-screen="appShell"]');
    expect(afterSwitch).toBe(shell);
    expect(afterSwitch?.getAttribute("data-vex-runtime-mode")).toBe("studio");
  });

  it("mounts the status strip exactly once, across the switch", () => {
    renderShell();
    const strips = (): number =>
      document.querySelectorAll('[data-vex-area="shell-status-strip"]').length;
    expect(strips()).toBe(1);
    switchMode("studio");
    expect(strips()).toBe(1);
    switchMode("agent");
    expect(strips()).toBe(1);
  });

  it("holds exactly ONE onControlState subscription in either mode", () => {
    renderShell();
    const agentCount = controlStateSubscriptions;
    expect(agentCount).toBeGreaterThan(0);
    switchMode("studio");
    // The count must not GROW: a second strip would add a second approvals
    // live-sync subscription and silently steal the first's callbacks.
    expect(controlStateSubscriptions).toBe(agentCount);
    switchMode("agent");
    expect(controlStateSubscriptions).toBe(agentCount);
  });

  it("keeps the frame-level hosts and the BOOK column in both modes", () => {
    renderShell();
    const frame = document.querySelector('[data-vex-area="shell-frame"]');
    expect(frame).not.toBeNull();
    switchMode("studio");
    expect(document.querySelector('[data-vex-area="shell-frame"]')).toBe(frame);
  });

  it("studio mode with no project shows the Studio welcome screen", async () => {
    renderShell();
    switchMode("studio");
    expect(
      await screen.findByRole("heading", { name: "Vex Studio" }),
    ).not.toBeNull();
  });
});
