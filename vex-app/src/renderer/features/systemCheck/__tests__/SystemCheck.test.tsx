/**
 * Smoke tests for the System Check screen - wires the M2 hooks to UI.
 * Mocks the hooks directly (rather than IPC) so we don't depend on
 * jsdom's lack of `window.vex` and don't have to spin up a real
 * QueryClient per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, act, fireEvent } from "@testing-library/react";

const mockHooks = vi.hoisted(() => ({
  useSystemHealth: vi.fn(),
  useRuntimeInfo: vi.fn(),
  useLocalRuntimeCheck: vi.fn(),
  useRuntimeMigrationStatus: vi.fn(),
  useEnvState: vi.fn(),
}));

vi.mock("../../../lib/api/system.js", () => ({
  useSystemHealth: mockHooks.useSystemHealth,
  useRuntimeInfo: mockHooks.useRuntimeInfo,
  useLocalRuntimeCheck: mockHooks.useLocalRuntimeCheck,
  useRuntimeMigrationStatus: mockHooks.useRuntimeMigrationStatus,
}));
vi.mock("../../../lib/api/onboarding.js", () => ({
  useEnvState: mockHooks.useEnvState,
}));

import { SystemCheck } from "../SystemCheck.js";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  getStageVex,
  resetStageVex,
  stageVexEnd,
  stageVexView,
} from "../../../components/onboarding/stage-vex.js";

const openLogsFolder = vi.fn();

function happyHealth(translocated = false) {
  return {
    isPending: false,
    data: {
      ok: true,
      data: {
        os: {
          platform: "linux",
          arch: "x64",
          release: "6.6.0",
          distro: "Ubuntu 24.04",
          homedir: "/home/x",
          userDataDir: "/home/x/.config/vex/.electron-state",
          appVersion: "0.1.0-dev",
          electronVersion: "42.0.0",
          nodeVersion: "22.14.0",
        },
        network: { online: true, latencyMs: 24, probedAt: "2026-05-08T00:00:00Z" },
        translocated,
        setupComplete: false,
        overall: "degraded",
      },
    },
  };
}

function happyEnv() {
  return {
    isPending: false,
    data: {
      ok: true,
      data: {
        hasKeystorePassword: false,
        hasJupiterApiKey: false,
        embeddings: { configured: false, reachable: false, baseUrlRedacted: null },
        walletStatus: { evm: "missing" as const, solana: "missing" as const },
        setupCompleteFlag: false,
      },
    },
  };
}

const GiB = 1024 ** 3;
const MODEL_BYTES = 333_590_944;

function localCheck(
  overrides: {
    bundle?: unknown;
    disk?: Partial<{ freeBytes: number; totalBytes: number; modelVerified: boolean; modelBytesToWrite: number }>;
    memory?: Partial<{ totalBytes: number; freeBytes: number }>;
  } = {},
) {
  return {
    isPending: false,
    data: {
      ok: true,
      data: {
        bundle: overrides.bundle ?? { kind: "present", platform: "darwin", arch: "arm64" },
        disk: {
          kind: "measured",
          freeBytes: 120 * GiB,
          totalBytes: 500 * GiB,
          modelVerified: false,
          modelBytesToWrite: MODEL_BYTES,
          ...overrides.disk,
        },
        memory: { totalBytes: 16 * GiB, freeBytes: 3 * GiB, ...overrides.memory },
      },
    },
  };
}

/** A disk a first run cannot fit the model and the database on. */
const NO_SPACE = { disk: { freeBytes: 300_000_000, totalBytes: 64 * GiB } };

function rowByLabel(container: HTMLElement, label: string): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>("[data-step-status]")].find(
      (row) => row.querySelector(".vex-fr-probe__l")?.textContent === label,
    ) ?? null
  );
}

