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
  useDockerStatus: vi.fn(),
  useEnvState: vi.fn(),
}));

vi.mock("../../../lib/api/system.js", () => ({
  useSystemHealth: mockHooks.useSystemHealth,
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

describe("SystemCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarOpen: true,
      currentView: "systemCheck",
      logBuffer: [],
    });
    mockHooks.useSystemHealth.mockReturnValue(happyHealth());
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
});
