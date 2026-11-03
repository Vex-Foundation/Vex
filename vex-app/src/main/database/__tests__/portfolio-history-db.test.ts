/**
 * The wallet total over time: `getPortfolioHistory` in `../portfolio-db.ts`
 * and its SQL in `../portfolio/snapshot-history.ts`, with no real database.
 *
 * What a mocked client CAN prove, and is pinned here:
 *
 *  1. the scope is resolved by the read's own resolver - an empty scope issues
 *     no SQL, a wallet outside the inventory is refused by name, a session
 *     reads its own wallets - and the resolved set is the ONE array bound into
 *     the statement;
 *  2. each range binds its own interval (`all` binds none), as a parameter,
 *     never as statement text;
 *  3. rows map to points on the read's basis (settled + in transit), oldest
 *     first, with `groupCount` and `sampled` reported, a negative in-transit
 *     clamped, an unreadable row dropped rather than drawn at 0;
 *  4. a database failure is the portfolio domain's redacted error.
 *
 * What it CANNOT prove - the range cut against real timestamps, the
 * completeness rule, the per-wallet in-transit sum and the thinning - runs
 * against a real PostgreSQL in `portfolio-history.int.test.ts` (the
 * `test:studio-postgres` lane).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as ReturnType<typeof vi.fn> & QueryFn,
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  listWallets: vi.fn(),
  getSessionWalletScope: vi.fn(),
  readProjectPortfolioScope: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { connect: mocks.connect, end: mocks.end, query: mocks.query };
  }
  return { Client: MockClient };
});
vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("@vex-lib/wallet.js", () => ({ listWallets: mocks.listWallets }));
vi.mock("../sessions-db.js", () => ({ getSessionWalletScope: mocks.getSessionWalletScope }));
vi.mock("../projects/portfolio-scope.js", () => ({
  readProjectPortfolioScope: mocks.readProjectPortfolioScope,
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getPortfolioHistory } = await import("../portfolio-db.js");
const { PORTFOLIO_HISTORY_MAX_POINTS, portfolioHistoryDtoSchema } = await import(
  "@shared/schemas/portfolio-history.js"
);

const WALLET_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_SOL = "So1aNaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx";
const SESSION = "00000000-0000-4000-8000-000000000003";

function historyRow(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    settled: "100",
    at: new Date("2026-11-01T10:00:00.000Z"),
    partial: false,
    group_count: "1",
    in_transit: 0,
    ...fields,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.listWallets.mockImplementation((family: string) =>
    family === "evm"
      ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }]
      : [{ id: "2", address: WALLET_SOL, label: "", createdAt: "" }],
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

async function readHistory(
  input: Parameters<typeof getPortfolioHistory>[0],
) {
  const result = await getPortfolioHistory(input);
  if (!result.ok) throw new Error(`unexpected error ${result.error.code}`);
  // Every answer must pass the contract main's output schema enforces.
  expect(portfolioHistoryDtoSchema.safeParse(result.data).success).toBe(true);
  return result.data;
}

describe("getPortfolioHistory - the scope", () => {
  it("answers an empty scope with no points and issues no SQL", async () => {
    mocks.listWallets.mockReturnValue([]);

    const data = await readHistory({ range: "7d", wallets: { scope: "global" } });

    expect(data).toEqual({
      scope: "global",
      range: "7d",
      walletCount: 0,
      groupCount: 0,
      sampled: false,
      points: [],
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("refuses a wallet outside the configured inventory before any SQL", async () => {
    const result = await getPortfolioHistory({
      range: "24h",
      wallets: { scope: "global", walletAddress: "0xNOTMINE" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("wallets.invalid_selection");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("binds the whole deduplicated inventory for All wallets", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await readHistory({ range: "7d", wallets: { scope: "global" } });

    const params = mocks.query.mock.calls[0]?.[1] as readonly unknown[];
    expect(params[0]).toEqual([WALLET_A, WALLET_SOL]);
    expect(params[1]).toBe(2);
  });

  it("narrows to ONE inventory wallet, so the completeness rule asks for that wallet alone", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const data = await readHistory({
      range: "7d",
      wallets: { scope: "global", walletAddress: WALLET_SOL },
    });

    const params = mocks.query.mock.calls[0]?.[1] as readonly unknown[];
    expect(params[0]).toEqual([WALLET_SOL]);
    expect(params[1]).toBe(1);
    expect(data.walletCount).toBe(1);
  });

  it("reads a session's own wallets, never the inventory", async () => {
    mocks.getSessionWalletScope.mockResolvedValue({
      ok: true,
      data: { evm: { address: WALLET_A }, solana: null },
    });
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const data = await readHistory({
      range: "30d",
      wallets: { scope: "session", sessionId: SESSION },
    });

    expect(mocks.getSessionWalletScope).toHaveBeenCalledWith(SESSION);
    const params = mocks.query.mock.calls[0]?.[1] as readonly unknown[];
    expect(params[0]).toEqual([WALLET_A]);
    expect(data.scope).toBe("session");
  });
});

describe("getPortfolioHistory - the range", () => {
  it.each([
    ["24h", "24 hours"],
    ["7d", "7 days"],
    ["30d", "30 days"],
    ["all", null],
  ] as const)("binds %s as the interval %s, never as statement text", async (range, interval) => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const data = await readHistory({ range, wallets: { scope: "global" } });

    const [sql, params] = mocks.query.mock.calls[0] as [string, readonly unknown[]];
    expect(params[2]).toBe(interval);
    expect(params[3]).toBe(PORTFOLIO_HISTORY_MAX_POINTS);
    expect(sql).toContain("$3::interval");
    expect(sql).not.toContain("INTERVAL '");
    expect(data.range).toBe(range);
  });

  it("asks only for COMPLETE cycles and scopes in transit to the same set", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await readHistory({ range: "7d", wallets: { scope: "global" } });

    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain("HAVING COUNT(DISTINCT s.wallet_address) = $2");
    expect(sql).toContain("proj_portfolio_snapshot_group_wallets");
    // One allow-list for both: the cycle predicate and the in-transit sum.
    expect(sql.match(/wallet_address = ANY\(\$1::text\[\]\)/g)).toHaveLength(2);
  });
});

describe("getPortfolioHistory - the points", () => {
  it("answers an empty range with no points", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const data = await readHistory({ range: "24h", wallets: { scope: "global" } });

    expect(data.points).toEqual([]);
    expect(data.groupCount).toBe(0);
    expect(data.sampled).toBe(false);
    expect(data.walletCount).toBe(2);
  });

  it("maps one cycle to one point on the settled + in transit basis", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [historyRow({ settled: "50", in_transit: "150" })],
    });

    const data = await readHistory({ range: "24h", wallets: { scope: "global" } });

    expect(data.points).toEqual([
      {
        at: "2026-11-01T10:00:00.000Z",
        totalUsd: 200,
        settledUsd: 50,
        inTransitUsd: 150,
        partial: false,
      },
    ]);
    expect(data.groupCount).toBe(1);
    expect(data.sampled).toBe(false);
  });

  it("keeps many cycles in the order the SQL returns them, partial ones flagged", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        historyRow({ settled: "100", at: new Date("2026-11-01T10:00:00.000Z"), group_count: "3" }),
        historyRow({ settled: "90", at: new Date("2026-11-01T10:05:00.000Z"), group_count: "3", partial: true }),
        historyRow({ settled: "120", at: "2026-11-01T10:10:00.000Z", group_count: "3" }),
      ],
    });

    const data = await readHistory({ range: "24h", wallets: { scope: "global" } });

    expect(data.points.map((point) => point.totalUsd)).toEqual([100, 90, 120]);
    expect(data.points.map((point) => point.partial)).toEqual([false, true, false]);
    expect(data.points.map((point) => point.at)).toEqual([
      "2026-11-01T10:00:00.000Z",
      "2026-11-01T10:05:00.000Z",
      "2026-11-01T10:10:00.000Z",
    ]);
    expect(data.sampled).toBe(false);
  });

  it("says the series was thinned when the range held more cycles than points", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        historyRow({ at: new Date("2026-10-01T00:00:00.000Z"), group_count: "8640" }),
        historyRow({ at: new Date("2026-11-01T00:00:00.000Z"), group_count: "8640" }),
      ],
    });

    const data = await readHistory({ range: "30d", wallets: { scope: "global" } });

    expect(data.groupCount).toBe(8640);
    expect(data.points).toHaveLength(2);
    expect(data.sampled).toBe(true);
  });

  it("clamps a negative in-transit figure to 0 rather than subtracting it", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [historyRow({ settled: "100", in_transit: "-25" })],
    });

    const data = await readHistory({ range: "24h", wallets: { scope: "global" } });

    expect(data.points[0]).toMatchObject({ totalUsd: 100, inTransitUsd: 0 });
  });

  it("drops a row whose time or settled figure cannot be read, never drawing it at 0", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        historyRow({ settled: null, group_count: "3" }),
        historyRow({ at: "not a time", group_count: "3" }),
        historyRow({ settled: "75", group_count: "3" }),
      ],
    });

    const data = await readHistory({ range: "24h", wallets: { scope: "global" } });

    expect(data.points.map((point) => point.settledUsd)).toEqual([75]);
  });

  it("never returns more points than the bound, keeping the NEWEST", async () => {
    const rows = Array.from({ length: PORTFOLIO_HISTORY_MAX_POINTS + 3 }, (_, index) =>
      historyRow({
        settled: String(index),
        at: new Date(Date.UTC(2026, 10, 1, 0, index)),
        group_count: String(PORTFOLIO_HISTORY_MAX_POINTS + 3),
      }),
    );
    mocks.query.mockResolvedValueOnce({ rows });

    const data = await readHistory({ range: "all", wallets: { scope: "global" } });

    expect(data.points).toHaveLength(PORTFOLIO_HISTORY_MAX_POINTS);
    expect(data.points.at(-1)?.settledUsd).toBe(PORTFOLIO_HISTORY_MAX_POINTS + 2);
  });
});

describe("getPortfolioHistory - failures", () => {
  it("is the portfolio domain's redacted error when the query fails", async () => {
    mocks.query.mockRejectedValueOnce(new Error(`relation missing near ${WALLET_A}`));

    const result = await getPortfolioHistory({ range: "7d", wallets: { scope: "global" } });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatchObject({
      code: "internal.unexpected",
      domain: "portfolio",
      redacted: true,
    });
    expect(result.error.message).not.toContain(WALLET_A);
  });

  it("is retryable 'database unavailable' when no connection can be configured", async () => {
    mocks.buildPoolConfig.mockResolvedValue(null);

    const result = await getPortfolioHistory({ range: "7d", wallets: { scope: "global" } });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "internal.unexpected", retryable: true });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("logs counts only, never an address or a figure", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [historyRow({ settled: "12345.67", group_count: "1" })],
    });

    await readHistory({ range: "7d", wallets: { scope: "global" } });

    const lines = mocks.log.info.mock.calls.map((call) => String(call[0]));
    const line = lines.find((text) => text.includes("getPortfolioHistory ok"));
    expect(line).toBeDefined();
    expect(line).not.toContain(WALLET_A);
    expect(line).not.toContain(WALLET_SOL);
    expect(line).not.toContain("12345");
  });
});
