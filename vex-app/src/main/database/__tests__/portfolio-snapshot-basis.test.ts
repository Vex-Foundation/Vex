/**
 * The PnL BASIS of a portfolio read: `main/database/portfolio/snapshot-basis.ts`,
 * exercised through the PUBLIC `getPortfolio` entry point with no real DB.
 *
 * Split out of `portfolio-db.test.ts` (2026-09-04) when that file crossed the
 * repository's 750-line gate at 1,422 lines. The scenarios did not change
 * owner: they still drive `getPortfolio`, because the basis is only ever
 * observable through it. What they no longer do is sit beside 900 lines of
 * token-aggregation and address-resolution coverage that shares none of their
 * fixtures.
 *
 * What is pinned here:
 *
 *  1. the basis is SETTLED + IN TRANSIT, on both sides of the PnL, so a
 *     snapshot taken mid-bridge does not report a loss the user did not take;
 *  2. in-transit money is summed PER WALLET over exactly the resolved address
 *     set - a scope holding wallet A never inherits wallet B's pending bridge;
 *  3. the bounded display list is never the source of a total, and the
 *     total/shown/truncated contract says so out loud;
 *  4. a group written before migration 102 reads as in transit 0, which is
 *     exactly what the pre-migration reader produced;
 *  5. the durable ledger is PARSED, not trusted: a malformed entry is dropped
 *     and reported, an unknown kind maps to the typed fallback and stays
 *     listed, a negative estimate is refused;
 *  6. the closed kind vocabulary matches the engine's, which this suite can
 *     see because it runs in the main process and both trees are importable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IN_FLIGHT_KINDS } from "@vex-agent/sync/balance-sync/publication-gate.js";
import {
  SNAPSHOT_IN_FLIGHT_KINDS,
  snapshotInFlightEntryDtoSchema,
} from "@shared/schemas/portfolio.js";

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

const { getPortfolio } = await import("../portfolio-db.js");

const WALLET_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";

/** One in-flight bridge leg, in the exact shape the publisher persists. */
const IN_FLIGHT_BRIDGE = {
  kind: "agent_activity_pending",
  walletAddress: WALLET_A,
  ref: "132",
  detail: "bridge_fill_expected",
  standing: "in_transit" as const,
  ageSeconds: 600,
  amountHuman: "150.0",
  symbol: "USDC",
  usdEstimate: 150,
};

/**
 * One row of the snapshot query, with the defaults a group written before
 * migration 102 produces: no per-wallet attribution at all.
 */
function snapshotRow(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    snapshot_group_id: "g1",
    at: "2026-05-21T10:00:00.000Z",
    in_transit: 0,
    unresolved_count: 0,
    in_flight_total_count: 0,
    in_flight: null,
    ...fields,
  };
}

/**
 * Script the four queries `getPortfolio` issues (live total, token lines,
 * per-chain breakdown, snapshot) in order.
 */