function clickContinue(getByRole: ReturnType<typeof render>["getByRole"]): void {
  act(() => {
    getByRole("button", { name: /continue/i }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SystemCheck", () => {
  beforeEach(() => {
    resetStageVex();
    // The launch is over: her face is the screen's, with no wake to wait for.
    stageVexEnd();
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarOpen: true,
      currentView: "systemCheck",
      logBuffer: [],
    });
    mockHooks.useSystemHealth.mockReturnValue(happyHealth());
    mockHooks.useRuntimeInfo.mockReturnValue({ isPending: false, data: { ok: true, data: { native: true } } });
    mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck());
    mockHooks.useRuntimeMigrationStatus.mockReturnValue({ isPending: false, data: { ok: true, data: { kind: "not_needed" } } });
    mockHooks.useEnvState.mockReturnValue(happyEnv());
    openLogsFolder.mockReset().mockResolvedValue({
      ok: true,
      data: { opened: true },
    });
    Object.defineProperty(window, "vex", {
      configurable: true,
      value: { support: { openLogsFolder } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    resetStageVex();
    mockHooks.useSystemHealth.mockReset();
    mockHooks.useRuntimeInfo.mockReset();
    mockHooks.useLocalRuntimeCheck.mockReset();
    mockHooks.useRuntimeMigrationStatus.mockReset();
    mockHooks.useEnvState.mockReset();
    Reflect.deleteProperty(window, "vex");
  });

  it("shows six rows: Local runtime, Disk space and Memory between network and configuration", () => {
    const { container, getByText, queryByText } = render(<SystemCheck />);
    const rows = [...container.querySelectorAll("[data-step-status]")];
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.querySelector(".vex-fr-probe__l")?.textContent)).toEqual([
      "Operating system",
      "Network connectivity",
      "Local runtime",
      "Disk space",
      "Memory",
      "Vex configuration",
    ]);
    expect(queryByText("Docker Engine")).toBeNull();
    expect(getByText("Six quick checks before setup begins.")).toBeDefined();
    expect(rowByLabel(container, "Local runtime")?.textContent).toContain("Database and embeddings server · macOS arm64");
    expect(rowByLabel(container, "Local runtime")?.textContent).toContain("Ready");
    expect(rowByLabel(container, "Disk space")?.getAttribute("data-step-status")).toBe("ok");
    expect(rowByLabel(container, "Disk space")?.textContent).toContain("129 GB free of 537 GB");
    expect(rowByLabel(container, "Memory")?.textContent).toContain("16 GB · 3.0 GB free");
  });

  it("Continue goes to the runtime screen, and the logs link opens the logs folder", () => {
    const { getByRole } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).toBeNull();
    clickContinue(getByRole);
    expect(useUiStore.getState().currentView).toBe("runtimeBootstrap");
    expect(mockHooks.useRuntimeMigrationStatus).toHaveBeenLastCalledWith(true);
    fireEvent.click(getByRole("button", { name: "Open logs folder" }));
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["pending", { ok: true, data: { kind: "pending", resumeStep: null, lastFailure: null } }],
    ["unreadable", { ok: true, data: { kind: "state_unreadable", message: "x" } }],
    ["an IPC failure", { ok: false, error: { code: "internal.unexpected", message: "x" } }],
  ])("Continue goes to the migration screen first when the move is %s", (_label, data) => {
    mockHooks.useRuntimeMigrationStatus.mockReturnValue({ isPending: false, data });
    const { getByRole } = render(<SystemCheck />);
    clickContinue(getByRole);
    expect(useUiStore.getState().currentView).toBe("runtimeMigration");
  });

  it("holds Continue until the migration status has answered", () => {
    mockHooks.useRuntimeMigrationStatus.mockReturnValue({ isPending: true, data: undefined });
    const { getByRole } = render(<SystemCheck />);
    expect(getByRole("button", { name: /continue/i }).hasAttribute("disabled")).toBe(true);
  });

  it("does not ask for the migration status, and holds Continue, while the runtime mode is unknown", () => {
    mockHooks.useRuntimeInfo.mockReturnValue({ isPending: true, data: undefined });
    const { container, getByRole } = render(<SystemCheck />);
    expect(mockHooks.useRuntimeMigrationStatus).toHaveBeenLastCalledWith(false);
    expect(container.querySelectorAll("[data-step-status]")).toHaveLength(6);
    expect(getByRole("button", { name: /continue/i }).hasAttribute("disabled")).toBe(true);
  });

  it("an unreadable runtime mode takes the native path", () => {
    mockHooks.useRuntimeInfo.mockReturnValue({
      isPending: false,
      data: { ok: false, error: { code: "internal.unexpected", message: "x" } },
    });
    const { getByRole } = render(<SystemCheck />);
    expect(mockHooks.useRuntimeMigrationStatus).toHaveBeenLastCalledWith(true);
    clickContinue(getByRole);
    expect(useUiStore.getState().currentView).toBe("runtimeBootstrap");
  });

  it("renders an adjacent translocation warning without adding a probe or blocking Continue", () => {
    mockHooks.useSystemHealth.mockReturnValue(happyHealth(true));
    const { container, getByRole, getByText } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(getByText(/Vex is running from a quarantined location \(App Translocation\)\./)).toBeDefined();
    expect(getByText(/Move Vex\.app to \/Applications in Finder and relaunch\./)).toBeDefined();
    // The ink callout is an alert, the one loud thing on the screen.
    expect(getByRole("alert").getAttribute("data-vex-callout")).toBe("error");
    expect(container.querySelectorAll("[data-step-status]")).toHaveLength(6);
    expect(getByRole("button", { name: /continue/i }).getAttribute("disabled"))
      .toBeNull();
  });

  it("disables Continue while any hook is pending", () => {
    mockHooks.useEnvState.mockReturnValue({ isPending: true, data: undefined });
    const { getByRole } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const button = getByRole("button", { name: /continue/i });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("blocks Continue when a first run cannot fit the embeddings model and the database", () => {
    mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck(NO_SPACE));
    const { container, getByRole } = render(<SystemCheck />);
    const disk = rowByLabel(container, "Disk space");
    expect(disk?.getAttribute("data-step-status")).toBe("fail");
    expect(disk?.textContent).toContain("No space");
    expect(disk?.textContent).toContain("300 MB free · setup needs 938 MB");
    expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).not.toBeNull();
  });

  it("only warns on the same low disk once the model is verified, and Continue stays enabled", () => {
    mockHooks.useLocalRuntimeCheck.mockReturnValue(
      localCheck({ disk: { freeBytes: 300_000_000, totalBytes: 64 * GiB, modelVerified: true, modelBytesToWrite: 0 } }),
    );
    const { container, getByRole } = render(<SystemCheck />);
    const disk = rowByLabel(container, "Disk space");
    expect(disk?.getAttribute("data-step-status")).toBe("warn");
    expect(disk?.textContent).toContain("300 MB free of 68.7 GB · running low");
    expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).toBeNull();
  });

  it("warns under 10% free while under 20 GiB", () => {
    mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck({ disk: { freeBytes: 16 * GiB, totalBytes: 228 * GiB } }));
    const { container } = render(<SystemCheck />);
    const disk = rowByLabel(container, "Disk space");
    expect(disk?.getAttribute("data-step-status")).toBe("warn");
    expect(disk?.textContent).toContain("17.2 GB free of 245 GB (7%) · running low");
  });

  it("warns under 4 GB of memory without blocking", () => {
    mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck({ memory: { totalBytes: 3 * GiB, freeBytes: 0.5 * GiB } }));
    const { container, getByRole } = render(<SystemCheck />);
    const memory = rowByLabel(container, "Memory");
    expect(memory?.getAttribute("data-step-status")).toBe("warn");
    expect(memory?.textContent).toContain("3.0 GB · under 4 GB · 0.5 GB free");
    expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).toBeNull();
  });

  it("a missing bundle fails its row with main's reason; the runtime screen takes it from there", () => {
    mockHooks.useLocalRuntimeCheck.mockReturnValue(
      localCheck({ bundle: { kind: "missing", detail: "The bundled Postgres is missing or not executable (postgres). Reinstall Vex." } }),
    );
    const { container, getByRole } = render(<SystemCheck />);
    const bundle = rowByLabel(container, "Local runtime");
    expect(bundle?.getAttribute("data-step-status")).toBe("fail");
    expect(bundle?.textContent).toContain("Reinstall Vex.");
    expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).toBeNull();
  });

  it("waits for the native facts before Continue enables", () => {
    mockHooks.useLocalRuntimeCheck.mockReturnValue({ isPending: true, data: undefined });
    const { container, getByRole } = render(<SystemCheck />);
    expect(rowByLabel(container, "Disk space")?.getAttribute("data-step-status")).toBe("loading");
    expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).not.toBeNull();
  });

  describe("in an e2e door run (main says native: false)", () => {
    beforeEach(() => {
      mockHooks.useRuntimeInfo.mockReturnValue({ isPending: false, data: { ok: true, data: { native: false } } });
      // What a disabled query returns: pending, never fetched.
      mockHooks.useRuntimeMigrationStatus.mockReturnValue({ isPending: true, data: undefined });
    });

    it("still shows the six rows, and Continue goes straight to migrations", () => {
      const { container, getByRole, queryByText } = render(<SystemCheck />);
      expect(container.querySelectorAll("[data-step-status]")).toHaveLength(6);
      expect(queryByText("Docker Engine")).toBeNull();
      expect(mockHooks.useRuntimeMigrationStatus).toHaveBeenLastCalledWith(false);
      expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).toBeNull();
      clickContinue(getByRole);
      expect(useUiStore.getState().currentView).toBe("migrations");
    });

    it("a disk too small for a first run does not hold Continue: nothing will be downloaded", () => {
      mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck(NO_SPACE));
      const { container, getByRole } = render(<SystemCheck />);
      expect(rowByLabel(container, "Disk space")?.getAttribute("data-step-status")).toBe("fail");
      expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).toBeNull();
    });

    it("an unreadable local runtime check fails its rows without hanging Continue", () => {
      mockHooks.useLocalRuntimeCheck.mockReturnValue({
        isPending: false,
        data: { ok: false, error: { code: "internal.unexpected", message: "x" } },
      });
      const { container, getByRole } = render(<SystemCheck />);
      expect(rowByLabel(container, "Local runtime")?.getAttribute("data-step-status")).toBe("fail");
      expect(getByRole("button", { name: /continue/i }).getAttribute("disabled")).toBeNull();
    });
  });

  it("stands at the right of the stage plate with its crumb and the version stamp", () => {
    const { container, getByRole } = render(<SystemCheck />);
    const root = container.querySelector('[data-vex-screen="systemCheck"]');
    expect(root?.querySelector(".vex-stage-side")).not.toBeNull();
    expect(root?.querySelector("[data-vex-version-stamp]")).not.toBeNull();
    const crumb = getByRole("navigation", { name: "First run" });
    const steps = Array.from(crumb.querySelectorAll("li")).map((li) => li.textContent);
    expect(steps).toEqual([
      "System check",
      "Local runtime",
      "Database",
      "Setup",
    ].map((label) => expect.stringContaining(label)));
    expect(crumb.querySelector('[aria-current="step"]')?.textContent).toContain("System check");
  });

  it.each([
    ["loading", "Working"],
    ["settled", "Ready"],
  ])("tells the plate what Vex shows while the probes are %s", (phase, word) => {
    if (phase === "loading") {
      mockHooks.useEnvState.mockReturnValue({ isPending: true, data: undefined });
    }
    render(<SystemCheck />);
    expect(stageVexView(getStageVex()).word).toBe(word);
  });

  it("is concerned when the machine runs low for the local runtime, and in error when a probe failed", () => {
    mockHooks.useLocalRuntimeCheck.mockReturnValue(
      localCheck({ disk: { freeBytes: 16 * GiB, totalBytes: 228 * GiB } }),
    );
    const first = render(<SystemCheck />);
    expect(stageVexView(getStageVex()).word).toBe("Concerned");
    first.unmount();
    mockHooks.useLocalRuntimeCheck.mockReturnValue({
      isPending: false,
      data: { ok: false, error: { code: "internal.unexpected", message: "x" } },
    });
    render(<SystemCheck />);
    expect(stageVexView(getStageVex()).word).toBe("Error");
  });

  it("does not let the local runtime's rows set the face on an e2e door run", () => {
    mockHooks.useRuntimeInfo.mockReturnValue({ isPending: false, data: { ok: true, data: { native: false } } });
    mockHooks.useLocalRuntimeCheck.mockReturnValue({
      isPending: false,
      data: { ok: false, error: { code: "internal.unexpected", message: "x" } },
    });
    render(<SystemCheck />);
    expect(stageVexView(getStageVex()).word).toBe("Ready");
  });
});
