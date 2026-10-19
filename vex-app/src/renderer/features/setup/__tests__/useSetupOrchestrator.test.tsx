/**
 * Launch-pipeline pins for `useSetupOrchestrator` (Chronos Gate PR1).
 * The pipeline re-sequences the classic screens' IPC contracts, so these
 * tests pin the contract-critical properties:
 *  - first run (`setupCompleteFlag=false`) hands off to systemCheck and
 *    NEVER waits on the runtime or migrates;
 *  - macOS translocation forces systemCheck even for a returning user;
 *  - the gate waits for main's start of the native runtime: ready →
 *    migrate → wizard-entry → appShell; a failure or a model download →
 *    runtimeBootstrap. Before that, any migration status but not_needed →
 *    runtimeMigration (main has not started the runtime, so waiting for it
 *    would never end);
 *  - an e2e door run (`native: false`) starts and waits on nothing: its
 *    database is already published, so it goes straight to migrate;
 *  - `database.onProgress` is subscribed BEFORE `database.migrate` is
 *    invoked (the push bus replays to late subscribers — ordering is a
 *    documented contract, not style);
 *  - a non-happy migrate outcome hands off to the classic migrations screen;
 *  - a completed setup with a locked vault hands off to unlock.
 *
 * `window.vex` carries no `docker` namespace: any call into one would throw
 * and fail the pipeline.
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
  readonly runtimeMigrationStatus: ReturnType<typeof vi.fn>;
  readonly onRuntimeProgress: ReturnType<typeof vi.fn>;
  readonly getEnvState: ReturnType<typeof vi.fn>;
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
    runtime: vi.fn(async () => ok({ native: true })),
    runtimeStatus: vi.fn(async () => ok({ seq: 6, phase: "ready" })),
    runtimeMigrationStatus: vi.fn(async () => ok({ kind: "not_needed" })),
    onRuntimeProgress: vi.fn((cb: (status: NativeRuntimeStatus) => void) => {
      runtimeListeners.add(cb);
      return () => runtimeListeners.delete(cb);
    }),
    getEnvState: vi.fn(async () => ok({ setupCompleteFlag: true })),
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
        runtimeMigrationStatus: mock.runtimeMigrationStatus,
        onRuntimeProgress: mock.onRuntimeProgress,
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

/** The door run's answer: main starts no runtime. */
const door = (): Pick<VexMock, "runtime"> => ({ runtime: vi.fn(async () => ok({ native: false })) });

beforeEach(() => {
  vi.restoreAllMocks();
  runtimeListeners.clear();
});

afterEach(() => {
  // @ts-expect-error — test cleanup
  delete window.vex;
});

