/**
 * Branch matrix tests for BootstrapPanel — ensures each (engine present,
 * daemon running, platform) combination renders the correct branch
 * body (loading / A / B / C-desktop / C-linux / D) and that the
 * orchestrator wires the right footer CTA.
 *
 * Covers the post-redesign contract:
 *   - "Recheck" rename (previously "Retry detection")
 *   - data-wins-when-platform-irrelevant (A renders even if health is pending)
 *   - loading branch when status missing OR engine missing + platform pending
 *   - D when result.ok === false (not just endpoint rejected)
 *   - C-linux auto-fetch success path (instructions visible)
 *   - C-linux auto-fetch error path (retry instructions fetch visible)
 *   - B Linux copy: prominent `sudo systemctl` command + subordinate
 *     "Try Start Docker Desktop" ghost button
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const mockHooks = vi.hoisted(() => ({
  useDockerStatus: vi.fn(),
  useDockerInstall: vi.fn(),
  useDockerStart: vi.fn(),
  useSystemHealth: vi.fn(),
}));

vi.mock("../../../lib/api/docker.js", () => ({
  useDockerStatus: mockHooks.useDockerStatus,
  useDockerInstall: mockHooks.useDockerInstall,
  useDockerStart: mockHooks.useDockerStart,
}));
vi.mock("../../../lib/api/system.js", () => ({
  useSystemHealth: mockHooks.useSystemHealth,
}));

import {
  deriveDockerStatusFlags,
  type DockerEngineState,
} from "@shared/schemas/docker.js";

import { BootstrapPanel } from "../BootstrapPanel.js";

function statusResult(opts: {
  enginePresent: boolean;
  daemonRunning: boolean;
  state?: DockerEngineState;
}) {
  const state: DockerEngineState =
    opts.state ??
    (opts.daemonRunning
      ? { kind: "ready" }
      : opts.enginePresent
        ? { kind: "engine_stopped" }
        : { kind: "not_installed" });
  const flags = deriveDockerStatusFlags(state);
  return {
    isPending: false,
    isFetching: false,
    data: {
      ok: true as const,
      data: {
        endpoint: {
          accepted: true,
          currentContext: "default",
          dockerHostSet: false,
          reason: null,
          message: null,
        },
        engine: {
          state,
          version: opts.enginePresent ? "27.5.1" : null,
          cliSource: opts.enginePresent ? ("install_dir" as const) : null,
          present: flags.present,
          runtimeOK: flags.runtimeOK,
        },
        compose: {
          present: opts.enginePresent,
          version: opts.enginePresent ? "v2.32.4" : null,
        },
        modelRunner: {
          present: opts.enginePresent,
          status: "active" as const,
          tcpReachable: true,
        },
        daemon: {
          running: flags.daemonRunning,
          startable: flags.daemonStartable,
        },
        ports: { vexPgFree: true },
        disk: { availableGB: 50 },
      },
    },
    refetch: vi.fn(),
  };
}

function failureStatusResult() {
  return {
    isPending: false,
    isFetching: false,
    data: {
      ok: false as const,
      error: {
        code: "DOCKER_PROBE_FAILED",
        message: "Docker IPC probe rejected",
      },
    },
    refetch: vi.fn(),
  };
}

function pendingStatusResult() {
  return {
    isPending: true,
    isFetching: true,
    data: undefined,
    refetch: vi.fn(),
  };
}

function healthResult(platform: "linux" | "darwin" | "win32") {
  return {
    isPending: false,
    data: {
      ok: true as const,
      data: {
        os: {
          platform,
          arch: "x64" as const,
          release: "1",
          distro: null,
          homedir: "/h",
          userDataDir: "/u",
          appVersion: "0.1.0-dev",
          electronVersion: "42.0.0",
          nodeVersion: "22.0.0",
        },
        network: {
          online: true,
          latencyMs: 1,
          probedAt: "2026-05-08T00:00:00Z",
        },
        translocated: false,
        setupComplete: false,
        overall: "degraded" as const,
      },
    },
  };
}

function pendingHealthResult() {
  return { isPending: true, data: undefined };
}

const noopMutation = {
  mutate: vi.fn(),
  isPending: false,
  data: undefined,
};
const openLogsFolder = vi.fn();

function clickLogs(getByRole: ReturnType<typeof render>["getByRole"]): void {
  fireEvent.click(getByRole("button", { name: "Open logs folder" }));
  expect(openLogsFolder).toHaveBeenCalledTimes(1);
}

describe("BootstrapPanel branch matrix", () => {
  beforeEach(() => {
    mockHooks.useDockerInstall.mockReturnValue(noopMutation);
    mockHooks.useDockerStart.mockReturnValue(noopMutation);
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
    cleanup();
    mockHooks.useDockerStatus.mockReset();
    mockHooks.useDockerInstall.mockReset();
    mockHooks.useDockerStart.mockReset();
    mockHooks.useSystemHealth.mockReset();
    noopMutation.mutate.mockReset();
    Reflect.deleteProperty(window, "vex");
  });

  it.each<["linux" | "darwin" | "win32"]>([
    ["darwin"],
    ["win32"],
    ["linux"],
  ])(
    "branch A: ready when engine present + daemon running (%s)",
    (platform) => {
      mockHooks.useDockerStatus.mockReturnValue(
        statusResult({ enginePresent: true, daemonRunning: true }),
      );
      mockHooks.useSystemHealth.mockReturnValue(healthResult(platform));
      const { getByText, getByRole } = render(<BootstrapPanel />);
      expect(getByText(/Docker is ready/i)).toBeDefined();
      expect(getByRole("button", { name: /continue/i })).toBeDefined();
    },
  );

  it("branch A: data wins when health probe is still pending", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: true, daemonRunning: true }),
    );
    mockHooks.useSystemHealth.mockReturnValue(pendingHealthResult());
    const { getByText, getByRole } = render(<BootstrapPanel />);
    expect(getByText(/Docker is ready/i)).toBeDefined();
    expect(getByRole("button", { name: /continue/i })).toBeDefined();
  });

  it.each<["darwin" | "win32"]>([["darwin"], ["win32"]])(
    "branch B (mac/win): daemon stopped offers Start Docker (%s)",
    (platform) => {
      mockHooks.useDockerStatus.mockReturnValue(
        statusResult({ enginePresent: true, daemonRunning: false }),
      );
      mockHooks.useSystemHealth.mockReturnValue(healthResult(platform));
      const { getByRole } = render(<BootstrapPanel />);
      expect(getByRole("button", { name: /Start Docker/i })).toBeDefined();
      clickLogs(getByRole);
    },
  );

  it("branch B (linux): shows sudo systemctl command + subordinate Try Start Docker Desktop", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: true, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("linux"));
    const { getByText, getByRole } = render(<BootstrapPanel />);
    expect(getByText(/sudo systemctl start docker/)).toBeDefined();
    expect(
      getByRole("button", { name: /Try Start Docker Desktop/i }),
    ).toBeDefined();
    clickLogs(getByRole);
  });

  it("branch B + health pending: loading view (platform-conditional copy needs platform)", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: true, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(pendingHealthResult());
    const { getByText, queryByRole } = render(<BootstrapPanel />);
    expect(getByText(/Detecting Docker/i)).toBeDefined();
    expect(queryByRole("button", { name: /Start Docker/i })).toBeNull();
  });

  it.each<["darwin" | "win32"]>([["darwin"], ["win32"]])(
    "branch C-desktop: missing engine on mac/win offers Download installer (%s)",
    (platform) => {
      mockHooks.useDockerStatus.mockReturnValue(
        statusResult({ enginePresent: false, daemonRunning: false }),
      );
      mockHooks.useSystemHealth.mockReturnValue(healthResult(platform));
      const { getByRole, getByText } = render(<BootstrapPanel />);
      expect(
        getByRole("button", { name: /Download installer/i }),
      ).toBeDefined();
      expect(getByText(/Docker CLI not found/i)).toBeDefined();
      expect(getByText(/CLI symlinks.*Settings.*Advanced/i)).toBeDefined();
      clickLogs(getByRole);
    },
  );

  it("branch D: version probe errors do not route to the install branch", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({
        enginePresent: false,
        daemonRunning: false,
        state: {
          kind: "error",
          reason: "probe_error",
          message:
            "The Docker CLI was found but did not report a usable version.",
        },
      }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("darwin"));

    const { getByText, getByRole, queryByRole } = render(<BootstrapPanel />);

    expect(getByText(/^Docker probe failed$/i)).toBeDefined();
    expect(getByText(/open the logs folder for details/i)).toBeDefined();
    expect(queryByRole("button", { name: /Download installer/i })).toBeNull();
    clickLogs(getByRole);
  });

  it("branch C-no-engine + health pending: loading view (don't transiently show C)", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: false, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(pendingHealthResult());
    const { getByText, queryByRole } = render(<BootstrapPanel />);
    expect(getByText(/Detecting Docker/i)).toBeDefined();
    expect(
      queryByRole("button", { name: /Download installer/i }),
    ).toBeNull();
  });

  it("branch C-linux: auto-fetches manual instructions on mount", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: false, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("linux"));
    const installCapture = {
      ...noopMutation,
      mutate: vi.fn((args, options) => {
        options?.onSuccess?.({
          ok: true,
          data: {
            kind: "guided",
            message: "",
            artifactPath: null,
            fallbackInstructions: "sudo apt-get install docker",
          },
        });
        options?.onSettled?.();
      }),
    };
    mockHooks.useDockerInstall.mockReturnValue(installCapture);
    const { getByText, getByRole } = render(<BootstrapPanel />);
    expect(installCapture.mutate).toHaveBeenCalledWith(
      { method: "linux_manual_instructions" },
      expect.anything(),
    );
    expect(getByText(/sudo apt-get install docker/)).toBeDefined();
    clickLogs(getByRole);
  });

  it("branch C-linux: fetch error surfaces Retry instructions fetch button", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: false, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("linux"));
    const installCapture = {
      ...noopMutation,
      mutate: vi.fn((_args, options) => {
        options?.onError?.(new Error("IPC timeout"));
        options?.onSettled?.();
      }),
    };
    mockHooks.useDockerInstall.mockReturnValue(installCapture);
    const { getByRole } = render(<BootstrapPanel />);
    expect(
      getByRole("button", { name: /Retry instructions fetch/i }),
    ).toBeDefined();
    clickLogs(getByRole);
  });

  it("branch C-linux: clicking 'Retry instructions fetch' invokes the mutation again", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: false, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("linux"));
    let mutateCount = 0;
    const installCapture = {
      ...noopMutation,
      mutate: vi.fn((_args, options) => {
        mutateCount += 1;
        // First call → error so the retry button appears; second
        // call → success so the captured count flips past 1.
        if (mutateCount === 1) {
          options?.onError?.(new Error("IPC timeout"));
        } else {
          options?.onSuccess?.({
            ok: true,
            data: {
              kind: "guided",
              message: "",
              artifactPath: null,
              fallbackInstructions: "sudo apt-get install docker",
            },
          });
        }
        options?.onSettled?.();
      }),
    };
    mockHooks.useDockerInstall.mockReturnValue(installCapture);
    const { getByRole } = render(<BootstrapPanel />);
    const retryButton = getByRole("button", {
      name: /Retry instructions fetch/i,
    });
    retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(installCapture.mutate).toHaveBeenCalledTimes(2);
  });

  it("branch D: when result.ok === false, renders failure body (not blank screen)", () => {
    mockHooks.useDockerStatus.mockReturnValue(failureStatusResult());
    mockHooks.useSystemHealth.mockReturnValue(healthResult("linux"));
    const { getByText, getByRole } = render(<BootstrapPanel />);
    expect(getByText(/Docker check did not complete/i)).toBeDefined();
    expect(getByText(/Docker IPC probe rejected/)).toBeDefined();
    clickLogs(getByRole);
    expect(getByRole("button", { name: /Recheck/i })).toBeDefined();
  });

  it("branch D: engine socket permission denial names its real cause", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({
        enginePresent: true,
        daemonRunning: false,
        state: {
          kind: "permission_denied",
          message:
            "The Docker engine socket refused this process. Add your user to the Docker group (or grant socket access) and retry.",
        },
      }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("linux"));
    const { getByText, queryByRole } = render(<BootstrapPanel />);
    expect(getByText(/^Docker denied access$/i)).toBeDefined();
    expect(getByText(/refused this process/i)).toBeDefined();
    // A denial is not an install prompt and not a "start Docker" prompt.
    expect(queryByRole("button", { name: /Download installer/i })).toBeNull();
    expect(queryByRole("button", { name: /^Start Docker$/i })).toBeNull();
  });

  it("branch B: engine_starting renders the daemon branch in its starting state", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({
        enginePresent: true,
        daemonRunning: false,
        state: { kind: "engine_starting" },
      }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("win32"));
    const { getByRole } = render(<BootstrapPanel />);
    const startButton = getByRole("button", { name: /Starting/i });
    expect(startButton).toBeDefined();
    expect(startButton.hasAttribute("disabled")).toBe(true);
  });

  it("branch C-desktop: a Windows install that PATH cannot see is NOT reported as missing", () => {
    // Regression guard for the reported bug at the branch level: once the
    // locator finds Docker on disk the state is engine_stopped, so the user
    // gets "start Docker", never "install Docker" again.
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: true, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("win32"));
    const { getByRole, queryByRole } = render(<BootstrapPanel />);
    expect(getByRole("button", { name: /^Start Docker$/i })).toBeDefined();
    expect(queryByRole("button", { name: /Download installer/i })).toBeNull();
  });

  it("branch loading: when dockerStatus has no data yet", () => {
    mockHooks.useDockerStatus.mockReturnValue(pendingStatusResult());
    mockHooks.useSystemHealth.mockReturnValue(healthResult("linux"));
    const { getByText } = render(<BootstrapPanel />);
    expect(getByText(/Detecting Docker/i)).toBeDefined();
  });

  it("footer: Recheck button renamed from 'Retry detection' on non-A branches", () => {
    mockHooks.useDockerStatus.mockReturnValue(
      statusResult({ enginePresent: true, daemonRunning: false }),
    );
    mockHooks.useSystemHealth.mockReturnValue(healthResult("darwin"));
    const { getByRole, queryByRole } = render(<BootstrapPanel />);
    expect(getByRole("button", { name: /^Recheck$/i })).toBeDefined();
    expect(
      queryByRole("button", { name: /Retry detection/i }),
    ).toBeNull();
  });
});
