/**
 * POSITION OBSERVATIONS AGAINST REAL POSTGRESQL - the histories that decide
 * whether a closed position can come back from the dead.
 *
 * These are SQL invariants, and no amount of statement-shape assertion proves
 * them: the guards live in `ON CONFLICT ... WHERE` clauses and in a watermark
 * comparison the database performs, so a fake client that records statements
 * cannot tell a correct guard from a misspelled one. Each case here plays a
 * real history against the real schema and reads the real end state.
 *
 * The three histories Codex round 1 found (F6), each of which the per-market
 * guard alone gets WRONG:
 *
 *   1. an EMPTY complete observation at 12:00 writes no market row anywhere;
 *      an 11:00 backfill listing an open position then inserts it and a closed
 *      position has resurrected;
 *   2. a position closed at 10:00, an empty complete observation at 12:00, and
 *      then the same 11:00 backfill: same resurrection;
 *   3. a COMPLETE observation whose coverage lists only market 1 closes market
 *      2, which it never read.
 *
 * And F7, starvation: five scopes that always fail occupied every bounded
 * sweep because the queue was ordered by the last SUCCESS, so a sixth healthy
 * account was never observed at all. The sweep here is driven twice, end to
 * end, with the provider and the vault stubbed and everything else real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { query, queryOne } from "@vex-agent/db/client.js";
import {
  storeLighterPositionObservation,
  type LighterObservedPosition,
  type LighterPositionObservation,
} from "@vex-agent/sync/lighter-position-snapshot.js";

const ACCOUNT = 743799;

const mockGetAccount = vi.fn();
const mockResolveAuth = vi.fn();

vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: () => ({ getAccount: (...args: unknown[]) => mockGetAccount(...args) }),
}));

vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));

const { snapshotLighterPositions, LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP } = await import(
  "@vex-agent/sync/lighter-position-snapshot.js"
);

function position(marketIndex: number, size = "0.4"): LighterObservedPosition {
  return {
    marketIndex,
    marketSymbol: `M${marketIndex}`,
    size,
    entryPrice: "2500.5",
    unrealizedPnl: null,
    realizedPnl: null,
    liquidationPrice: null,
  };
}

/** One observation at a wall-clock hour on 2026-09-07, for the one account. */
function observation(
  observationId: string,
  hour: number,
  overrides: Partial<LighterPositionObservation> = {},
): LighterPositionObservation {
  return {
    environment: "core",
    accountIndex: ACCOUNT,
    observationId,
    observedAt: `2026-09-07T${String(hour).padStart(2, "0")}:00:00.000Z`,
    coverage: "all",
    complete: true,
    positions: [],
    ...overrides,
  };
}

/** The market state as a reader would see it: which markets are open, and since when. */
async function marketState(): Promise<Array<{ market: number; open: boolean; observedAt: string }>> {
  const rows = await query<{ market_index: number; open: boolean; observed_at: Date }>(
    `SELECT market_index, open, observed_at
       FROM lighter_position_market_state
      WHERE environment = 'core' AND account_index = $1
      ORDER BY market_index`,
    [ACCOUNT],
  );
  return rows.map((row) => ({
    market: Number(row.market_index),
    open: row.open,
    observedAt: row.observed_at.toISOString(),
  }));
}

async function scopeWatermark(): Promise<string | null> {
  const row = await queryOne<{ complete_watermark_at: Date | null }>(
    `SELECT complete_watermark_at FROM lighter_position_sweep_state
      WHERE environment = 'core' AND account_index = $1`,
    [ACCOUNT],
  );
  const at = row?.complete_watermark_at ?? null;
  return at === null ? null : at.toISOString();
}

beforeEach(async () => {
  // This lane's global setup creates the database; refuse any other target.
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name")).toEqual({ name: "vex_test" });
  await query("TRUNCATE lighter_position_observations, lighter_position_market_state, lighter_position_sweep_state");
  await query("DELETE FROM lighter_onboarding_workflows");
  await query("DELETE FROM lighter_integration_settings");
  vi.clearAllMocks();
});

