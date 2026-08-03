/**
 * openMissionResult — race-free per-wallet seq_no minting under concurrency.
 *
 * `pg_advisory_xact_lock` is a real Postgres guarantee: a transaction that
 * acquires the lock holds it until COMMIT/ROLLBACK; a second transaction
 * requesting the SAME lock key blocks until the first releases it. This
 * test fakes that exact contract (serialize same-key transactions in
 * acquisition order; different-key transactions run independently) against
 * an in-memory "table", then drives N concurrent `openMissionResult` calls
 * for the SAME wallet and asserts every minted seq_no is unique and the set
 * is exactly {1..N} — the invariant a bare `SELECT COUNT(*)+1` cannot
 * guarantee (two readers can see the same count before either inserts).
 *
 * This proves the repo's lock-then-mint-then-insert sequence is race-free
 * GIVEN Postgres's own advisory-lock guarantee; it does not replace a
 * real-Postgres integration test (no local Postgres is available in this
 * environment — see the builder report for this named gap).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client, type PoolClient } from "pg";

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/mission-results.js");
const client = await import("@vex-agent/db/client.js");

/** A promise plus its resolver, so the resolver keeps a callable type. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface FakeRow {
  walletAddress: string;
  missionRunId: string;
  seqNo: number;
}

describe("openMissionResult concurrency", () => {
  let table: FakeRow[];
  /** Per-lock-key promise chain — simulates pg_advisory_xact_lock queuing. */
  let lockChains: Map<string, Promise<void>>;

  beforeEach(() => {
    table = [];
    lockChains = new Map();

    vi.mocked(client.withTransaction).mockImplementation(
      async (fn) => {
        /** Every lock this transaction is holding, released together at COMMIT. */
        const releases: Array<() => void> = [];
        // A real `pg.Client` (never connected) with `query` replaced:
        // `Object.assign` keeps the `PoolClient` type the callback demands
        // without a cast, while this suite owns every statement it sees.
        const fakeClient: PoolClient = Object.assign(new Client(), {
          release: () => {},
          query: async (sql: string, params?: unknown[]) => {
            if (/pg_advisory_xact_lock/.test(sql)) {
              const key = params![0] as string;
              const prior = lockChains.get(key) ?? Promise.resolve();
              const mine = deferred();
              releases.push(mine.release);
              lockChains.set(key, prior.then(() => mine.promise));
              await prior; // block until the previous holder of THIS key releases
            }
            return { rows: [] };
          },
        });
        try {
          return await fn(fakeClient);
        } finally {
          // Lock releases at COMMIT — i.e. once fn (the transaction body)
          // has resolved, matching pg_advisory_xact_lock's transaction scope.
          for (const release of releases) release();
        }
      },
    );

    vi.mocked(client.queryOneWith).mockImplementation(
      async (_c: unknown, _sql: string, params?: unknown[]) => {
        const wallet = (params![0] as string).toLowerCase();
        const existing = table.filter((r) => r.walletAddress === wallet);
        const next = existing.length === 0 ? 1 : Math.max(...existing.map((r) => r.seqNo)) + 1;
        return { next_seq: String(next) };
      },
    );

    vi.mocked(client.executeWith).mockImplementation(
      async (_c: unknown, _sql: string, params?: unknown[]) => {
        table.push({
          walletAddress: (params![4] as string).toLowerCase(),
          missionRunId: params![2] as string,
          seqNo: params![6] as number,
        });
        return 1;
      },
    );
  });

  it("mints unique, exactly-{1..N} seq_no for N concurrent opens of the SAME wallet", async () => {
    const N = 8;
    const inputs = Array.from({ length: N }, (_, i) => ({
      id: `res-${i}`,
      missionId: "mission-1",
      missionRunId: `run-${i}`,
      sessionId: "session-1",
      walletAddress: "0xSameWallet",
      chainId: 4663,
      goalSnippet: null,
      bankrollStartEth: 0.01,
      ethPriceUsdStart: 3000,
    }));

    await Promise.all(inputs.map((input) => repo.openMissionResult(input)));

    const seqNos = table.map((r) => r.seqNo).sort((a, b) => a - b);
    expect(seqNos).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(seqNos).size).toBe(N); // no duplicate seq_no
  });

  it("numbers two different wallets independently (no cross-wallet interference)", async () => {
    const walletA = Array.from({ length: 3 }, (_, i) => ({
      id: `a-${i}`, missionId: "m", missionRunId: `runA-${i}`, sessionId: "s",
      walletAddress: "0xWalletA", chainId: 4663, goalSnippet: null,
      bankrollStartEth: 0.01, ethPriceUsdStart: 3000,
    }));
    const walletB = Array.from({ length: 3 }, (_, i) => ({
      id: `b-${i}`, missionId: "m", missionRunId: `runB-${i}`, sessionId: "s",
      walletAddress: "0xWalletB", chainId: 4663, goalSnippet: null,
      bankrollStartEth: 0.01, ethPriceUsdStart: 3000,
    }));

    await Promise.all([...walletA, ...walletB].map((input) => repo.openMissionResult(input)));

    const seqA = table.filter((r) => r.walletAddress === "0xwalleta").map((r) => r.seqNo).sort();
    const seqB = table.filter((r) => r.walletAddress === "0xwalletb").map((r) => r.seqNo).sort();
    expect(seqA).toEqual([1, 2, 3]);
    expect(seqB).toEqual([1, 2, 3]);
  });
});
