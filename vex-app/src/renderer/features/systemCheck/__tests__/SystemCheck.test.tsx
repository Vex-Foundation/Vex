/**
 * Smoke tests for the System Check screen — wires the M2 hooks to UI.
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
  useDockerStatus: vi.fn(),
  useEnvState: vi.fn(),
}));

vi.mock("../../../lib/api/system.js", () => ({
  useSystemHealth: mockHooks.useSystemHealth,
  useRuntimeInfo: mockHooks.useRuntimeInfo,
  useLocalRuntimeCheck: mockHooks.useLocalRuntimeCheck,
}));
vi.mock("../../../lib/api/docker.js", () => ({
  useDockerStatus: mockHooks.useDockerStatus,
}));
vi.mock("../../../lib/api/onboarding.js", () => ({
  useEnvState: mockHooks.useEnvState,
}));

import { SystemCheck } from "../SystemCheck.js";
import { useUiStore } from "../../../stores/uiStore.js";

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

function happyDocker(modelStatus: "active" | "inactive" = "active") {
  return {
    isPending: false,
    data: {
      ok: true,
      data: {
        endpoint: {
          accepted: true,
          currentContext: "default",
          dockerHostSet: false,
          reason: null,
          message: null,
        },
        engine: {
          present: true,
          version: "27.5.1",
          runtimeOK: true,
          failure: null,
        },
        compose: { present: true, version: "v2.32.4" },
        modelRunner: { present: true, status: modelStatus, tcpReachable: modelStatus === "active" },
        daemon: { running: true, startable: true },
        ports: { vexPgFree: true },
        disk: { availableGB: 42 },
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

function rowByLabel(container: HTMLElement, label: string): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>("[data-step-status]")].find(
      (row) => row.querySelector("span.text-sm")?.textContent === label,
    ) ?? null
  );
}

describe("SystemCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarOpen: true,
      currentView: "systemCheck",
      logBuffer: [],
    });
    mockHooks.useSystemHealth.mockReturnValue(happyHealth());
    mockHooks.useRuntimeInfo.mockReturnValue({ isPending: false, data: { ok: true, data: { native: false } } });
    // A disabled query: pending, never fetched (what TanStack returns).
    mockHooks.useLocalRuntimeCheck.mockReturnValue({ isPending: true, data: undefined });
    mockHooks.useDockerStatus.mockReturnValue(happyDocker("active"));
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
    mockHooks.useSystemHealth.mockReset();
    mockHooks.useRuntimeInfo.mockReset();
    mockHooks.useLocalRuntimeCheck.mockReset();
    mockHooks.useDockerStatus.mockReset();
    mockHooks.useEnvState.mockReset();
    Reflect.deleteProperty(window, "vex");
  });

  it("renders four step rows after the cascade timer expires", () => {
    const { container } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const rows = container.querySelectorAll('[data-step-status]');
    expect(rows.length).toBe(4);
  });

  it("Continue button advances the state machine to dockerBootstrap", () => {
    const { getByRole } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const button = getByRole("button", { name: /continue/i });
    expect(button.getAttribute("disabled")).toBeNull();
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useUiStore.getState().currentView).toBe("dockerBootstrap");
    fireEvent.click(getByRole("button", { name: "Open logs folder" }));
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
  });

  it("on the container runtime, only the container probe runs", () => {
    render(<SystemCheck />);
    expect(mockHooks.useDockerStatus).toHaveBeenLastCalledWith({ enabled: true });
    expect(mockHooks.useLocalRuntimeCheck).toHaveBeenLastCalledWith(false);
  });

  it("Continue goes to the runtime screen when main runs the native runtime", () => {
    mockHooks.useRuntimeInfo.mockReturnValue({ isPending: false, data: { ok: true, data: { native: true } } });
    mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck());
    const { getByRole } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => {
      getByRole("button", { name: /continue/i }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useUiStore.getState().currentView).toBe("runtimeBootstrap");
  });

  it("renders an adjacent translocation warning without adding a probe or blocking Continue", () => {
    mockHooks.useSystemHealth.mockReturnValue(happyHealth(true));
    const { container, getByRole, getByText } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(
      getByText(
        /Vex is running from a quarantined location \(App Translocation\).*Move Vex\.app to \/Applications in Finder and relaunch\./,
      ),
    ).toBeDefined();
    expect(container.querySelectorAll("[data-step-status]")).toHaveLength(4);
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

  it("does NOT surface the legacy DMR advisory (M11.5.4 - bundled runtime)", () => {
    mockHooks.useDockerStatus.mockReturnValue(happyDocker("inactive"));
    const { queryByText } = render(<SystemCheck />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(
      queryByText(/Docker Model Runner is not active on this Linux host/)
    ).toBeNull();
  });

  describe("on the native runtime", () => {
    beforeEach(() => {
      mockHooks.useRuntimeInfo.mockReturnValue({ isPending: false, data: { ok: true, data: { native: true } } });
      mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck());
      // What a disabled query returns: pending, never fetched.
      mockHooks.useDockerStatus.mockReturnValue({ isPending: true, data: undefined });
    });

    it("shows six rows: Local runtime, Disk space and Memory replace the container row", () => {
      const { container, getByText, queryByText } = render(<SystemCheck />);
      const rows = [...container.querySelectorAll("[data-step-status]")];
      expect(rows).toHaveLength(6);
      expect(rows.map((row) => row.querySelector("span.text-sm")?.textContent)).toEqual([
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
      expect(rowByLabel(container, "Local runtime")?.textContent).toContain("READY");
      expect(rowByLabel(container, "Disk space")?.getAttribute("data-step-status")).toBe("ok");
      expect(rowByLabel(container, "Disk space")?.textContent).toContain("129 GB free of 537 GB");
      expect(rowByLabel(container, "Memory")?.textContent).toContain("16 GB · 3.0 GB free");
    });

    it("never runs the container probe, and asks main for the native facts", () => {
      render(<SystemCheck />);
      expect(mockHooks.useDockerStatus).toHaveBeenLastCalledWith({ enabled: false });
      expect(mockHooks.useLocalRuntimeCheck).toHaveBeenLastCalledWith(true);
    });

    it("does not run the container probe while the runtime mode is still unknown", () => {
      mockHooks.useRuntimeInfo.mockReturnValue({ isPending: true, data: undefined });
      render(<SystemCheck />);
      expect(mockHooks.useDockerStatus).toHaveBeenLastCalledWith({ enabled: false });
      expect(mockHooks.useLocalRuntimeCheck).toHaveBeenLastCalledWith(false);
    });

    it("blocks Continue when a first run cannot fit the embeddings model and the database", () => {
      mockHooks.useLocalRuntimeCheck.mockReturnValue(localCheck({ disk: { freeBytes: 300_000_000, totalBytes: 64 * GiB } }));
      const { container, getByRole } = render(<SystemCheck />);
      const disk = rowByLabel(container, "Disk space");
      expect(disk?.getAttribute("data-step-status")).toBe("fail");
      expect(disk?.textContent).toContain("NO SPACE");
      expect(disk?.textContent).toContain("Needs 938 MB free for the embeddings model and the database · 300 MB free");
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
      expect(memory?.textContent).toContain("3.0 GB · under 4 GB, Vex may run slowly · 0.5 GB free");
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
  });
});