describe("migration 152's position tables", () => {
  it("keeps a closed market's row instead of deleting it, and rejects a position on a closed row", async () => {
    // The CHECK is the structural half of the closure marker: a closed row can
    // never carry a position, so "closed" is never a row that merely forgot to
    // say what it holds.
    await storeLighterPositionObservation(observation("obs-open", 10, { positions: [position(1)] }));
    await storeLighterPositionObservation(observation("obs-close", 11));
    expect(await marketState()).toEqual([
      { market: 1, open: false, observedAt: "2026-09-07T11:00:00.000Z" },
    ]);

    await expect(query(
      `UPDATE lighter_position_market_state SET position = '{}'::jsonb
        WHERE environment = 'core' AND account_index = $1 AND market_index = 1`,
      [ACCOUNT],
    )).rejects.toThrow(/lighter_position_market_state_open_has_position/);
  });
});

describe("the histories that could resurrect a closed position", () => {
  it("1. an EMPTY complete observation blocks an older backfill that lists a position", async () => {
    // Nothing has ever been stored for market 1, so there is no market row to
    // defend it: the scope watermark is the only marker in existence.
    await storeLighterPositionObservation(observation("obs-empty", 12));
    expect(await scopeWatermark()).toBe("2026-09-07T12:00:00.000Z");

    const late = await storeLighterPositionObservation(
      observation("obs-late", 11, { positions: [position(1)] }),
    );

    expect(late).toEqual({ marketsUpdated: 0, ignoredAsStale: true, replayed: false });
    expect(await marketState()).toEqual([]);
  });

  it("2. a closed position stays closed through an empty observation and an older backfill", async () => {
    await storeLighterPositionObservation(observation("obs-open", 9, { positions: [position(1)] }));
    await storeLighterPositionObservation(observation("obs-close", 10));
    await storeLighterPositionObservation(observation("obs-empty", 12));

    const late = await storeLighterPositionObservation(
      observation("obs-late", 11, { positions: [position(1)] }),
    );

    expect(late.ignoredAsStale).toBe(true);
    expect(await marketState()).toEqual([
      { market: 1, open: false, observedAt: "2026-09-07T10:00:00.000Z" },
    ]);
  });

  it("3. a complete observation closes only the markets INSIDE its own coverage", async () => {
    await storeLighterPositionObservation(
      observation("obs-both", 10, { positions: [position(1), position(2)] }),
    );

    // Complete, but it read market 1 alone. It says nothing whatsoever about
    // market 2, and closing it would be inventing a fact.
    await storeLighterPositionObservation(
      observation("obs-partial", 11, { coverage: [1], positions: [] }),
    );

    expect(await marketState()).toEqual([
      { market: 1, open: false, observedAt: "2026-09-07T11:00:00.000Z" },
      { market: 2, open: true, observedAt: "2026-09-07T10:00:00.000Z" },
    ]);
    // A partial coverage never earns the scope watermark either: it would then
    // silence readings of the markets it never looked at.
    expect(await scopeWatermark()).toBe("2026-09-07T10:00:00.000Z");
  });

  it("writes a closure MARKER for a covered market that has never had a row", async () => {
    // Market 5 was read by a partial-coverage observation and had no position.
    // Without a marker of its own the next older backfill would open it, and
    // no scope watermark moved to stop that.
    await storeLighterPositionObservation(
      observation("obs-partial", 11, { coverage: [5], positions: [] }),
    );
    expect(await marketState()).toEqual([
      { market: 5, open: false, observedAt: "2026-09-07T11:00:00.000Z" },
    ]);

    const late = await storeLighterPositionObservation(
      observation("obs-older", 10, { coverage: [5], positions: [position(5)] }),
    );

    expect(late.marketsUpdated).toBe(0);
    expect(await marketState()).toEqual([
      { market: 5, open: false, observedAt: "2026-09-07T11:00:00.000Z" },
    ]);
  });
});

