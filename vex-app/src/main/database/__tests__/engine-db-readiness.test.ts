/**
 * THE ENGINE DATABASE READINESS OWNER.
 *
 * The properties, each of which is a live defect this module closes:
 *
 *   1. IT WAITS. On a cold start the local Postgres appears when the renderer
 *      triggers compose, ten to twenty seconds after main is ready. A boot-time
 *      consumer that gives up on its own decides that a slow database is a
 *      dead one - which is what left Vex Studio unavailable for a whole
 *      session. The only exit from the wait is the caller's abort.
 *   2. ONE POLL, however many waiters. The bridge and anything else that waits
 *      share a single timer and a single in-flight probe.
 *   3. THE MIGRATIONS COUNT. A URL that resolves is not a schema that exists.
 *   4. NO TIMER SURVIVES. Resolve or abort, the interval is cleared.
 *   5. THE RECYCLE COMMITS AT THE DRAIN. A `closePool()` that rejects leaves
 *      readiness false and is retried; concurrent callers share one drain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildPoolConfig = vi.fn();
vi.mock("../db-config.js", () => ({
  buildPoolConfig: () => buildPoolConfig(),
}));

let migrationsDone = false;
vi.mock("../migrations-applied.js", () => ({
  migrationsApplied: () => migrationsDone,
  markMigrationsApplied: () => {
    migrationsDone = true;
  },
}));

const closePool = vi.fn(() => Promise.resolve());
vi.mock("@vex-agent/db/client.js", () => ({ closePool: () => closePool() }));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  EngineDbWaitAbortedError,
  ensureEngineDbUrl,
  isEngineDbReady,
  resetEngineDbReadinessForTests,
  whenEngineDbReady,
} = await import("../engine-db-readiness.js");
const { log } = await import("../../logger/index.js");

const CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "vex",
  user: "vex",
  password: "test-password",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetEngineDbReadinessForTests();
  migrationsDone = false;
  buildPoolConfig.mockResolvedValue(null);
  delete process.env.VEX_DB_URL;
});

afterEach(() => {
  resetEngineDbReadinessForTests();
  vi.useRealTimers();
  delete process.env.VEX_DB_URL;
});

describe("ensureEngineDbUrl", () => {
  it("points the pool at the compose database and recycles it once", async () => {
    buildPoolConfig.mockResolvedValue(CONFIG);
    const first = await ensureEngineDbUrl("corr-1");
    expect(first.ok).toBe(true);
    expect(process.env.VEX_DB_URL).toBe(
      "postgresql://vex:test-password@127.0.0.1:5433/vex",
    );
    expect(closePool).toHaveBeenCalledTimes(1);

    // The same URL again is not a pool recycle: the drain would drop live
    // connections for no change.
    const second = await ensureEngineDbUrl("corr-2");
    expect(second.ok).toBe(true);
    expect(closePool).toHaveBeenCalledTimes(1);
  });

  /**
   * THE COMMIT POINT. The applied URL used to be read back off
   * `process.env.VEX_DB_URL`, which this function writes BEFORE the drain, so a
   * `closePool()` that REJECTED left the next pass comparing its own
   * half-applied variable, accepting the equality, and reporting a database
   * that the pool it had failed to close was still serving.
   */
  it("stays UNREADY when the pool drain fails, and commits on the next one", async () => {
    buildPoolConfig.mockResolvedValue(CONFIG);
    migrationsDone = true;
    closePool.mockRejectedValueOnce(new Error("pool would not drain"));

    const failed = await ensureEngineDbUrl("corr-close-1");
    expect(failed.ok).toBe(false);
    expect(isEngineDbReady()).toBe(false);
    // The variable IS written - the pool rebuilds itself from it - but it is
    // not the fact readiness is derived from.
    expect(process.env.VEX_DB_URL).toBe(
      "postgresql://vex:test-password@127.0.0.1:5433/vex",
    );

    // The next call retries the recycle instead of trusting the environment.
    const repaired = await ensureEngineDbUrl("corr-close-2");
    expect(repaired.ok).toBe(true);
    expect(closePool).toHaveBeenCalledTimes(2);
    expect(isEngineDbReady()).toBe(true);
  });

  it("serializes concurrent callers into ONE drain", async () => {
    buildPoolConfig.mockResolvedValue(CONFIG);
    migrationsDone = true;
    let releaseDrain = (): void => {};
    closePool.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = () => {
            resolve();
          };
        }),
    );

    const first = ensureEngineDbUrl("corr-concurrent-1");
    const second = ensureEngineDbUrl("corr-concurrent-2");
    // The second caller JOINED the pass already running, and nothing has been
    // committed while the drain is still open.
    await vi.waitFor(() => {
      expect(closePool).toHaveBeenCalledTimes(1);
    });
    expect(isEngineDbReady()).toBe(false);

    releaseDrain();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.ok).toBe(true);
    expect(secondOutcome.ok).toBe(true);
    expect(closePool).toHaveBeenCalledTimes(1);
    expect(isEngineDbReady()).toBe(true);
  });

  it("reports the database as unavailable while compose has written nothing", async () => {
    const outcome = await ensureEngineDbUrl("corr-3");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.domain).toBe("database");
    expect(outcome.error.retryable).toBe(true);
    expect(process.env.VEX_DB_URL).toBeUndefined();
    expect(isEngineDbReady()).toBe(false);
  });
});

