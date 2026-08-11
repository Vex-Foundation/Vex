/**
 * Balances valuation reads - the two queries the mission start baseline is
 * measured with. Mocks the db client so the STATEMENT ORDER, the SQL text and
 * the bound params are asserted without a live Postgres, the same way
 * `balances.test.ts` does.
 *
 * The load-bearing behaviors pinned here:
 *   - each read runs inside a transaction that issues `SET LOCAL
 *     statement_timeout` with the CALLER'S bound BEFORE the SELECT, so Postgres
 *     cancels a slow query itself. A caller-side `Promise.race` abandons the
 *     wait but leaves the query running on a pooled connection, which is a
 *     resource leak the server-side bound is what actually closes;
 *   - an EMPTY address set never reaches the database, never opens a
 *     transaction, and never falls back to a global read (the `getTotalUsd`
 *     guard, repeated for the same reason);
 *   - `balance_raw` is summed as NUMERIC and read back as TEXT, so a wei-scale
 *     integer survives with every digit intact;
 *   - a raw amount whose decimals are unknown or contradictory returns a NULL
 *     PAIR rather than a rescaled guess;
 *   - asset identity is family aware: EVM token addresses compare
 *     case-insensitively, Solana mints compare exactly.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";

interface Statement { readonly sql: string; readonly params: unknown[] | undefined }

let statements: Statement[];
let nextRow: Record<string, unknown> | null;
let clientQueryImpl: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null;
let mockWithTransaction: Mock<(fn: (client: unknown) => Promise<unknown>) => Promise<unknown>>;

const fakeClient = {
  query: async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (clientQueryImpl !== null) return clientQueryImpl(sql, params);
    if (sql.includes("SELECT")) return { rows: nextRow === null ? [] : [nextRow] };
    return { rows: [] };
  },
};

function resetMocks() {
  statements = [];
  nextRow = null;
  clientQueryImpl = null;
  mockWithTransaction = vi
    .fn<(fn: (client: unknown) => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation(async (fn) => fn(fakeClient));
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  execute: vi.fn().mockResolvedValue(1),
  getPool: vi.fn(),
  withTransaction: (fn: (client: unknown) => Promise<unknown>) => mockWithTransaction(fn),
  // Delegates to the executor, exactly as the real helper does, so every
  // statement lands in ONE ordered list.
  queryOneWith: async (exec: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, sql: string, params?: unknown[]) => {
    const result = await exec.query(sql, params);
    return result.rows[0] ?? null;
  },
}));

const { getPortfolioValuation, getAssetHolding, DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS } =
  await import("@vex-agent/db/repos/balances.js");

/** The statements a read issued, minus BEGIN/COMMIT the helper owns. */
const selectStatement = (): Statement => {
  const found = statements.find((s) => s.sql.includes("SELECT"));
  if (found === undefined) throw new Error("no SELECT was issued");
  return found;
};

beforeEach(() => {
  resetMocks();
});