describe("useSetupOrchestrator", () => {
  it("first run hands off to systemCheck and never waits on the runtime or migrates", async () => {
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
    expect(mock.runtimeMigrationStatus).not.toHaveBeenCalled();
    expect(mock.runtimeStatus).not.toHaveBeenCalled();
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
    expect(mock.runtimeStatus).not.toHaveBeenCalled();
    expect(mock.migrate).not.toHaveBeenCalled();
  });

  it("happy returning path: the runtime is ready, migrate joins main's start → appShell", async () => {
    const calls: string[] = [];
    const mock = installVexMock({
      runtimeMigrationStatus: vi.fn(async () => {
        calls.push("migrationStatus");
        return ok({ kind: "not_needed" });
      }),
      runtimeStatus: vi.fn(async () => {
        calls.push("runtimeStatus");
        return ok({ seq: 6, phase: "ready" });
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
    expect(calls).toEqual(["migrationStatus", "runtimeStatus", "subscribe", "migrate"]);
    expect(mock.getWizardState).toHaveBeenCalledTimes(1);
    expect(runtimeListeners.size).toBe(0);
  });

  it("the runtime mode is probed once, alongside the other probes", async () => {
    const mock = installVexMock();
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() => expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }));
    expect(mock.runtime).toHaveBeenCalledTimes(1);
    expect(mock.health).toHaveBeenCalledTimes(1);
    expect(mock.getEnvState).toHaveBeenCalledTimes(1);
  });

  it("an unreadable runtime mode takes the native path, not the door's", async () => {
    const mock = installVexMock({
      runtime: vi.fn(async () => ({ ok: false, error: { code: "internal.unexpected", message: "x" } })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() => expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }));
    expect(mock.runtimeMigrationStatus).toHaveBeenCalledTimes(1);
    expect(mock.runtimeStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a pending move", ok({ kind: "pending", resumeStep: null, lastFailure: null })],
    ["a move whose source is offline", ok({ kind: "pending_source_offline", detail: "x", resumeStep: null, lastFailure: null })],
    ["an unreadable runtime state", ok({ kind: "state_unreadable", message: "does not parse" })],
    ["a move in progress", ok({ kind: "in_progress", op: "migrate", progress: null })],
    ["an IPC failure", { ok: false, error: { code: "internal.unexpected", message: "x" } }],
  ])("%s hands off to runtimeMigration without waiting or migrating", async (_label, answer) => {
    const mock = installVexMock({
      runtimeMigrationStatus: vi.fn(async () => answer),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "runtimeMigration" }),
    );
    expect(mock.runtimeStatus).not.toHaveBeenCalled();
    expect(mock.migrate).not.toHaveBeenCalled();
    expect(runtimeListeners.size).toBe(0);
  });

  it("the gate waits through a start in flight, then migrates", async () => {
    const mock = installVexMock({
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
  ])("%s hands off to runtimeBootstrap without migrating", async (_label, status) => {
    const mock = installVexMock({
      runtimeStatus: vi.fn(async () => ok(status)),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "runtimeBootstrap" }),
    );
    expect(mock.migrate).not.toHaveBeenCalled();
    expect(runtimeListeners.size).toBe(0);
  });

  it("a status reply older than an event already seen is ignored", async () => {
    let answer: (value: unknown) => void = () => {};
    const mock = installVexMock({
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

  it("an unreadable status hands off to runtimeBootstrap", async () => {
    installVexMock({
      runtimeStatus: vi.fn(async () => ({ ok: false, error: { code: "internal.unexpected", message: "x" } })),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "runtimeBootstrap" }),
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

  it("a migrate call that throws hands off to the classic migrations screen", async () => {
    const unsubscribe = vi.fn();
    installVexMock({
      onProgress: vi.fn(() => unsubscribe),
      migrate: vi.fn(async () => {
        throw new Error("bridge gone");
      }),
    });
    const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
    await waitFor(() =>
      expect(result.current.handoff).toEqual({ kind: "view", view: "migrations" }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
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

  describe("in an e2e door run (native: false)", () => {
    it("starts and waits on nothing: subscribe → migrate → appShell", async () => {
      const calls: string[] = [];
      const statuses: string[] = [];
      const mock = installVexMock({
        ...door(),
        onProgress: vi.fn(() => {
          calls.push("subscribe");
          return vi.fn();
        }),
        migrate: vi.fn(async () => {
          calls.push("migrate");
          return ok({ kind: "noop", message: "current" });
        }),
      });
      const { result } = renderHook(
        () => {
          const orchestrator = useSetupOrchestrator();
          statuses.push(orchestrator.status.key);
          return orchestrator;
        },
        { wrapper },
      );
      await waitFor(() =>
        expect(result.current.handoff).toEqual({ kind: "view", view: "appShell" }),
      );
      expect(calls).toEqual(["subscribe", "migrate"]);
      expect(mock.runtimeMigrationStatus).not.toHaveBeenCalled();
      expect(mock.runtimeStatus).not.toHaveBeenCalled();
      expect(mock.onRuntimeProgress).not.toHaveBeenCalled();
      // No "Starting services" line: nothing is started.
      expect(statuses).not.toContain("services");
    });

    it("a first run still hands off to systemCheck without migrating", async () => {
      const mock = installVexMock({
        ...door(),
        getEnvState: vi.fn(async () => ok({ setupCompleteFlag: false })),
      });
      const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
      await waitFor(() => expect(result.current.handoff).toEqual({ kind: "view", view: "systemCheck" }));
      expect(mock.migrate).not.toHaveBeenCalled();
    });

    it("a migrate failure hands off to the classic migrations screen", async () => {
      installVexMock({
        ...door(),
        migrate: vi.fn(async () => ({
          ok: false as const,
          error: { domain: "database", code: "database.migrate_failed", message: "boom" },
        })),
      });
      const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
      await waitFor(() => expect(result.current.handoff).toEqual({ kind: "view", view: "migrations" }));
    });

    it("a locked vault hands off to unlock", async () => {
      installVexMock({
        ...door(),
        secretsStatus: vi.fn(async () => ok({ vaultConfigured: true, unlocked: false })),
      });
      const { result } = renderHook(() => useSetupOrchestrator(), { wrapper });
      await waitFor(() =>
        expect(result.current.handoff).toEqual({ kind: "unlock", returnView: "appShell" }),
      );
    });
  });
});
