/**
 * Integration (Kairos S-3): the concurrent wake pool against REAL Postgres
 * (a disposable testcontainers database), through the real executor, the real
 * atomic claims, the real session leases and the real wallet lookup. Only the
 * slice itself (`continueAgentSession`) and the banner are injected, so no
 * model is ever called.
 *
 * What is proven:
 *   1. with concurrency 3, three sessions (one slow) all START promptly: the
 *      slow slice holds nobody, and each wake runs exactly once;
 *   2. the serial default, measured on the same setup, holds the two fast
 *      sessions behind the slow one (the defect S-3 removes);
 *   3. a second wake of a session whose slice is in flight never starts until
 *      that slice ends, and the session lease refuses it on its own too;
 *   4. two sessions that select one wallet never run together, while a
 *      session on another wallet runs alongside.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { query, queryOne } from "@vex-agent/db/client.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import { startWakeExecutor, type WakeDeps } from "@vex-agent/engine/wake/executor.js";
import { claimMissionWakeAtomically } from "@vex-agent/engine/wake/executor/claim-mission-wake.js";
import { claimSessionWakeAtomically } from "@vex-agent/engine/wake/executor/claim-session-wake.js";
import type { RunnerLeaseGuard } from "@vex-agent/engine/runtime/lease-guard.js";
import { requireValue } from "../../helpers/require-value.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

const SLOW_MS = 1_500;
const INTERVAL_MS = 50;

interface SliceLog {
  /** ms since the executor started, per slice start, per session. */
  readonly starts: Map<string, number[]>;
  readonly ends: Map<string, number[]>;
  /** Highest number of slices of one session seen running at once. */
  maxPerSession: number;
  /** Highest number of slices on one wallet seen running at once. */
  maxPerWallet: number;
  maxOverall: number;
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

async function seedWake(sessionId: string, dueSecondsAgo = 5): Promise<string> {
  const row = await loopWakeRepo.enqueue({
    sessionId,
    missionRunId: null,
    dueAt: new Date(Date.now() - dueSecondsAgo * 1000),
    reason: "continue the watch",
    payload: { trigger: "iteration_limit", automatic: true },
  });
  return requireValue(row).id;
}

async function selectEvmWallet(sessionId: string, address: string): Promise<void> {
  await query(
    `UPDATE sessions
        SET selected_evm_wallet_id = $2, selected_evm_wallet_address = $3
      WHERE id = $1`,
    [sessionId, `wallet-${address.slice(-4)}`, address],
  );
}

async function wakeStatus(wakeId: string): Promise<string> {
  const row = await queryOne<{ status: string }>(
    "SELECT status FROM loop_wake_requests WHERE id = $1",
    [wakeId],
  );
  return requireValue(row).status;
}

async function liveLeases(): Promise<number> {
  const row = await queryOne<{ n: string }>("SELECT COUNT(*)::text AS n FROM runner_leases");
  return Number(requireValue(row).n);
}

/**
 * Real claims, real lists; the slice records when it ran and holds
 * `slowSessions` for SLOW_MS. `walletOf` maps a session to its wallet for the
 * overlap bookkeeping only (the pool reads the real session row).
 */
function makeDeps(input: {
  readonly t0: () => number;
  readonly log: SliceLog;
  readonly slowSessions: ReadonlySet<string>;
  readonly walletOf?: ReadonlyMap<string, string>;
}): WakeDeps {
  const runningPerSession = new Map<string, number>();
  const runningPerWallet = new Map<string, number>();
  let running = 0;
  const bump = (map: Map<string, number>, key: string, delta: number): number => {
    const next = (map.get(key) ?? 0) + delta;
    map.set(key, next);
    return next;
  };
  return {
    listDueMissionWakes: (now, limit) => loopWakeRepo.listDueMissionScoped(now, limit),
    claimMissionWake: (claim) => claimMissionWakeAtomically(claim),
    listDueSessionWakes: (now, limit) => loopWakeRepo.listDueSessionScoped(now, limit),
    claimSessionWake: (claim) => claimSessionWakeAtomically(claim),
    injectWakeBanner: vi.fn().mockResolvedValue(undefined),
    resumeMissionRun: vi.fn().mockResolvedValue(undefined),
    continueAgentSession: async (sessionId: string, _lease: RunnerLeaseGuard) => {
      const wallet = input.walletOf?.get(sessionId);
      push(input.log.starts, sessionId, input.t0());
      running += 1;
      input.log.maxOverall = Math.max(input.log.maxOverall, running);
      input.log.maxPerSession = Math.max(input.log.maxPerSession, bump(runningPerSession, sessionId, 1));
      if (wallet !== undefined) {
        input.log.maxPerWallet = Math.max(input.log.maxPerWallet, bump(runningPerWallet, wallet, 1));
      }
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, input.slowSessions.has(sessionId) ? SLOW_MS : 20));
      } finally {
        running -= 1;
        bump(runningPerSession, sessionId, -1);
        if (wallet !== undefined) bump(runningPerWallet, wallet, -1);
        push(input.log.ends, sessionId, input.t0());
      }
    },
    isProviderReady: () => true,
  };
}

