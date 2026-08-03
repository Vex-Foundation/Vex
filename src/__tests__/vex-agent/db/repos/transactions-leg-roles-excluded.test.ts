/**
 * transactions repo — LEG roles are not feed rows.
 *
 * THE DEFECT THIS PINS. The activity half admits logical rows by `kind`, but
 * the kind↔role CHECK (migrations 050/063/066) also binds approval legs
 * (`allowance`, `allowance_reset`) to the swap/yield/launch arms and Vex fee
 * legs (`trench_fee` on swap+launch, `swap_fee` on swap) to the same kinds.
 * Admitting by `kind` alone rendered a Trench/Uniswap fee transfer as a
 * standalone "spot" trade in the agent-facing feed. The predicate must exclude
 * every leg role while keeping the logical rows (`event_role = 'swap'`,
 * `token_launch`, the `yield_*` family, `bridge_fill_expected`) intact.
 */

import { describe, it, expect, vi, type Mock } from "vitest";

type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQuery: QueryMock;

function resetMocks() {
  mockQuery = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: vi.fn(),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/transactions.js");

const ADDRS = ["0xEVM", "SOL"];

function activityWhere(): string {
  // The activity half's WHERE clause, isolated by position: it starts at the
  // half's wallet filter and ends where the success half ('proj_activity'
  // source literal) begins. Splitting on "UNION" is unreliable — the legs
  // subquery inside the projection contains its own UNION.
  const feedSql = mockQuery.mock.calls
    .map((call) => call[0])
    .find((sql) => sql.includes("FROM agent_activity"));
  if (feedSql === undefined) throw new Error("no feed query captured");
  const start = feedSql.indexOf("WHERE wallet_address = ANY");
  const end = feedSql.indexOf("'proj_activity'");
  if (start === -1) throw new Error("activity-half WHERE not found");
  return end === -1 ? feedSql.slice(start) : feedSql.slice(start, end);
}

/** Every role the CHECK binds as a child leg of a logical row, never a row. */
const LEG_ROLES = ["allowance", "allowance_reset", "trench_fee", "swap_fee"] as const;

describe("transactions feed — leg-role exclusion", () => {
  it("the activity half excludes every leg role by name", async () => {
    resetMocks();
    await repo.getTransactions({ addresses: ADDRS, limit: 10 });
    const half = activityWhere();
    expect(half).toContain("event_role NOT IN (");
    for (const role of LEG_ROLES) {
      expect(half, `leg role "${role}" must be excluded from the feed`).toContain(`'${role}'`);
    }
  });

  it("the logical rows stay admitted alongside the exclusion", async () => {
    resetMocks();
    await repo.getTransactions({ addresses: ADDRS, limit: 10 });
    const half = activityWhere();
    // The exclusion must narrow, not replace, the kind admission — both
    // conditions are separate ANDed members of the same predicate list.
    expect(half).toContain("kind = 'swap'");
    expect(half).toContain("kind = 'yield'");
    expect(half).toContain("kind = 'launch'");
    expect(half).toContain("event_role = 'bridge_fill_expected'");
    // `bridge_fill_expected` is not a leg role and must not appear in the
    // NOT IN list (the whole bridge arm is admitted only through it).
    const notInList = half.split("event_role NOT IN (")[1]!.split(")")[0]!;
    expect(notInList).not.toContain("bridge_fill_expected");
  });

  it("a productType filter composes with the exclusion (spot still excludes fee legs)", async () => {
    resetMocks();
    await repo.getTransactions({ addresses: ADDRS, limit: 10, productType: "spot" });
    const half = activityWhere();
    expect(half).toContain("kind = 'swap'");
    expect(half).toContain("'swap_fee'");
  });
});