describe("whenEngineDbReady", () => {
  it("resolves the moment both facts hold, not before", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const waiting = whenEngineDbReady().then(() => {
      resolved = true;
    });

    // Compose has not run: five polls, no resolution.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolved).toBe(false);
    expect(buildPoolConfig.mock.calls.length).toBeGreaterThanOrEqual(5);

    // The URL arrives BEFORE the migrations: a schema that does not exist yet
    // is not a database this process may query.
    buildPoolConfig.mockResolvedValue(CONFIG);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(resolved).toBe(false);

    migrationsDone = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    expect(resolved).toBe(true);
    expect(isEngineDbReady()).toBe(true);
    // Nothing is left ticking once the last waiter is gone.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves immediately when the database is already up", async () => {
    buildPoolConfig.mockResolvedValue(CONFIG);
    migrationsDone = true;
    await whenEngineDbReady();
    expect(isEngineDbReady()).toBe(true);
  });

  it("shares ONE poll between concurrent waiters", async () => {
    vi.useFakeTimers();
    const first = whenEngineDbReady();
    const second = whenEngineDbReady();
    await vi.advanceTimersByTimeAsync(3_000);
    const pollsForBoth = buildPoolConfig.mock.calls.length;

    buildPoolConfig.mockResolvedValue(CONFIG);
    migrationsDone = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);

    // Two waiters did not double the probe rate: 3 s of a 1 s poll is four
    // probes at most (the immediate one plus three ticks), not eight.
    expect(pollsForBoth).toBeLessThanOrEqual(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on abort, leaves no timer, and does not disturb the other waiter", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const aborted = whenEngineDbReady({ signal: controller.signal });
    const survivor = whenEngineDbReady();
    await vi.advanceTimersByTimeAsync(1_000);

    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(EngineDbWaitAbortedError);
    // The surviving waiter still owns the poll.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    buildPoolConfig.mockResolvedValue(CONFIG);
    migrationsDone = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await survivor;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already-aborted signal without arming anything", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    await expect(
      whenEngineDbReady({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(EngineDbWaitAbortedError);
    expect(vi.getTimerCount()).toBe(0);
    expect(buildPoolConfig).not.toHaveBeenCalled();
  });

  it("says it is waiting ONCE and says it is ready ONCE", async () => {
    vi.useFakeTimers();
    const first = whenEngineDbReady();
    const second = whenEngineDbReady();
    await vi.advanceTimersByTimeAsync(4_000);
    buildPoolConfig.mockResolvedValue(CONFIG);
    migrationsDone = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);

    const lines = vi.mocked(log.info).mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("waiting for the database"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("engine database ready"))).toHaveLength(1);
  });
});
