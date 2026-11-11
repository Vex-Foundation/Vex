/**
 * `getPortfolioHistory` against a real PostgreSQL with every migration applied
 * (the `test:studio-postgres` lane; `VEX_TEST_PG=native` runs it on the
 * bundled native Postgres).
 *
 * The unit suite (`portfolio-history-db.test.ts`) pins what main binds and how
 * it maps rows. Everything below is decided by the SQL itself, which a mocked
 * client would only echo back:
 *
 *  1. the range cut, against real `created_at` values: 24h, 7d, 30d and all
 *     each keep exactly the cycles inside them, and an empty history or an
 *     empty range is an empty answer;
 *  2. the completeness rule: a cycle that missed one of the scope's wallets is
 *     not a point for that scope, and IS one for the wallet it did cover;
 *  3. in transit is summed per wallet over exactly the scope, so one wallet's
 *     history never inherits another wallet's pending bridge;
 *  4. the thinning: a range holding more cycles than the bound comes back at
 *     the bound, oldest first, ending on the newest cycle, and says so;
 *  5. the chart ends on the total: the newest point equals the snapshot total
 *     `getPortfolio` reports for the same scope.
 *
 * Fixture rows are written straight into the three snapshot tables with
 * explicit `created_at` values, so the cut is tested against known ages rather
 * than test execution speed. Each test uses its own fresh addresses and deletes
 * them afterwards, so nothing depends on what else the lane's database holds.
 */

