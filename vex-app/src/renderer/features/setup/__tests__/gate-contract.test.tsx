/**
 * Boot-gate contract characterization (reduced-motion path, deterministic
 * in jsdom). Pins the SetupGate/ChronosGate <-> useSetupOrchestrator <->
 * uiStore handoff that the Chronos Gate rebuild must preserve:
 *   - the gate overlays while `setupGateActive` and runs the pipeline once;
 *   - a first-run probe result flips `currentView` to systemCheck BENEATH
 *     the plate, then the gate dismisses itself (`setupGateActive` false);
 *   - a returning-user locked-vault pipeline lands on unlock via
 *     `openUnlock` (currentView "unlock" + unlockReturnView preserved).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

beforeEach(() => {
  // Force reduced motion: the animated curtain is visual-only; the contract
  // path (handoff -> view flip -> dismiss) must hold without animations.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const { ChronosGate } = await import("../ChronosGate.js");
const { useUiStore } = await import("../../../stores/uiStore.js");

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

const HEALTH = {
  os: {
    platform: "linux",
    arch: "x64",
    electronVersion: "42.0.0",
    appVersion: "0.0.0-test",
    distro: null,
  },
  network: { online: true, latencyMs: 12, probedAt: new Date(0).toISOString() },
  translocated: false,
  setupComplete: true,
  overall: "ok",
};

const DOCKER_READY = {
  endpoint: { accepted: true, blockReason: null },
  engine: { present: true, version: "27.0.0", runtimeOK: true, failure: null },
  compose: { present: true, version: "2.29.0" },
  modelRunner: { present: false, status: "absent", tcpReachable: false },
  daemon: { running: true, startable: true },
  ports: { vexPgFree: true },
  disk: { availableGB: 100 },
};

const COMPOSE_RUNNING = {
  kind: "running",
  composeOutPath: "/tmp/compose.yml",
  installId: "install-1",
  message: "up",
  previousInstallHoldingPorts: false,
};

function stubVex(overrides: {
  readonly setupCompleteFlag: boolean;
  readonly vaultConfigured?: boolean;
  readonly unlocked?: boolean;
}): void {
  const env = {
    setupCompleteFlag: overrides.setupCompleteFlag,
    embeddingDefaultsSeeded: true,
  };
  const wizardState = {
    completed: true,
    currentStepId: null,
    completedSteps: [
      "keystore",
      "wallets",
      "apiKeys",
      "embedding",
      "agentCore",
      "provider",
      "review",
    ],
  };
  vi.stubGlobal("vex", {
    system: { health: vi.fn().mockResolvedValue(ok(HEALTH)) },
    docker: {
      detect: vi.fn().mockResolvedValue(ok(DOCKER_READY)),
      composeUpAbortable: vi.fn(() => ({
        promise: Promise.resolve(ok(COMPOSE_RUNNING)),
        abort: vi.fn(),
      })),
    },
    onboarding: {
      getEnvState: vi.fn().mockResolvedValue(ok(env)),
      getWizardState: vi.fn().mockResolvedValue(ok(wizardState)),
    },
    database: {
      onProgress: vi.fn(() => vi.fn()),
      migrate: vi.fn().mockResolvedValue(ok({ applied: [], skipped: [] })),
    },
    secrets: {
      status: vi.fn().mockResolvedValue(
        ok({
          vaultConfigured: overrides.vaultConfigured ?? false,
          unlocked: overrides.unlocked ?? false,
        }),
      ),
    },
  });
}

function renderGate(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ChronosGate />, { wrapper });
}

describe("boot gate contract (reduced motion)", () => {
  beforeEach(() => {
    useUiStore.setState({
      currentView: "splash",
      setupGateActive: true,
      unlockCurtainActive: false,
    });
  });

  it("first run: overlays, hands off to systemCheck beneath the plate, then dismisses", async () => {
    stubVex({ setupCompleteFlag: false });
    const { container } = renderGate();

    expect(
      container.querySelector('[data-vex-screen="chronos-gate"]'),
    ).not.toBeNull();
    expect(useUiStore.getState().currentView).toBe("splash");

    await waitFor(() =>
      expect(useUiStore.getState().currentView).toBe("systemCheck"),
    );
    await waitFor(() =>
      expect(useUiStore.getState().setupGateActive).toBe(false),
    );
  });

  it("returning user with a locked vault lands on unlock via openUnlock", async () => {
    stubVex({ setupCompleteFlag: true, vaultConfigured: true, unlocked: false });
    renderGate();

    await waitFor(() =>
      expect(useUiStore.getState().currentView).toBe("unlock"),
    );
    expect(useUiStore.getState().unlockReturnView).toBe("appShell");
    await waitFor(() =>
      expect(useUiStore.getState().setupGateActive).toBe(false),
    );
  });

  it("renders nothing once dismissed", () => {
    stubVex({ setupCompleteFlag: false });
    useUiStore.setState({ setupGateActive: false });
    const { container } = renderGate();
    expect(
      container.querySelector('[data-vex-screen="chronos-gate"]'),
    ).toBeNull();
  });
});
