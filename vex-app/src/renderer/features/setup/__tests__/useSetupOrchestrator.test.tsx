/**
 * Launch-pipeline pins for `useSetupOrchestrator` (Chronos Gate PR1).
 * The pipeline re-sequences the classic screens' IPC contracts, so these
 * tests pin the contract-critical properties:
 *  - first run (`setupCompleteFlag=false`) hands off to systemCheck and
 *    NEVER auto-starts compose or migrate;
 *  - macOS translocation forces systemCheck even for a returning user;
 *  - a broken Docker state hands off to dockerBootstrap before compose;
 *  - the happy returning path runs compose → migrate → wizard-entry in
 *    order and lands on appShell;
 *  - `database.onProgress` is subscribed BEFORE `database.migrate` is
 *    invoked (the push bus replays to late subscribers — ordering is a
 *    documented contract, not style);
 *  - non-happy compose/migrate outcomes hand off to the classic screen
 *    that owns that remediation;
 *  - a completed setup with a locked vault hands off to unlock;
 *  - on the native runtime the gate waits for main's start: ready →
 *    migrate; a failure or a model download → runtimeBootstrap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { NativeRuntimeStatus } from "@shared/schemas/system.js";
import { useSetupOrchestrator } from "../useSetupOrchestrator.js";

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

const WIZARD_DONE = {
  schemaVersion: 2,
  currentStepId: "review",
  completedSteps: [
    "keystore",
    "wallets",
    "apiKeys",
    "embedding",
    "agentCore",
    "provider",
  ],
  completed: true,
};

interface VexMock {
  readonly health: ReturnType<typeof vi.fn>;
  readonly runtime: ReturnType<typeof vi.fn>;
  readonly runtimeStatus: ReturnType<typeof vi.fn>;
  readonly onRuntimeProgress: ReturnType<typeof vi.fn>;
  readonly detect: ReturnType<typeof vi.fn>;
  readonly getEnvState: ReturnType<typeof vi.fn>;
  readonly composeUpAbortable: ReturnType<typeof vi.fn>;
  readonly onProgress: ReturnType<typeof vi.fn>;
  readonly migrate: ReturnType<typeof vi.fn>;
  readonly getWizardState: ReturnType<typeof vi.fn>;
  readonly secretsStatus: ReturnType<typeof vi.fn>;
}

const runtimeListeners = new Set<(status: NativeRuntimeStatus) => void>();

function emitRuntime(status: NativeRuntimeStatus): void {
  for (const listener of runtimeListeners) listener(status);
}

function installVexMock(overrides: Partial<VexMock> = {}): VexMock {
  const mock: VexMock = {
    health: vi.fn(async () => ok(HEALTH)),
    runtime: vi.fn(async () => ok({ native: false })),
    runtimeStatus: vi.fn(async () => ok({ seq: 6, phase: "ready" })),
    onRuntimeProgress: vi.fn((cb: (status: NativeRuntimeStatus) => void) => {
      runtimeListeners.add(cb);
      return () => runtimeListeners.delete(cb);
    }),
    detect: vi.fn(async () => ok(DOCKER_READY)),
    getEnvState: vi.fn(async () => ok({ setupCompleteFlag: true })),
    composeUpAbortable: vi.fn(() => ({
      promise: Promise.resolve(ok(COMPOSE_RUNNING)),
      cancel: vi.fn(),
    })),
    onProgress: vi.fn(() => vi.fn()),
    migrate: vi.fn(async () => ok({ kind: "noop", message: "current" })),
    getWizardState: vi.fn(async () => ok(WIZARD_DONE)),
    secretsStatus: vi.fn(async () =>
      ok({ vaultConfigured: true, unlocked: true }),
    ),
    ...overrides,
  };
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      system: {
        health: mock.health,
        runtime: mock.runtime,
        runtimeStatus: mock.runtimeStatus,
        onRuntimeProgress: mock.onRuntimeProgress,
      },
      docker: {
        detect: mock.detect,
        composeUpAbortable: mock.composeUpAbortable,
      },
      onboarding: {
        getEnvState: mock.getEnvState,
        getWizardState: mock.getWizardState,
      },
      database: { onProgress: mock.onProgress, migrate: mock.migrate },
      secrets: { status: mock.secretsStatus },
    },
  });
  return mock;
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.restoreAllMocks();
  runtimeListeners.clear();
});

afterEach(() => {
  // @ts-expect-error — test cleanup
  delete window.vex;
});

describe("useSetupOrchestrator", () => {
  it("first run hands off to systemCheck and never touches compose/migrate", async () => {
    const mock = installVexMock({
      getEnvState: vi.fn(async () => ok({ setupCompleteFlag: false })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({
        kind: "view",
        view: "systemCheck",
      }),
    );
    expect(mock.composeUpAbortable).not.toHaveBeenCalled();
    expect(mock.migrate).not.toHaveBeenCalled();
  });

  it("translocation forces systemCheck even when setup is complete", async () => {
    const mock = installVexMock({
      health: vi.fn(async () => ok({ ...HEALTH, translocated: true })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({
        kind: "view",
        view: "systemCheck",
      }),
    );
    expect(mock.composeUpAbortable).not.toHaveBeenCalled();
  });

  it("a stopped daemon hands off to dockerBootstrap before compose", async () => {
    const mock = installVexMock({
      detect: vi.fn(async () =>
        ok({ ...DOCKER_READY, daemon: { running: false, startable: true } }),
      ),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({
        kind: "view",
        view: "dockerBootstrap",
      }),
    );
    expect(mock.composeUpAbortable).not.toHaveBeenCalled();
  });

  it("happy returning path runs compose → migrate → appShell in order", async () => {
    const calls: string[] = [];
    const mock = installVexMock({
      composeUpAbortable: vi.fn(() => {
        calls.push("compose");
        return { promise: Promise.resolve(ok(COMPOSE_RUNNING)), cancel: vi.fn() };
      }),
      onProgress: vi.fn(() => {
        calls.push("subscribe");
        return vi.fn();
      }),
      migrate: vi.fn(async () => {
        calls.push("migrate");
        return ok({ kind: "noop", message: "current" });
      }),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }),
    );
    // subscribe-before-invoke is a documented contract of the progress bus.
    expect(calls).toEqual(["compose", "subscribe", "migrate"]);
    expect(mock.getWizardState).toHaveBeenCalledTimes(1);
  });

  it("native runtime: no container gate or compose; migrate joins main's start → appShell", async () => {
    const calls: string[] = [];
    const mock = installVexMock({
      runtime: vi.fn(async () => ok({ native: true })),
      // A stopped engine would send the container gate to bootstrap; on the
      // native runtime it must not even be probed.
      detect: vi.fn(async () => ok({ ...DOCKER_READY, daemon: { ...DOCKER_READY.daemon, running: false } })),
      onProgress: vi.fn(() => {
        calls.push("subscribe");
        return vi.fn();
      }),
      migrate: vi.fn(async () => {
        calls.push("migrate");
        return ok({ kind: "noop", message: "current" });
      }),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }),
    );
    expect(mock.composeUpAbortable).not.toHaveBeenCalled();
    expect(mock.detect).not.toHaveBeenCalled();
    expect(calls).toEqual(["subscribe", "migrate"]);
    expect(runtimeListeners.size).toBe(0);
  });

  it("native runtime: a first run hands off to systemCheck without probing the container engine", async () => {
    const mock = installVexMock({
      runtime: vi.fn(async () => ok({ native: true })),
      getEnvState: vi.fn(async () => ok({ setupCompleteFlag: false })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() => expect(result.current.handoff).toEqual({ kind: "view", view: "systemCheck" }));
    expect(mock.detect).not.toHaveBeenCalled();
  });

  it("container runtime: the engine is probed once, alongside the other probes", async () => {
    const mock = installVexMock();
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() => expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }));
    expect(mock.detect).toHaveBeenCalledTimes(1);
    expect(mock.runtime).toHaveBeenCalledTimes(1);
  });

  it("native runtime: the gate waits through a start in flight, then migrates", async () => {
    const mock = installVexMock({
      runtime: vi.fn(async () => ok({ native: true })),
      runtimeStatus: vi.fn(async () => ok({ seq: 2, phase: "postgres", initializing: false })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() => expect(runtimeListeners.size).toBe(1));
    await waitFor(() => expect(result.current.status.key).toBe("services"));
    emitRuntime({ seq: 3, phase: "model", model: { state: "checking" } });
    emitRuntime({ seq: 4, phase: "embeddings" });
    expect(mock.migrate).not.toHaveBeenCalled();
    expect(result.current.handoff).toBeNull();
    emitRuntime({ seq: 5, phase: "ready" });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }),
    );
    expect(mock.migrate).toHaveBeenCalledTimes(1);
    expect(runtimeListeners.size).toBe(0);
  });

  it.each<[string, NativeRuntimeStatus]>([
    [
      "a model download",
      {
        seq: 3,
        phase: "model",
        model: { state: "downloading", receivedBytes: 1, totalBytes: 10, bytesPerSecond: null },
      },
    ],
    ["a model re-hash", { seq: 3, phase: "model", model: { state: "verifying" } }],
    ["a failed start", { seq: 3, phase: "failed", step: "postgres", kind: "port_collision", message: "No port." }],
  ])("native runtime: %s hands off to runtimeBootstrap without migrating", async (_label, status) => {
    const mock = installVexMock({
      runtime: vi.fn(async () => ok({ native: true })),
      runtimeStatus: vi.fn(async () => ok(status)),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "runtimeBootstrap" }),
    );
    expect(mock.migrate).not.toHaveBeenCalled();
    expect(runtimeListeners.size).toBe(0);
  });

  it("native runtime: a status reply older than an event already seen is ignored", async () => {
    let answer: (value: unknown) => void = () => {};
    const mock = installVexMock({
      runtime: vi.fn(async () => ok({ native: true })),
      runtimeStatus: vi.fn(() => new Promise((resolve) => (answer = resolve))),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() => expect(runtimeListeners.size).toBe(1));
    emitRuntime({ seq: 5, phase: "ready" });
    answer(ok({ seq: 4, phase: "failed", step: "embeddings", kind: "failed", message: "stale" }));
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }),
    );
    expect(mock.migrate).toHaveBeenCalledTimes(1);
  });

  it("native runtime: an unreadable status hands off to runtimeBootstrap", async () => {
    installVexMock({
      runtime: vi.fn(async () => ok({ native: true })),
      runtimeStatus: vi.fn(async () => ({ ok: false, error: { code: "internal.unexpected", message: "x" } })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "runtimeBootstrap" }),
    );
  });

  it("compose provider: never reads the native runtime's status", async () => {
    const mock = installVexMock();
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }),
    );
    expect(mock.runtimeStatus).not.toHaveBeenCalled();
    expect(mock.onRuntimeProgress).not.toHaveBeenCalled();
  });

  it("port_collision hands off to the classic compose screen", async () => {
    installVexMock({
      composeUpAbortable: vi.fn(() => ({
        promise: Promise.resolve(
          ok({
            ...COMPOSE_RUNNING,
            kind: "port_collision",
            previousInstallHoldingPorts: true,
          }),
        ),
        cancel: vi.fn(),
      })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({
        kind: "view",
        view: "composeBootstrap",
      }),
    );
  });

  it("a migrate failure hands off to the classic migrations screen", async () => {
    installVexMock({
      migrate: vi.fn(async () => ({
        ok: false as const,
        error: { domain: "database", code: "database.migrate_failed", message: "boom" },
      })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({
        kind: "view",
        view: "migrations",
      }),
    );
  });

  it("a completed setup with a locked vault hands off to unlock", async () => {
    installVexMock({
      secretsStatus: vi.fn(async () =>
        ok({ vaultConfigured: true, unlocked: false }),
      ),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({
        kind: "unlock",
        returnView: "appShell",
      }),
    );
  });
});