describe("server-side statement bound", () => {
  it("issues SET LOCAL statement_timeout with the caller's bound BEFORE the SELECT", async () => {
    nextRow = { total_usd: "0", priced_rows: "0", unpriced_rows: "0", oldest_synced_at: null, newest_synced_at: null };

    await getPortfolioValuation(["0xA"], 1_200);

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(statements[0]?.sql).toBe("SET LOCAL statement_timeout = 1200");
    expect(statements[0]?.params).toBeUndefined();
    expect(statements[1]?.sql).toContain("SELECT");
  });

  it("bounds getAssetHolding with the caller's timeout too", async () => {
    nextRow = { held_raw: null, held_usd: "0", min_decimals: null, max_decimals: null, row_count: "0", has_unpriced: null };

    await getAssetHolding(["0xA"], 8453, "0xToken", 900);

    expect(statements[0]?.sql).toBe("SET LOCAL statement_timeout = 900");
    expect(statements[1]?.sql).toContain("SELECT");
  });

  it("falls back to the documented default bound", async () => {
    nextRow = { total_usd: "0", priced_rows: "1", unpriced_rows: "0", oldest_synced_at: null, newest_synced_at: null };

    await getPortfolioValuation(["0xA"]);

    expect(DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS).toBe(3_500);
    expect(statements[0]?.sql).toBe(
      `SET LOCAL statement_timeout = ${DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS}`,
    );
  });

  it("clamps an out-of-range bound instead of interpolating it verbatim", async () => {
    nextRow = { total_usd: "0", priced_rows: "1", unpriced_rows: "0", oldest_synced_at: null, newest_synced_at: null };

    await getPortfolioValuation(["0xA"], Number.NaN);
    expect(statements[0]?.sql).toBe(
      `SET LOCAL statement_timeout = ${DEFAULT_VALUATION_STATEMENT_TIMEOUT_MS}`,
    );

    resetMocks();
    nextRow = { total_usd: "0", priced_rows: "1", unpriced_rows: "0", oldest_synced_at: null, newest_synced_at: null };
    await getPortfolioValuation(["0xA"], 10 * 60_000);
    expect(statements[0]?.sql).toBe("SET LOCAL statement_timeout = 60000");
  });

  it("propagates a server-side cancellation to the caller, which names it", async () => {
    // Postgres cancels the statement itself (SQLSTATE 57014). The repo does not
    // swallow it: `buildMissionBaseline` turns it into `valuation_failed`.
    clientQueryImpl = async (sql: string) => {
      if (sql.includes("SELECT")) throw new Error("canceling statement due to statement timeout");
      return { rows: [] };
    };

    await expect(getPortfolioValuation(["0xA"], 1_200)).rejects.toThrow(
      "canceling statement due to statement timeout",
    );
  });
});

describe("getPortfolioValuation", () => {
  it("returns an empty valuation for an empty address set without querying", async () => {
    const valuation = await getPortfolioValuation([]);

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
    expect(valuation).toEqual({
      totalUsdEstimate: 0,
      pricedRowCount: 0,
      unpricedRowCount: 0,
      oldestSyncedAt: null,
      newestSyncedAt: null,
    });
  });

  it("binds the address set and maps the aggregate row", async () => {
    nextRow = ({
      total_usd: "32.10",
      priced_rows: "2",
      unpriced_rows: "1",
      oldest_synced_at: new Date("2026-08-10T13:00:00.000Z"),
      newest_synced_at: "2026-08-10T13:12:04.000Z",
    });

    const valuation = await getPortfolioValuation(["0xA", "0xB"]);

    const { sql, params } = selectStatement();
    expect(sql).toContain("FROM proj_balances");
    expect(sql).toContain("wallet_address = ANY($1::text[])");
    expect(params).toEqual([["0xA", "0xB"]]);
    expect(valuation).toEqual({
      totalUsdEstimate: 32.1,
      pricedRowCount: 2,
      unpricedRowCount: 1,
      oldestSyncedAt: "2026-08-10T13:00:00.000Z",
      newestSyncedAt: "2026-08-10T13:12:04.000Z",
    });
  });

  it("reads a missing row as zero rows rather than throwing", async () => {
    nextRow = null;

    const valuation = await getPortfolioValuation(["0xA"]);

    expect(valuation.totalUsdEstimate).toBe(0);
    expect(valuation.pricedRowCount).toBe(0);
    expect(valuation.unpricedRowCount).toBe(0);
    expect(valuation.newestSyncedAt).toBeNull();
  });
});