function scriptSnapshot(
  latest: Record<string, unknown> | null,
  previous?: Record<string, unknown> | null,
): void {
  const rows = [latest, previous ?? null].filter(
    (row): row is Record<string, unknown> => row != null,
  );
  mocks.query
    .mockResolvedValueOnce({ rows: [{ live: "0" }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows });
}

/** The snapshot query is the fourth. */
const snapshotCall = () => mocks.query.mock.calls[3];

async function readGlobalPortfolio() {
  const result = await getPortfolio({ scope: "global" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.data;
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
    family === "evm" ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }] : [],
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. The basis is settled + in transit ─────────────────────────────────

describe("the PnL basis", () => {
  it("computes PnL as latest.total - previous.total over two complete cycles", async () => {
    scriptSnapshot(
      snapshotRow({ total: "100" }),
      snapshotRow({ snapshot_group_id: "g0", total: "80", at: "2026-05-20T10:00:00.000Z" }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotTotalUsd).toBeCloseTo(100, 4);
    expect(data.pnlVsPrev).toBeCloseTo(20, 4);
    // The snapshot query asks for the latest TWO groups and no longer sums
    // per-wallet pnl_vs_prev.
    const sql = String(snapshotCall()?.[0] ?? "");
    expect(sql).toContain("LIMIT 2");
    expect(sql).not.toContain("pnl_vs_prev");
  });

  it("leaves PnL null when only one complete cycle exists", async () => {
    scriptSnapshot(snapshotRow({ total: "100" }));

    const data = await readGlobalPortfolio();

    expect(data.snapshotTotalUsd).toBeCloseTo(100, 4);
    expect(data.pnlVsPrev).toBeNull();
  });

  it("uses SETTLED + IN TRANSIT on both sides of the PnL", async () => {
    scriptSnapshot(
      snapshotRow({
        total: "50",
        in_transit: 150,
        in_flight_total_count: 1,
        in_flight: JSON.stringify([IN_FLIGHT_BRIDGE]),
      }),
      snapshotRow({
        snapshot_group_id: "g0",
        total: "180",
        at: "2026-05-20T10:00:00.000Z",
        in_transit: 20,
        in_flight: "[]",
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotTotalUsd).toBeCloseTo(200, 4);
    // 200 vs 200: the previous cycle held 180 settled plus 20 on its way.
    expect(data.pnlVsPrev).toBeCloseTo(0, 4);
  });

  it("THE OWNER'S SCENARIO: 200 settled, then 50 settled mid-bridge, reads 200 and 0", async () => {
    // "I did a bridge, I have $200 and send it, a snapshot fires meanwhile and
    // shows $50 and -$150, which causes anxiety." The previous cycle measured
    // the whole $200 settled; the latest fires while $150 is in transit.
    scriptSnapshot(
      snapshotRow({
        snapshot_group_id: "mid-bridge",
        total: "50",
        at: "2026-05-21T10:05:00.000Z",
        in_transit: 150,
        in_flight_total_count: 1,
        in_flight: JSON.stringify([IN_FLIGHT_BRIDGE]),
      }),
      snapshotRow({
        snapshot_group_id: "before-bridge",
        total: "200",
        at: "2026-05-21T10:00:00.000Z",
        in_flight: "[]",
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotSettledUsd).toBeCloseTo(50, 4);
    expect(data.snapshotInTransitUsd).toBeCloseTo(150, 4);
    expect(data.snapshotTotalUsd).toBeCloseTo(200, 4);
    // No loss was taken, so none is reported. This is the whole point.
    expect(data.pnlVsPrev).toBeCloseTo(0, 4);
    expect(data.snapshotInFlight).toEqual([IN_FLIGHT_BRIDGE]);
    expect(data.snapshotUnresolvedCount).toBe(0);
  });

  it("treats a group with NO per-wallet attribution (before migration 102) as in-transit 0", async () => {
    scriptSnapshot(
      snapshotRow({ total: "100", in_transit: null, unresolved_count: null, in_flight: null }),
      snapshotRow({
        snapshot_group_id: "g0",
        total: "80",
        at: "2026-05-20T10:00:00.000Z",
        in_transit: null,
        unresolved_count: null,
        in_flight: null,
      }),
    );

    const data = await readGlobalPortfolio();

    // Exactly the figures the pre-101 reader produced, so the two bases stay
    // comparable across the migration rather than reporting a phantom jump.
    expect(data.snapshotSettledUsd).toBeCloseTo(100, 4);
    expect(data.snapshotInTransitUsd).toBe(0);
    expect(data.snapshotTotalUsd).toBeCloseTo(100, 4);
    expect(data.pnlVsPrev).toBeCloseTo(20, 4);
    expect(data.snapshotInFlight).toEqual([]);
    expect(data.snapshotUnresolvedCount).toBe(0);
  });

  it("mixes an old previous group with a new latest one without a phantom jump", async () => {
    scriptSnapshot(
      snapshotRow({ total: "100", in_flight: "[]" }),
      snapshotRow({
        snapshot_group_id: "g0",
        total: "80",
        at: "2026-05-20T10:00:00.000Z",
        in_transit: null,
        unresolved_count: null,
        in_flight: null,
      }),
    );

    expect((await readGlobalPortfolio()).pnlVsPrev).toBeCloseTo(20, 4);
  });

  it("counts an UNRESOLVED entry without adding it to any total", async () => {
    scriptSnapshot(
      snapshotRow({
        total: "50",
        // The publisher already excluded the unresolved estimate from
        // `in_transit_usd`; the reader must not add it back.
        in_transit: 0,
        unresolved_count: 1,
        in_flight_total_count: 1,
        in_flight: JSON.stringify([{ ...IN_FLIGHT_BRIDGE, standing: "unresolved" }]),
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotTotalUsd).toBeCloseTo(50, 4);
    expect(data.snapshotUnresolvedCount).toBe(1);
    expect(data.snapshotInFlight?.[0]?.standing).toBe("unresolved");
  });

  it("reads the group record through correlated subqueries, not a second query", async () => {
    scriptSnapshot(null);

    await readGlobalPortfolio();

    // Still four SELECTs: the group's accounting is correlated subqueries in
    // the snapshot query, so a group with no record cannot drop out of it.
    expect(mocks.query).toHaveBeenCalledTimes(4);
    const sql = String(snapshotCall()?.[0] ?? "");
    expect(sql).toContain("proj_portfolio_snapshot_group_wallets");
    expect(sql).toContain("LIMIT 2");
  });

  it("collapses an absent snapshot to null totals, ledger and bound contract", async () => {
    scriptSnapshot(null);

    const data = await readGlobalPortfolio();

    expect(data.snapshotTotalUsd).toBeNull();
    expect(data.snapshotSettledUsd).toBeNull();
    expect(data.snapshotInTransitUsd).toBeNull();
    expect(data.snapshotInFlight).toBeNull();
    expect(data.snapshotUnresolvedCount).toBeNull();
    expect(data.snapshotInFlightTotalCount).toBeNull();
    expect(data.snapshotInFlightShownCount).toBeNull();
    expect(data.snapshotInFlightTruncated).toBeNull();
    expect(data.pnlVsPrev).toBeNull();
    expect(data.snapshotAt).toBeNull();
  });
});

// ── 2. In-flight money is scoped to the wallets being asked about ────────

describe("per-wallet scoping of in-flight money", () => {
  const BRIDGE_ON_B = { ...IN_FLIGHT_BRIDGE, walletAddress: WALLET_B, ref: "b-132" };

  it("sums the in-flight components of exactly the resolved addresses, in SQL", async () => {
    scriptSnapshot(snapshotRow({ total: "100" }));

    await readGlobalPortfolio();

    // Every in-flight aggregate carries the SAME `$1::text[]` allow-list the
    // rest of the read binds. A scope cannot be widened for the money half of
    // the answer while the balances half stays narrow.
    const sql = String(snapshotCall()?.[0] ?? "");
    const scopedAggregates = sql.match(
      /FROM proj_portfolio_snapshot_group_wallets w\s+WHERE w\.snapshot_group_id = s\.snapshot_group_id\s+AND w\.wallet_address = ANY\(\$1::text\[\]\)/g,
    );
    expect(scopedAggregates).toHaveLength(3);
    expect(snapshotCall()?.[1]).toEqual([[WALLET_A], 1]);
  });

  it("gives a scope holding only wallet A ZERO in transit and NO entry belonging to B", async () => {
    // THE DEFECT. Wallet B is mid-bridge; the user opens a scope that holds
    // only wallet A. The group's own figure would hand A a stranger's $150.
    scriptSnapshot(
      snapshotRow({
        total: "50",
        // The SQL aggregate already summed only A's rows, of which there are
        // none. The stored LIST is still the whole group's, so the reader must
        // drop B's entry itself.
        in_transit: 0,
        unresolved_count: 0,
        in_flight_total_count: 0,
        in_flight: JSON.stringify([BRIDGE_ON_B]),
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotInTransitUsd).toBe(0);
    expect(data.snapshotUnresolvedCount).toBe(0);
    expect(data.snapshotInFlight).toEqual([]);
    expect(data.snapshotTotalUsd).toBeCloseTo(50, 4);
  });

  it("gives a scope holding only wallet B its OWN pending bridge and nothing of A's", async () => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "2", address: WALLET_B, label: "", createdAt: "" }] : [],
    );
    scriptSnapshot(
      snapshotRow({
        total: "0",
        // The SQL aggregate summed B's rows only; the stored list still holds
        // both wallets' entries and the reader narrows it.
        in_transit: 150,
        in_flight_total_count: 1,
        in_flight: JSON.stringify([IN_FLIGHT_BRIDGE, BRIDGE_ON_B]),
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotInFlight).toEqual([BRIDGE_ON_B]);
    expect(data.snapshotInTransitUsd).toBe(150);
    expect(data.snapshotTotalUsd).toBeCloseTo(150, 4);
    expect(snapshotCall()?.[1]).toEqual([[WALLET_B], 1]);
  });

  it("gives a scope holding BOTH wallets both entries and the summed total", async () => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm"
        ? [
            { id: "1", address: WALLET_A, label: "", createdAt: "" },
            { id: "2", address: WALLET_B, label: "", createdAt: "" },
          ]
        : [],
    );
    scriptSnapshot(
      snapshotRow({
        total: "50",
        in_transit: 300,
        in_flight_total_count: 2,
        in_flight: JSON.stringify([IN_FLIGHT_BRIDGE, BRIDGE_ON_B]),
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotInFlight?.map((entry) => entry.walletAddress)).toEqual([
      WALLET_A,
      WALLET_B,
    ]);
    expect(data.snapshotInTransitUsd).toBe(300);
    expect(data.snapshotTotalUsd).toBeCloseTo(350, 4);
    expect(snapshotCall()?.[1]).toEqual([[WALLET_A, WALLET_B], 2]);
  });

  it("drops an entry written before migration 102, which carries no attribution", async () => {
    const { walletAddress: _omitted, ...unattributed } = IN_FLIGHT_BRIDGE;
    scriptSnapshot(
      snapshotRow({ total: "50", in_flight: JSON.stringify([unattributed]) }),
    );

    const data = await readGlobalPortfolio();

    // "Nothing in flight for these wallets" is the conservative reading;
    // showing an unattributed row would be showing somebody's money without
    // knowing whose.
    expect(data.snapshotInFlight).toEqual([]);
  });
});

/**
 * The owner's scenario, replayed at all three scopes.
 *
 * Wallet A holds $50 settled with $150 mid-bridge; wallet B holds nothing and
 * has nothing in flight. The group's own figures are settled 50 and in transit
 * 150, and the question every scope must answer differently is "whose $150 is
 * that".
 */
describe("wallet A is 50 settled plus 150 in transit, wallet B is empty", () => {
  const BOTH = [
    { id: "1", address: WALLET_A, label: "", createdAt: "" },
    { id: "2", address: WALLET_B, label: "", createdAt: "" },
  ];

  /**
   * `total` is the settled sum the snapshot rows give for the SCOPE, and
   * `in_transit` is what the per-wallet aggregate sums for that same scope.
   */
  function scriptScenario(settled: string, inTransit: number, shown: number): void {
    scriptSnapshot(
      snapshotRow({
        total: settled,
        in_transit: inTransit,
        in_flight_total_count: shown,
        in_flight: JSON.stringify([IN_FLIGHT_BRIDGE]),
      }),
    );
  }

  it("FULL scope reads 50 settled, 150 in transit, 200 total, and names A's entry", async () => {
    mocks.listWallets.mockImplementation((family: string) => (family === "evm" ? BOTH : []));
    scriptScenario("50", 150, 1);

    const data = await readGlobalPortfolio();

    expect(data.snapshotSettledUsd).toBeCloseTo(50, 4);
    expect(data.snapshotInTransitUsd).toBeCloseTo(150, 4);
    expect(data.snapshotTotalUsd).toBeCloseTo(200, 4);
    expect(data.snapshotInFlight).toEqual([IN_FLIGHT_BRIDGE]);
    expect(data.snapshotInFlightTotalCount).toBe(1);
    expect(data.snapshotInFlightTruncated).toBe(false);
  });

  it("A-ONLY scope reads the same 200, because the money is A's", async () => {
    scriptScenario("50", 150, 1);

    const data = await readGlobalPortfolio();

    expect(data.snapshotSettledUsd).toBeCloseTo(50, 4);
    expect(data.snapshotInTransitUsd).toBeCloseTo(150, 4);
    expect(data.snapshotTotalUsd).toBeCloseTo(200, 4);
    expect(data.snapshotInFlight).toEqual([IN_FLIGHT_BRIDGE]);
    expect(snapshotCall()?.[1]).toEqual([[WALLET_A], 1]);
  });

  it("B-ONLY scope reads 0 and 0, and is shown none of A's bridge", async () => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "2", address: WALLET_B, label: "", createdAt: "" }] : [],
    );
    // The aggregate sums B's per-wallet rows, of which there are none.
    scriptScenario("0", 0, 0);

    const data = await readGlobalPortfolio();

    expect(data.snapshotSettledUsd).toBeCloseTo(0, 4);
    expect(data.snapshotInTransitUsd).toBe(0);
    expect(data.snapshotTotalUsd).toBeCloseTo(0, 4);
    // Not "$150 appeared in an empty wallet": the entry is A's and is dropped.
    expect(data.snapshotInFlight).toEqual([]);
    expect(data.snapshotInFlightTotalCount).toBe(0);
  });
});

// ── 3. The bounded list is a list, never a total ─────────────────────────

describe("the display bound contract", () => {
  it("reports totalCount, shownCount and truncated when rows exist beyond the list", async () => {
    const shown = Array.from({ length: 50 }, (_, i) => ({
      ...IN_FLIGHT_BRIDGE,
      ref: `row-${i}`,
    }));
    scriptSnapshot(
      snapshotRow({
        total: "50",
        // The publisher counted 55 rows and priced all of them; only 50 fitted
        // the list. Summing the list would delete five rows' money.
        in_transit: 8250,
        in_flight_total_count: 55,
        in_flight: JSON.stringify(shown),
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotInFlightTotalCount).toBe(55);
    expect(data.snapshotInFlightShownCount).toBe(50);
    expect(data.snapshotInFlightTruncated).toBe(true);
    // The total came from the publisher's aggregate, not from the 50 rows.
    expect(data.snapshotInTransitUsd).toBe(8250);
    expect(data.snapshotTotalUsd).toBeCloseTo(8300, 4);
  });

  it("reports an untruncated list as untruncated", async () => {
    scriptSnapshot(
      snapshotRow({
        total: "50",
        in_transit: 150,
        in_flight_total_count: 1,
        in_flight: JSON.stringify([IN_FLIGHT_BRIDGE]),
      }),
    );

    const data = await readGlobalPortfolio();

    expect(data.snapshotInFlightTotalCount).toBe(1);
    expect(data.snapshotInFlightShownCount).toBe(1);
    expect(data.snapshotInFlightTruncated).toBe(false);
  });
});

// ── 4. The durable ledger is parsed, not trusted ─────────────────────────

describe("reading the durable ledger", () => {
  it("degrades a malformed entry to an empty list, keeping the settled total", async () => {
    scriptSnapshot(
      snapshotRow({
        total: "50",
        in_transit: 150,
        in_flight: JSON.stringify([{ kind: "agent_activity_pending", walletAddress: WALLET_A }]),
      }),
    );

    const data = await readGlobalPortfolio();

    // A durable row that has crossed serialization is external input: it is
    // parsed, not trusted. A row that fails the schema must not take the rest
    // of the portfolio down with it, and must not reach the DTO half-formed.
    expect(data.snapshotInFlight).toEqual([]);
    expect(data.snapshotTotalUsd).toBeCloseTo(200, 4);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it("keeps the readable entries when only one of several is malformed", async () => {
    scriptSnapshot(
      snapshotRow({
        total: "50",
        in_transit: 150,
        in_flight_total_count: 2,
        in_flight: JSON.stringify([
          IN_FLIGHT_BRIDGE,
          { kind: "agent_activity_pending", walletAddress: WALLET_A },
        ]),
      }),
    );

    const data = await readGlobalPortfolio();

    // One unreadable row must not delete a report about the user's money.
    expect(data.snapshotInFlight).toEqual([IN_FLIGHT_BRIDGE]);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it("degrades unparseable JSON to an empty list and says so", async () => {
    scriptSnapshot(snapshotRow({ total: "50", in_flight: "{not json" }));

    expect((await readGlobalPortfolio()).snapshotInFlight).toEqual([]);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it("maps a kind this build has never heard of to the typed unknown fallback", async () => {
    scriptSnapshot(
      snapshotRow({
        total: "50",
        in_transit: 150,
        in_flight_total_count: 1,
        in_flight: JSON.stringify([{ ...IN_FLIGHT_BRIDGE, kind: "some_future_kind" }]),
      }),
    );

    const data = await readGlobalPortfolio();

    // A ledger written by a NEWER build stays VISIBLE - money is in flight and
    // a human should see it - while the closed enum still refuses to present an
    // unnamed kind as if it were understood.
    expect(data.snapshotInFlight).toEqual([{ ...IN_FLIGHT_BRIDGE, kind: "unknown" }]);
    // And it contributes nothing: the total came from the publisher's
    // aggregate, which never saw this list.
    expect(data.snapshotInTransitUsd).toBe(150);
  });

  it("refuses a NEGATIVE usdEstimate rather than letting it subtract", async () => {
    scriptSnapshot(
      snapshotRow({
        total: "50",
        in_flight: JSON.stringify([{ ...IN_FLIGHT_BRIDGE, usdEstimate: -500 }]),
      }),
    );

    const data = await readGlobalPortfolio();

    // The DTO's own gate: a negative estimate is a bad price, not a liability,
    // and it never reaches a surface that renders money.
    expect(data.snapshotInFlight).toEqual([]);
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it("clamps a negative persisted in-transit total to zero", async () => {
    scriptSnapshot(snapshotRow({ total: "50", in_transit: -42, in_flight: "[]" }));

    const data = await readGlobalPortfolio();

    // Migration 102 CHECKs this at the schema; a row written before it must not
    // subtract from the portfolio either.
    expect(data.snapshotInTransitUsd).toBe(0);
    expect(data.snapshotTotalUsd).toBeCloseTo(50, 4);
  });
});

// ── 5. The closed vocabulary, pinned across the two trees ────────────────

describe("the in-flight kind vocabulary", () => {
  /**
   * The engine's `IN_FLIGHT_KINDS` and this tree's `SNAPSHOT_IN_FLIGHT_KINDS`
   * are duplicated on purpose: `shared` bundles into the untrusted renderer and
   * cannot import `@vex-agent`, and the engine's project cannot reach into
   * `vex-app`. This suite runs in the main process, which can see both, so the
   * duplication is checked rather than trusted.
   */
  it("matches the engine's producer list, plus the reader's own fallback", () => {
    expect([...SNAPSHOT_IN_FLIGHT_KINDS]).toEqual([...IN_FLIGHT_KINDS, "unknown"]);
  });

  it("rejects a kind outside the closed list at the DTO boundary", () => {
    const parsed = snapshotInFlightEntryDtoSchema.safeParse({
      ...IN_FLIGHT_BRIDGE,
      kind: "some_future_kind",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts every producer kind", () => {
    for (const kind of IN_FLIGHT_KINDS) {
      expect(snapshotInFlightEntryDtoSchema.safeParse({ ...IN_FLIGHT_BRIDGE, kind }).success)
        .toBe(true);
    }
  });
});