function quietSubsidiaries() {
  return {
    startWatchPromoter: () => ({ stop: () => undefined }),
    startPriceWatchPoller: () => ({ stop: () => Promise.resolve() }),
    startRestartOrphanReclaim: () => ({ stop: () => Promise.resolve() }),
    startStuckWakeRepair: () => ({ stop: () => Promise.resolve() }),
  };
}

function newLog(): SliceLog {
  return { starts: new Map(), ends: new Map(), maxPerSession: 0, maxPerWallet: 0, maxOverall: 0 };
}

function first(map: Map<string, number[]>, key: string): number {
  return requireValue(map.get(key)?.[0]);
}

async function runScenario(input: {
  readonly concurrency: number;
  readonly slowSessions: ReadonlySet<string>;
  readonly walletOf?: ReadonlyMap<string, string>;
  readonly until: (log: SliceLog) => boolean;
  readonly during?: (log: SliceLog) => Promise<void>;
}): Promise<SliceLog> {
  const log = newLog();
  let started = 0;
  const handle = startWakeExecutor({
    ...quietSubsidiaries(),
    intervalMs: INTERVAL_MS,
    batchSize: 10,
    concurrency: input.concurrency,
    deps: makeDeps({
      t0: () => Date.now() - started,
      log,
      slowSessions: input.slowSessions,
      walletOf: input.walletOf,
    }),
  });
  started = Date.now();
  try {
    if (input.during !== undefined) await input.during(log);
    await vi.waitFor(() => expect(input.until(log)).toBe(true), { timeout: 15_000, interval: 25 });
  } finally {
    await handle.stop();
  }
  return log;
}