describe("the histories that must still change the state", () => {
  it("REOPENS a market a newer observation reports open again", async () => {
    await storeLighterPositionObservation(observation("obs-open", 9, { positions: [position(1)] }));
    await storeLighterPositionObservation(observation("obs-close", 10));

    await storeLighterPositionObservation(
      observation("obs-reopen", 11, { positions: [position(1, "1.25")] }),
    );

    expect(await marketState()).toEqual([
      { market: 1, open: true, observedAt: "2026-09-07T11:00:00.000Z" },
    ]);
    const row = await queryOne<{ position: { size: string } }>(
      `SELECT position FROM lighter_position_market_state
        WHERE environment = 'core' AND account_index = $1 AND market_index = 1`,
      [ACCOUNT],
    );
    expect(row?.position.size).toBe("1.25");
  });

  it("never infers a closure from an INCOMPLETE observation, however new it is", async () => {
    await storeLighterPositionObservation(
      observation("obs-open", 10, { positions: [position(1), position(2)] }),
    );

    const incomplete = await storeLighterPositionObservation(
      observation("obs-truncated", 12, { coverage: [1], complete: false, positions: [position(1)] }),
    );

    expect(incomplete.marketsUpdated).toBe(1);
    expect(await marketState()).toEqual([
      { market: 1, open: true, observedAt: "2026-09-07T12:00:00.000Z" },
      { market: 2, open: true, observedAt: "2026-09-07T10:00:00.000Z" },
    ]);
    // An incomplete reading cannot claim the scope either.
    expect(await scopeWatermark()).toBe("2026-09-07T10:00:00.000Z");
  });

  it("converges on the NEWEST complete observation whatever order they arrive in", async () => {
    // Newest first, then two older ones. The end state is the newest reading's
    // state, and neither latecomer moves it.
    await storeLighterPositionObservation(observation("obs-12", 12, { positions: [position(3)] }));
    const at11 = await storeLighterPositionObservation(
      observation("obs-11", 11, { positions: [position(1)] }),
    );
    const at10 = await storeLighterPositionObservation(
      observation("obs-10", 10, { positions: [position(1), position(2)] }),
    );

    expect(at11.ignoredAsStale).toBe(true);
    expect(at10.ignoredAsStale).toBe(true);
    expect(await marketState()).toEqual([
      { market: 3, open: true, observedAt: "2026-09-07T12:00:00.000Z" },
    ]);
    // All three are RETAINED as records; only their effect was refused.
    const stored = await query<{ observation_id: string }>(
      `SELECT observation_id FROM lighter_position_observations
        WHERE environment = 'core' AND account_index = $1 ORDER BY observation_id`,
      [ACCOUNT],
    );
    expect(stored.map((row) => row.observation_id)).toEqual(["obs-10", "obs-11", "obs-12"]);
  });

  it("treats a REPLAYED observation as a no-op rather than reapplying it", async () => {
    const first = await storeLighterPositionObservation(
      observation("obs-1", 10, { positions: [position(1)] }),
    );
    const replay = await storeLighterPositionObservation(
      observation("obs-1", 10, { positions: [position(1)] }),
    );

    expect(first).toEqual({ marketsUpdated: 1, ignoredAsStale: false, replayed: false });
    expect(replay).toEqual({ marketsUpdated: 0, ignoredAsStale: false, replayed: true });
    expect(await marketState()).toEqual([
      { market: 1, open: true, observedAt: "2026-09-07T10:00:00.000Z" },
    ]);
  });

  it("assigns received_at itself rather than trusting the observation to date its own arrival", async () => {
    await storeLighterPositionObservation(observation("obs-1", 10));
    const row = await queryOne<{ received_at: Date; observed_at: Date }>(
      `SELECT received_at, observed_at FROM lighter_position_observations
        WHERE environment = 'core' AND account_index = $1`,
      [ACCOUNT],
    );
    expect(row?.received_at.getTime()).toBeGreaterThan(row?.observed_at.getTime() ?? 0);
  });
});