describe("getAssetHolding", () => {
  it("returns an empty holding for an empty address set without querying", async () => {
    const holding = await getAssetHolding([], 8453, "0xToken");

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
    expect(holding).toEqual({
      heldAmountRaw: null,
      heldDecimals: null,
      heldUsdEstimate: null,
      rowCount: 0,
      hasUnpricedRow: false,
    });
  });

  it("sums balance_raw as NUMERIC and returns every digit of a 30-digit amount", async () => {
    nextRow = ({
      held_raw: "123456789012345678901234567890",
      held_usd: "12.5",
      min_decimals: 18,
      max_decimals: 18,
      row_count: "2",
      has_unpriced: false,
    });

    const holding = await getAssetHolding(["0xA"], 8453, "0xToken");

    expect(holding.heldAmountRaw).toBe("123456789012345678901234567890");
    expect(holding.heldDecimals).toBe(18);
    expect(holding.heldUsdEstimate).toBe(12.5);
    expect(holding.rowCount).toBe(2);
    expect(holding.hasUnpricedRow).toBe(false);
  });

  it("compares an EVM token address case-insensitively and filters the evm family", async () => {
    nextRow = ({
      held_raw: "1",
      held_usd: "0",
      min_decimals: 18,
      max_decimals: 18,
      row_count: "1",
      has_unpriced: false,
    });

    await getAssetHolding(["0xA"], 8453, "0xAbCd");

    const { sql, params } = selectStatement();
    expect(sql).toContain("LOWER(token_address) = LOWER($4)");
    expect(sql).not.toContain("AND token_address = $4");
    expect(params).toEqual([["0xA"], "eip155", 8453, "0xAbCd"]);
  });

  it("compares a Solana mint EXACTLY and filters the solana family", async () => {
    nextRow = ({
      held_raw: "1",
      held_usd: "0",
      min_decimals: 9,
      max_decimals: 9,
      row_count: "1",
      has_unpriced: false,
    });

    const mint = "So11111111111111111111111111111111111111112";
    await getAssetHolding(["SoLwAlLeT"], SOLANA_SYNTHETIC_CHAIN_ID, mint);

    const { sql, params } = selectStatement();
    expect(sql).toContain("AND token_address = $4");
    expect(sql).not.toContain("LOWER(token_address)");
    expect(params).toEqual([["SoLwAlLeT"], "solana", SOLANA_SYNTHETIC_CHAIN_ID, mint]);
  });

  it("nulls the amount/decimals PAIR when the projection's decimals disagree", async () => {
    nextRow = ({
      held_raw: "1000",
      held_usd: "4",
      min_decimals: 6,
      max_decimals: 18,
      row_count: "2",
      has_unpriced: false,
    });

    const holding = await getAssetHolding(["0xA"], 8453, "0xToken");

    expect(holding.heldAmountRaw).toBeNull();
    expect(holding.heldDecimals).toBeNull();
    expect(holding.heldUsdEstimate).toBe(4);
    expect(holding.rowCount).toBe(2);
  });

  it("nulls the pair when the projection recorded no decimals at all", async () => {
    nextRow = ({
      held_raw: "1000",
      held_usd: "0",
      min_decimals: null,
      max_decimals: null,
      row_count: "1",
      has_unpriced: true,
    });

    const holding = await getAssetHolding(["0xA"], 8453, "0xToken");

    expect(holding.heldAmountRaw).toBeNull();
    expect(holding.heldDecimals).toBeNull();
    expect(holding.hasUnpricedRow).toBe(true);
  });

  it("reads no matching rows as an empty holding", async () => {
    nextRow = ({
      held_raw: null,
      held_usd: "0",
      min_decimals: null,
      max_decimals: null,
      row_count: "0",
      has_unpriced: null,
    });

    const holding = await getAssetHolding(["0xA"], 8453, "0xToken");

    expect(holding).toEqual({
      heldAmountRaw: null,
      heldDecimals: null,
      heldUsdEstimate: null,
      rowCount: 0,
      hasUnpricedRow: false,
    });
  });

  it("excludes malformed raw balances from the NUMERIC sum", async () => {
    nextRow = ({
      held_raw: "5",
      held_usd: "0",
      min_decimals: 18,
      max_decimals: 18,
      row_count: "1",
      has_unpriced: false,
    });

    await getAssetHolding(["0xA"], 8453, "0xToken");

    const { sql } = selectStatement();
    expect(sql).toContain("balance_raw ~ '^[0-9]+$'");
  });
});