describe("concurrent wake pool (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("concurrency 3: three sessions, one slow, all start promptly and each wake runs exactly once", async () => {
    const slow = await makeSession();
    const fastB = await makeSession();
    const fastC = await makeSession();
    await selectEvmWallet(slow, "0x00000000000000000000000000000000000000a1");
    await selectEvmWallet(fastB, "0x00000000000000000000000000000000000000b2");
    // fastC selects no wallet at all.
    const wakes = [await seedWake(slow), await seedWake(fastB), await seedWake(fastC)];

    const log = await runScenario({
      concurrency: 3,
      slowSessions: new Set([slow]),
      until: (l) => [slow, fastB, fastC].every((s) => (l.ends.get(s)?.length ?? 0) >= 1),
    });

    const slowEnd = first(log.ends, slow);
    for (const s of [slow, fastB, fastC]) {
      // Promptly: within the first passes, long before the slow slice ends.
      expect(first(log.starts, s)).toBeLessThan(INTERVAL_MS * 10);
      // Exactly once.
      expect(log.starts.get(s)).toHaveLength(1);
    }
    expect(first(log.ends, fastB)).toBeLessThan(slowEnd);
    expect(first(log.ends, fastC)).toBeLessThan(slowEnd);
    expect(log.maxOverall).toBe(3);
    expect(log.maxPerSession).toBe(1);
    for (const w of wakes) expect(await wakeStatus(w)).toBe("consumed");
    expect(await liveLeases()).toBe(0);

    process.stdout.write(
      `[S-3 measured] concurrency 3: start ms slow=${first(log.starts, slow)} `
      + `b=${first(log.starts, fastB)} c=${first(log.starts, fastC)}; `
      + `end ms slow=${slowEnd} b=${first(log.ends, fastB)} c=${first(log.ends, fastC)}\n`,
    );
  });

  it("the serial default on the same setup holds the fast sessions behind the slow one", async () => {
    const slow = await makeSession();
    const fastB = await makeSession();
    const fastC = await makeSession();
    // Oldest first, so the serial pass meets the slow session first.
    await seedWake(slow, 30);
    await seedWake(fastB, 20);
    await seedWake(fastC, 10);

    const log = await runScenario({
      concurrency: 1,
      slowSessions: new Set([slow]),
      until: (l) => [slow, fastB, fastC].every((s) => (l.ends.get(s)?.length ?? 0) >= 1),
    });

    const slowEnd = first(log.ends, slow);
    expect(first(log.starts, fastB)).toBeGreaterThanOrEqual(slowEnd);
    expect(first(log.starts, fastC)).toBeGreaterThanOrEqual(slowEnd);
    expect(log.maxOverall).toBe(1);

    process.stdout.write(
      `[S-3 measured] concurrency 1: start ms slow=${first(log.starts, slow)} `
      + `b=${first(log.starts, fastB)} c=${first(log.starts, fastC)}\n`,
    );
  });

  it("a second wake of a session in flight waits for its slice; the lease refuses it on its own", async () => {
    const slow = await makeSession();
    const other = await makeSession();
    await seedWake(slow);
    await seedWake(other);
    let secondWake = "";

    const log = await runScenario({
      concurrency: 3,
      slowSessions: new Set([slow]),
      during: async (l) => {
        await vi.waitFor(() => expect(l.starts.get(slow)?.length ?? 0).toBe(1), { timeout: 5_000 });
        // The first row is consumed, so the session can take a new pending row.
        secondWake = await seedWake(slow);

        // The lease alone: a direct claim while the slice holds the lease is
        // refused and leaves the row pending. (Its backoff is undone below so
        // the pool can admit the row once the slice ends.)
        const direct = await claimSessionWakeAtomically({
          wake: requireValue(await loopWakeRepo.getPendingForSession(slow)),
          ownerId: "second-runner",
          ttlMs: 60_000,
          now: new Date(),
        });
        expect(direct.kind).toBe("lease_busy");
        expect(await wakeStatus(secondWake)).toBe("pending");
        await query(
          "UPDATE loop_wake_requests SET due_at = NOW() - interval '1 second' WHERE id = $1",
          [secondWake],
        );
      },
      until: (l) => (l.ends.get(slow)?.length ?? 0) >= 2 && (l.ends.get(other)?.length ?? 0) >= 1,
    });

    const [firstStart, secondStart] = requireValue(log.starts.get(slow));
    const firstEnd = first(log.ends, slow);
    expect(firstStart).toBeLessThan(firstEnd);
    expect(requireValue(secondStart)).toBeGreaterThanOrEqual(firstEnd);
    expect(log.maxPerSession).toBe(1);
    expect(await wakeStatus(secondWake)).toBe("consumed");
    // The other session was never held by the slow one.
    expect(first(log.starts, other)).toBeLessThan(firstEnd);
    expect(await liveLeases()).toBe(0);
  });

  it("two sessions on one wallet never run together; a session on another wallet runs alongside", async () => {
    const slow = await makeSession();
    const sameWallet = await makeSession();
    const otherWallet = await makeSession();
    const shared = "0x00000000000000000000000000000000000000c3";
    await selectEvmWallet(slow, shared);
    // Same address, other case: one wallet.
    await selectEvmWallet(sameWallet, shared.toUpperCase().replace("0X", "0x"));
    await selectEvmWallet(otherWallet, "0x00000000000000000000000000000000000000d4");
    const wakes = [await seedWake(slow, 30), await seedWake(sameWallet, 20), await seedWake(otherWallet, 10)];

    const log = await runScenario({
      concurrency: 3,
      slowSessions: new Set([slow]),
      walletOf: new Map([[slow, "shared"], [sameWallet, "shared"], [otherWallet, "other"]]),
      until: (l) => [slow, sameWallet, otherWallet].every((s) => (l.ends.get(s)?.length ?? 0) >= 1),
    });

    const slowEnd = first(log.ends, slow);
    expect(first(log.starts, otherWallet)).toBeLessThan(slowEnd);
    expect(first(log.starts, sameWallet)).toBeGreaterThanOrEqual(slowEnd);
    expect(log.maxPerWallet).toBe(1);
    for (const w of wakes) expect(await wakeStatus(w)).toBe("consumed");
    for (const s of [slow, sameWallet, otherWallet]) expect(log.starts.get(s)).toHaveLength(1);
    expect(await liveLeases()).toBe(0);

    process.stdout.write(
      `[S-3 measured] shared wallet: start ms slow=${first(log.starts, slow)} `
      + `same-wallet=${first(log.starts, sameWallet)} other-wallet=${first(log.starts, otherWallet)}; `
      + `slow end=${slowEnd}\n`,
    );
  });
});
