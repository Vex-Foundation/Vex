/**
 * Tests for the vex.database.migrate IPC handler. Verifies:
 *   - applied/noop runner kinds map to ok({...})
 *   - failed runner kind maps to err({code:"data.migration_failed"})
 *     with details.failedAt when present
 *   - parallel invocations dedup into a single underlying runner call
 *   - failed in-flight is cleared so a follow-up Retry creates a fresh run
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown
) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const mockRunMigrationsForIpc = vi.fn();
const mockSubscribe = vi.fn(() => () => {});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../../database/migrate-runner.js", () => ({
  runMigrationsForIpc: () => mockRunMigrationsForIpc(),
}));

const mockPeek = vi.fn(() => null);
const mockReset = vi.fn();

vi.mock("../../database/progress-bus.js", () => ({
  migrationProgressBus: {
    subscribe: (cb: unknown) => mockSubscribe(cb),
    peek: () => mockPeek(),
    reset: () => mockReset(),
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockMode = vi.fn(() => "docker");
const mockGateStart = vi.fn();
vi.mock("../../runtime/runtime-mode.js", () => ({ getRuntimeMode: () => mockMode() }));
vi.mock("../../runtime/migration/native-start-gate.js", () => ({
  nativeStartGate: () => ({ startNative: () => mockGateStart() }),
}));

vi.mock("../../onboarding/ensure-embedding-defaults.js", () => ({
  ensureEmbeddingDefaults: vi
    .fn()
    .mockResolvedValue({ kind: "preserved", writtenKeys: [] }),
}));

const { registerDatabaseHandlers } = await import("../database.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({
  // ctx.event.sender — used by the join branch to replay the latest
  // progress event directly to the joining renderer's webContents.
  sender: createTestWebContents(),
});

beforeEach(() => {
  handlers.clear();
  mockRunMigrationsForIpc.mockReset();
  mockSubscribe.mockClear();
  mockPeek.mockReset();
  mockPeek.mockReturnValue(null);
  mockReset.mockClear();
  trustedSender.sender.send.mockReset();
  mockMode.mockReturnValue("docker");
  mockGateStart.mockReset();
});

afterEach(() => {
  handlers.clear();
});

describe("vex.database.migrate handler", () => {
  it("maps runner applied → ok({kind:'applied'})", async () => {
    mockRunMigrationsForIpc.mockResolvedValue({
      kind: "applied",
      applied: 3,
      files: ["001_a.sql", "002_b.sql", "003_c.sql"],
      message: "Applied 3 migrations.",
    });
    registerDatabaseHandlers();

    const fn = handlers.get(CH.database.migrate)!;
    const result = (await fn(trustedSender, {
      requestId: "req-1",
      payload: {},
    })) as {
      ok: true;
      data: { kind: "applied"; applied: number; files: string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.data.kind).toBe("applied");
    expect(result.data.applied).toBe(3);
  });

  it("maps runner noop → ok({kind:'noop'})", async () => {
    mockRunMigrationsForIpc.mockResolvedValue({
      kind: "noop",
      message: "All migrations already applied.",
    });
    registerDatabaseHandlers();

    const fn = handlers.get(CH.database.migrate)!;
    const result = (await fn(trustedSender, {
      requestId: "req-2",
      payload: {},
    })) as { ok: true; data: { kind: "noop" } };
    expect(result.ok).toBe(true);
    expect(result.data.kind).toBe("noop");
  });

  it("maps runner failed{failedAt} → err with details.failedAt", async () => {
    mockRunMigrationsForIpc.mockResolvedValue({
      kind: "failed",
      message: "Migration 007_thing.sql failed: syntax error",
      failedAt: { version: 7, file: "007_thing.sql" },
    });
    registerDatabaseHandlers();

    const fn = handlers.get(CH.database.migrate)!;
    const result = (await fn(trustedSender, {
      requestId: "req-3",
      payload: {},
    })) as {
      ok: false;
      error: {
        code: string;
        domain: string;
        retryable: boolean;
        details?: { failedAt?: { version: number; file: string } };
      };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("data.migration_failed");
    expect(result.error.domain).toBe("database");
    expect(result.error.retryable).toBe(true);
    expect(result.error.details?.failedAt).toEqual({
      version: 7,
      file: "007_thing.sql",
    });
  });

  it("omits details when failedAt is null", async () => {
    mockRunMigrationsForIpc.mockResolvedValue({
      kind: "failed",
      message: "ECONNREFUSED",
      failedAt: null,
    });
    registerDatabaseHandlers();

    const fn = handlers.get(CH.database.migrate)!;
    const result = (await fn(trustedSender, {
      requestId: "req-4",
      payload: {},
    })) as { ok: false; error: { details?: unknown } };
    expect(result.ok).toBe(false);
    expect(result.error.details).toBeUndefined();
  });

  it("dedups parallel invocations into a single runner call", async () => {
    let resolveRun: ((v: unknown) => void) | null = null;
    mockRunMigrationsForIpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        })
    );
    registerDatabaseHandlers();

    const fn = handlers.get(CH.database.migrate)!;
    const a = fn(trustedSender, { requestId: "a", payload: {} });
    const b = fn(trustedSender, { requestId: "b", payload: {} });

    expect(mockRunMigrationsForIpc).toHaveBeenCalledTimes(1);
    resolveRun?.({ kind: "noop", message: "x" });
    const [resA, resB] = (await Promise.all([a, b])) as Array<{ ok: boolean }>;
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
  });

  it("clears in-flight on failure so Retry creates a fresh run", async () => {
    mockRunMigrationsForIpc
      .mockResolvedValueOnce({
        kind: "failed",
        message: "boom",
        failedAt: null,
      })
      .mockResolvedValueOnce({
        kind: "noop",
        message: "ok",
      });
    registerDatabaseHandlers();

    const fn = handlers.get(CH.database.migrate)!;
    const first = (await fn(trustedSender, {
      requestId: "1",
      payload: {},
    })) as { ok: boolean };
    expect(first.ok).toBe(false);

    const second = (await fn(trustedSender, {
      requestId: "2",
      payload: {},
    })) as { ok: boolean };
    expect(second.ok).toBe(true);
    expect(mockRunMigrationsForIpc).toHaveBeenCalledTimes(2);
  });

  it("subscribes to the progress bus once at registration", () => {
    registerDatabaseHandlers();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it("replays the latest progress event to a joined caller via event.sender", async () => {
    const lastEvent = {
      phase: "applied" as const,
      index: 1,
      total: 5,
      version: 2,
      file: "002_b.sql",
      ts: 100,
    };
    mockPeek.mockReturnValue(lastEvent as unknown as null);

    let resolveRun: ((v: unknown) => void) | null = null;
    mockRunMigrationsForIpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        })
    );
    registerDatabaseHandlers();
    const fn = handlers.get(CH.database.migrate)!;

    const a = fn(trustedSender, { requestId: "a", payload: {} });
    const b = fn(trustedSender, { requestId: "b", payload: {} });

    // Only the joiner replays; fresh caller does not.
    expect(trustedSender.sender.send).toHaveBeenCalledTimes(1);
    expect(trustedSender.sender.send).toHaveBeenCalledWith(
      "vex:event:database:migrateProgress",
      lastEvent
    );

    resolveRun?.({ kind: "noop", message: "ok" });
    await Promise.all([a, b]);
  });

  it("native: starts nothing and reports why while the install's data must be moved first", async () => {
    mockMode.mockReturnValue("native");
    mockGateStart.mockResolvedValue({ kind: "migration_pending", message: "Your existing data must be moved first." });
    registerDatabaseHandlers();
    const fn = handlers.get(CH.database.migrate)!;
    const result = (await fn(trustedSender, { requestId: "n1", payload: {} })) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("data.migration_failed");
    expect(result.error.message).toContain("Your existing data must be moved first.");
    expect(mockRunMigrationsForIpc).not.toHaveBeenCalled();
  });

  it("native: migrates once the gate started the runtime", async () => {
    mockMode.mockReturnValue("native");
    mockGateStart.mockResolvedValue({ kind: "running", message: "ok" });
    mockRunMigrationsForIpc.mockResolvedValue({ kind: "noop", message: "up to date" });
    registerDatabaseHandlers();
    const fn = handlers.get(CH.database.migrate)!;
    const result = (await fn(trustedSender, { requestId: "n2", payload: {} })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mockGateStart).toHaveBeenCalledTimes(1);
    expect(mockRunMigrationsForIpc).toHaveBeenCalledTimes(1);
  });
});