import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inventory = vi.hoisted(() => ({
  evm: [] as Array<{ id: string; address: string; label: string; createdAt: string }>,
  solana: [] as Array<{ id: string; address: string; label: string; createdAt: string }>,
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
  configureLogger: (): void => undefined,
  redact: (value: unknown): unknown => value,
  redactArgs: (value: unknown): unknown => value,
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: (): Promise<{
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  } | null> => {
    const url = process.env.VEX_DB_URL;
    if (url === undefined || url === "") return Promise.resolve(null);
    const parsed = new URL(url);
    return Promise.resolve({
      host: parsed.hostname,
      port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  },
}));

// The configured inventory is the one thing this suite supplies: the history
// resolves "All wallets" and a wallet chip against it, exactly as in the app.
vi.mock("@vex-lib/wallet.js", () => ({
  listWallets: (family: "evm" | "solana") => inventory[family],
}));

import { getPortfolio, getPortfolioHistory } from "../portfolio-db.js";
import { closeMainIpcPgPool } from "../main-ipc-pg-pool.js";
import {
  PORTFOLIO_HISTORY_MAX_POINTS,
  portfolioHistoryDtoSchema,
  type PortfolioHistoryInput,
} from "@shared/schemas/portfolio-history.js";

let fixture: Client | null = null;
let evm = "";
let sol = "";

async function db(): Promise<Client> {
  if (fixture !== null) return fixture;
  const url = process.env.VEX_DB_URL;
  if (url === undefined || url === "") throw new Error("VEX_DB_URL is not set");
  fixture = new Client({ connectionString: url });
  await fixture.connect();
  return fixture;
}

interface WalletPart {
  readonly address: string;
  readonly family: "eip155" | "solana";
  readonly settledUsd: number;
  readonly inTransitUsd?: number;
}

/**
 * One snapshot cycle as the publisher writes it: a group record, a per-wallet
 * accounting row per wallet (migration 102) and a snapshot row per wallet, all
 * stamped `minutesAgo` minutes before now.
 */
async function insertCycle(
  minutesAgo: number,
  parts: readonly WalletPart[],
  partial = false,
): Promise<string> {
  const client = await db();
  const groupId = randomUUID();
  const settled = parts.reduce((sum, part) => sum + part.settledUsd, 0);
  const inTransit = parts.reduce((sum, part) => sum + (part.inTransitUsd ?? 0), 0);
  await client.query(
    `INSERT INTO proj_portfolio_snapshot_groups
       (snapshot_group_id, settled_usd, in_transit_usd, unresolved_count, in_flight, created_at)
     VALUES ($1, $2, $3, 0, '[]'::jsonb, NOW() - ($4::int * INTERVAL '1 minute'))`,
    [groupId, settled, inTransit, minutesAgo],
  );
  for (const part of parts) {
    await client.query(
      `INSERT INTO proj_portfolio_snapshot_group_wallets
         (snapshot_group_id, wallet_address, entry_count, unresolved_count, in_transit_usd)
       VALUES ($1, $2, $3, 0, $4)`,
      [groupId, part.address, (part.inTransitUsd ?? 0) > 0 ? 1 : 0, part.inTransitUsd ?? 0],
    );
    await client.query(
      `INSERT INTO proj_portfolio_snapshots
         (wallet_family, wallet_address, snapshot_group_id, total_usd, positions, partial, created_at)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, NOW() - ($6::int * INTERVAL '1 minute'))`,
      [part.family, part.address, groupId, part.settledUsd, partial, minutesAgo],
    );
  }
  return groupId;
}

function both(settledEvm: number, settledSol: number): WalletPart[] {
  return [
    { address: evm, family: "eip155", settledUsd: settledEvm },
    { address: sol, family: "solana", settledUsd: settledSol },
  ];
}

async function history(input: PortfolioHistoryInput) {
  const result = await getPortfolioHistory(input);
  if (!result.ok) throw new Error(`history failed: ${result.error.code}`);
  expect(portfolioHistoryDtoSchema.safeParse(result.data).success).toBe(true);
  return result.data;
}

const ALL = { scope: "global" } as const;

beforeEach(() => {
  // Fresh identities per test: nothing another suite left behind can match.
  const tag = randomUUID().replace(/-/g, "");
  evm = `0x${tag}${tag.slice(0, 8)}`;
  sol = `history${tag}`;
  inventory.evm = [{ id: "evm_1", address: evm, label: "", createdAt: "" }];
  inventory.solana = [{ id: "sol_1", address: sol, label: "", createdAt: "" }];
});

afterEach(async () => {
  const client = await db();
  const addresses = [evm, sol];
  await client.query(
    `DELETE FROM proj_portfolio_snapshot_groups
      WHERE snapshot_group_id IN (
        SELECT snapshot_group_id FROM proj_portfolio_snapshots
         WHERE wallet_address = ANY($1::text[]))`,
    [addresses],
  );
  await client.query(
    "DELETE FROM proj_portfolio_snapshots WHERE wallet_address = ANY($1::text[])",
    [addresses],
  );
});

afterAll(async () => {
  await closeMainIpcPgPool();
  if (fixture !== null) {
    await fixture.end();
    fixture = null;
  }
});

describe("getPortfolioHistory on a real database: the range cut", () => {
  it("answers an empty history with no points for every range", async () => {
    for (const range of ["24h", "7d", "30d", "all"] as const) {
      const data = await history({ range, wallets: ALL });
      expect(data).toMatchObject({ range, walletCount: 2, groupCount: 0, sampled: false, points: [] });
    }
  });

  it("answers one cycle with one point in every range that holds it", async () => {
    await insertCycle(30, both(100, 50));

    for (const range of ["24h", "7d", "30d", "all"] as const) {
      const data = await history({ range, wallets: ALL });
      expect(data.points).toHaveLength(1);
      expect(data.points[0]).toMatchObject({ totalUsd: 150, settledUsd: 150, inTransitUsd: 0, partial: false });
      expect(data.groupCount).toBe(1);
    }
  });

  it("keeps exactly the cycles inside each range, oldest first", async () => {
    const MINUTE = 1;
    const DAY = 24 * 60 * MINUTE;
    await insertCycle(40 * DAY, both(40, 0));
    await insertCycle(10 * DAY, both(10, 0));
    await insertCycle(2 * DAY, both(2, 0));
    await insertCycle(30 * MINUTE, both(1, 0));

    const totals = async (range: PortfolioHistoryInput["range"]) =>
      (await history({ range, wallets: ALL })).points.map((point) => point.totalUsd);

    expect(await totals("24h")).toEqual([1]);
    expect(await totals("7d")).toEqual([2, 1]);
    expect(await totals("30d")).toEqual([10, 2, 1]);
    expect(await totals("all")).toEqual([40, 10, 2, 1]);
  });

  it("answers an empty RANGE when every cycle is older than it", async () => {
    await insertCycle(3 * 24 * 60, both(100, 0));

    const data = await history({ range: "24h", wallets: ALL });
    expect(data.points).toEqual([]);
    expect(data.groupCount).toBe(0);
  });
});

describe("getPortfolioHistory on a real database: the scope", () => {
  it("leaves out a cycle that missed a wallet, and keeps it for the wallet it covered", async () => {
    await insertCycle(60, both(100, 50));
    // Only the EVM wallet: an incomplete cycle for "All wallets".
    await insertCycle(30, [{ address: evm, family: "eip155", settledUsd: 120 }]);

    const all = await history({ range: "24h", wallets: ALL });
    expect(all.points.map((point) => point.totalUsd)).toEqual([150]);

    const evmOnly = await history({ range: "24h", wallets: { scope: "global", walletAddress: evm } });
    expect(evmOnly.walletCount).toBe(1);
    expect(evmOnly.points.map((point) => point.totalUsd)).toEqual([100, 120]);
  });

  it("sums in transit per wallet over exactly the scope", async () => {
    await insertCycle(30, [
      { address: evm, family: "eip155", settledUsd: 50, inTransitUsd: 150 },
      { address: sol, family: "solana", settledUsd: 20, inTransitUsd: 40 },
    ]);

    const all = await history({ range: "24h", wallets: ALL });
    expect(all.points[0]).toMatchObject({ settledUsd: 70, inTransitUsd: 190, totalUsd: 260 });

    // The Solana wallet never inherits the EVM wallet's pending bridge.
    const solOnly = await history({ range: "24h", wallets: { scope: "global", walletAddress: sol } });
    expect(solOnly.points[0]).toMatchObject({ settledUsd: 20, inTransitUsd: 40, totalUsd: 60 });
  });

  it("lists a partial cycle, flagged", async () => {
    await insertCycle(60, both(100, 50));
    await insertCycle(30, both(100, 10), true);

    const data = await history({ range: "24h", wallets: ALL });
    expect(data.points.map((point) => point.partial)).toEqual([false, true]);
  });

  it("refuses a wallet outside the inventory without reading", async () => {
    const result = await getPortfolioHistory({
      range: "7d",
      wallets: { scope: "global", walletAddress: "0xnotaconfiguredwallet" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("wallets.invalid_selection");
  });

  it("ends on the snapshot total the portfolio read reports", async () => {
    await insertCycle(90, both(100, 50));
    await insertCycle(30, [
      { address: evm, family: "eip155", settledUsd: 80, inTransitUsd: 25 },
      { address: sol, family: "solana", settledUsd: 55 },
    ]);

    const data = await history({ range: "7d", wallets: ALL });
    const read = await getPortfolio({ scope: "global" });
    if (!read.ok) throw new Error(`read failed: ${read.error.code}`);

    const last = data.points.at(-1);
    if (last === undefined || read.data.snapshotAt === null) throw new Error("no cycle to compare");
    expect(read.data.snapshotTotalUsd).toBeCloseTo(160, 6);
    expect(last.totalUsd).toBeCloseTo(read.data.snapshotTotalUsd ?? Number.NaN, 6);
    expect(Date.parse(last.at)).toBe(Date.parse(read.data.snapshotAt));
  });
});

describe("getPortfolioHistory on a real database: the bound", () => {
  it("thins a long range to the bound, oldest first, ending on the newest cycle", async () => {
    const client = await db();
    const CYCLES = 1_200;
    // 1,200 one-wallet cycles, thirty minutes apart: 25 days of history.
    await client.query(
      `WITH cycles AS (
         SELECT gen_random_uuid() AS id, n FROM generate_series(0, $2::int - 1) AS n
       )
       INSERT INTO proj_portfolio_snapshots
         (wallet_family, wallet_address, snapshot_group_id, total_usd, positions, created_at)
       SELECT 'eip155', $1, id, 1000 + n, '{}'::jsonb,
              NOW() - (($2::int - 1 - n) * INTERVAL '30 minutes')
         FROM cycles`,
      [evm, CYCLES],
    );
    const wallet = { scope: "global", walletAddress: evm } as const;

    const month = await history({ range: "30d", wallets: wallet });
    expect(month.groupCount).toBe(CYCLES);
    expect(month.sampled).toBe(true);
    // A bucket (span / 499, about 72 minutes) is wider than the cycle spacing,
    // so every one of the 500 buckets holds a cycle and the answer is exactly
    // at the bound.
    expect(month.points).toHaveLength(PORTFOLIO_HISTORY_MAX_POINTS);
    // Each bucket keeps its LATEST cycle: bucket 0 holds cycles 0 to 2
    // (floor(n * 499 / 1199) = 0), so the first point is cycle 2. The last
    // bucket holds the newest cycle alone.
    expect(month.points[0]?.totalUsd).toBe(1002);
    expect(month.points.at(-1)?.totalUsd).toBe(1000 + CYCLES - 1);
    const times = month.points.map((point) => Date.parse(point.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);

    // The last day of the same history fits whole: 48 cycles, not thinned.
    const day = await history({ range: "24h", wallets: wallet });
    expect(day.groupCount).toBe(48);
    expect(day.points).toHaveLength(48);
    expect(day.sampled).toBe(false);
    expect(day.points.at(-1)?.totalUsd).toBe(1000 + CYCLES - 1);
  });
});