describe("fair scheduling across a bounded sweep", () => {
  /** Six onboarded scopes on one enabled integration each. */
  async function onboardScopes(count: number): Promise<number[]> {
    const accounts: number[] = [];
    for (let index = 0; index < count; index++) {
      const wallet = `0x${String(index + 1).repeat(40).slice(0, 40)}`;
      const accountIndex = 800000 + index;
      await query(
        `INSERT INTO lighter_integration_settings (environment, wallet_address, enabled, enabled_at)
         VALUES ('core', $1, TRUE, NOW())`,
        [wallet],
      );
      await query(
        `INSERT INTO lighter_onboarding_workflows
           (environment, wallet_address, workflow_state, resolved_account_index)
         VALUES ('core', $1, 'ready_to_trade', $2)`,
        [wallet, accountIndex],
      );
      accounts.push(accountIndex);
    }
    return accounts;
  }

  async function attemptedAccounts(): Promise<Array<{ account: number; result: string }>> {
    const rows = await query<{ account_index: string; last_attempt_result: string }>(
      `SELECT account_index, last_attempt_result FROM lighter_position_sweep_state
        ORDER BY account_index`,
    );
    return rows.map((row) => ({ account: Number(row.account_index), result: row.last_attempt_result }));
  }

  it("reaches the sixth healthy scope on the second sweep, though five always fail", async () => {
    const accounts = await onboardScopes(6);
    const healthy = accounts[5];
    expect(LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP).toBe(5);

    // Five scopes with no credential in the vault: they never produce an
    // observation, so a queue ordered by the last SUCCESS would hand them
    // every slot of every sweep forever.
    mockResolveAuth.mockImplementation(async (_environment: string, accountIndex: number) =>
      accountIndex === healthy ? { accountIndex, token: "read-only" } : null,
    );
    mockGetAccount.mockResolvedValue({
      code: 200,
      accounts: [{ account_index: healthy, positions: [] }],
    });

    const first = await snapshotLighterPositions();
    expect(first.examined).toBe(5);
    expect(first.awaitingVault).toBe(5);
    expect(first.observed).toBe(0);
    expect(await attemptedAccounts()).toEqual(
      accounts.slice(0, 5).map((account) => ({ account, result: "no_credential" })),
    );

    const second = await snapshotLighterPositions();

    // THE POINT: the five failures moved to the tail on their attempt, so the
    // sixth is reached by the very next sweep.
    expect(second.observed).toBe(1);
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    const results = await attemptedAccounts();
    expect(results.find((row) => row.account === healthy)).toEqual({
      account: healthy,
      result: "observed",
    });
    expect(results).toHaveLength(6);
  });

  it("moves a scope the PROVIDER refused to the tail as surely as a successful one", async () => {
    const accounts = await onboardScopes(6);
    mockResolveAuth.mockImplementation(async (_environment: string, accountIndex: number) => ({
      accountIndex,
      token: "read-only",
    }));
    mockGetAccount.mockImplementation(async (_environment: string, request: { value: number }) => {
      if (request.value !== accounts[5]) throw new Error("provider unavailable");
      return { code: 200, accounts: [{ account_index: accounts[5], positions: [] }] };
    });

    const first = await snapshotLighterPositions();
    expect(first.errors).toBe(5);
    const second = await snapshotLighterPositions();

    expect(second.observed).toBe(1);
    const results = await attemptedAccounts();
    expect(results.filter((row) => row.result === "provider_unavailable")).toHaveLength(5);
    expect(results.find((row) => row.account === accounts[5])?.result).toBe("observed");
  });
});
