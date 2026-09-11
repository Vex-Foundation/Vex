/**
 * `agent-scan-db` tests — scope, filter compilation, keyset pagination and the
 * bounded-read failure mode for the Agent Scan feed.
 *
 * Mirrors `token-history-db.test.ts`'s mock setup (mocked
 * `pg`/`db-config`/`@vex-lib/wallet.js`/logger) rather than sharing
 * boilerplate — the same deliberate choice the sibling db suites document.
 *
 * The SCOPE tests are the ones that matter most: this feed is GLOBAL, so the
 * only thing standing between it and another wallet's history is the
 * server-resolved inventory allow-list. They assert the predicate is present
 * AND that no filter can remove it.
 *
 * Row → DTO mapping lives in the sibling `agent-scan-db-mapping.test.ts`.
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
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { connect: mocks.connect, end: mocks.end, query: mocks.query };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("@vex-lib/wallet.js", () => ({ listWallets: mocks.listWallets }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { agentScanCursorSchema } = await import("@shared/schemas/agent-scan-feed.js");
const { getAgentScan } = await import("../agent-scan-db.js");
const { AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE } = await import(
  "../agent-activity-logical-row.js"
);

const WALLET_EVM = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_EVM_LOWER = WALLET_EVM.toLowerCase();
const WALLET_SOL = "So11111111111111111111111111111111111111112";
const SESSION = "11111111-2222-4333-8444-555555555555";

class FakeDbError extends Error {
  code: string;
  constructor(code: string) {
    super("db error");
    this.code = code;
  }
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_rank: 0,
    source_id: "1",
    created_at: new Date("2026-05-21T10:00:00.000Z"),
    cursor_ts: "2026-05-21T10:00:00.000000Z",
    activity_kind: "swap",
    event_role: "swap",
    status: "confirmed",
    protocol: "kyberswap",
    chain_id: "8453",
    chain_family: "eip155",
    chain_slug: "base",
    from_chain_id: null,
    from_chain_slug: null,
    to_chain_id: null,
    to_chain_slug: null,
    token_in_address: "0xbeef",
    token_in_symbol: "USDC",
    token_in_decimals: 6,
    amount_in_human: "1.5",
    amount_in_raw: "1500000",
    executed_amount_in_human: null,
    executed_amount_in_raw: "1500000",
    usd_in_est: "1.50",
    token_out_address: "0xcafe",
    token_out_symbol: "WETH",
    token_out_decimals: 18,
    amount_out_human: "0.0004",
    amount_out_raw: "400000000000000",
    executed_amount_out_human: null,
    executed_amount_out_raw: "400000000000000",
    usd_out_est: "1.49",
    usd_fee_est: null,
    vex_fee_usd_est: null,
    vex_fee_token_symbol: null,
    vex_fee_source: null,
    vex_fee_amount_human: null,
    failure_code: null,
    failure_reason: null,
    tx_hash: "0xhash",
    provider_order_id: null,
    last_checked_at: null,
    legs: null,
    ...overrides,
  };
}

/** The last non-transaction-control query issued (the page SELECT). */
function pageCall(): { sql: string; params: readonly unknown[] } {
  const call = mocks.query.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0].includes("FROM agent_activity"),
  );
  if (call === undefined) throw new Error("no page query issued");
  return { sql: call[0] as string, params: (call[1] ?? []) as readonly unknown[] };
}

/** The Lighter arm's page SELECT, or `null` when the arm was excluded. */
function lighterCall(): { sql: string; params: readonly unknown[] } | null {
  const call = mocks.query.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0].includes("FROM lighter_fills"),
  );
  if (call === undefined) return null;
  return { sql: call[0] as string, params: (call[1] ?? []) as readonly unknown[] };
}

/**
 * One `lighter_fills` row as the Lighter arm selects it. Only the fields this
 * suite's assertions read are spelled out here; the full row and its mapping
 * are the subject of `agent-scan-lighter-mappers.test.ts`.
 */
function lighterRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_rank: 1,
    source_id: "7",
    cursor_ts: "2026-05-21T10:00:00.000000Z",
    traded_at: new Date("2026-05-21T10:00:00.000Z"),
    observed_at: new Date("2026-05-21T10:00:02.000Z"),
    environment: "core",
    market_index: 1,
    market_symbol: "ETH",
    side: "buy",
    trade_type: "trade",
    position_effect: null,
    base_size: "0.005",
    price: "2598.09",
    quote_notional: "12.99045",
    usd_amount: "12.99",
    block_height: "10453221",
    base_asset_symbol: "ETH",
    base_asset_decimals: 18,
    quote_asset_symbol: "USDC",
    quote_asset_decimals: 6,
    position_size_before: null,
    entry_quote_before: null,
    account_pnl: null,
    initial_margin_fraction_before: null,
    fee_side: "taker",
    integrator_fee_charged_raw: null,
    integrator_fee_estimated_raw: null,
    integrator_fee_estimate_basis: null,
    integrator_fee_estimate_tick_source: null,
    integrator_fee_estimated_usd: null,
    integrator_fee_asset_symbol: null,
    integrator_fee_asset_decimals: null,
    integrator_fee_tick_observed: null,
    integrator_fee_tick_authorized: null,
    exchange_fee_charged_raw: null,
    exchange_fee_estimated_usd: null,
    exchange_fee_tick_observed: null,
    provider_trade_id: "918273645",
    provider_order_id: null,
    execution_intent_id: "lighter-exec-1",
    position_observed_at: null,
    position_open: null,
    position_now: null,
    ...overrides,
  };
}

/** Answer both arms independently, so a page can mix them. */
function respondWithArms(
  activityRows: ReadonlyArray<Record<string, unknown>>,
  fillRows: ReadonlyArray<Record<string, unknown>>,
): void {
  mocks.query.mockImplementation(async (text: string) => {
    if (text.includes("FROM agent_activity")) return { rows: activityRows };
    if (text.includes("FROM lighter_fills")) return { rows: fillRows };
    return { rows: [] };
  });
}

function respondWith(rows: ReadonlyArray<Record<string, unknown>>): void {
  mocks.query.mockImplementation(async (text: string) => {
    if (text.includes("FROM agent_activity")) return { rows };
    return { rows: [] };
  });
}

const EMPTY_INPUT = { cursor: null, filters: {} } as const;
/** Stands in for the handler's `ctx.requestId`. */
const CORRELATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5432,
    database: "vex",
    user: "vex",
    password: "pw",
  });
  mocks.listWallets.mockImplementation((family: string) =>
    family === "evm" ? [{ address: WALLET_EVM }] : [{ address: WALLET_SOL }],
  );
  respondWith([]);
});

afterEach(() => {
  vi.resetAllMocks();
});

// ── Scope / anti-leak ─────────────────────────────────────────────────────

describe("getAgentScan scope", () => {
  it("returns the empty page WITHOUT issuing SQL when the inventory is empty", async () => {
    mocks.listWallets.mockReturnValue([]);
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("binds the server-resolved inventory allow-list, never a caller value", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toContain("aa.wallet_address = ANY($1::text[])");
    expect(params[0]).toEqual([WALLET_EVM, WALLET_EVM_LOWER, WALLET_SOL]);
  });

  it("NEVER drops the wallet predicate, whatever filters are supplied", async () => {
    await getAgentScan({
      cursor: null,
      filters: {
        kinds: ["swap"],
        statuses: ["confirmed"],
        protocols: ["kyberswap"],
        chainFamily: "eip155",
        sessionId: SESSION,
      },
    }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toContain("aa.wallet_address = ANY($1::text[])");
    expect(params[0]).toEqual([WALLET_EVM, WALLET_EVM_LOWER, WALLET_SOL]);
  });

  it("makes sessionId NARROW the scope - an AND on top of the wallet filter", async () => {
    await getAgentScan({ cursor: null, filters: { sessionId: SESSION } }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toContain("aa.wallet_address = ANY($1::text[])");
    expect(sql).toMatch(/AND aa\.session_id = \$\d+/);
    expect(params).toContain(SESSION);
    // The wallet allow-list is still the FIRST bound parameter — the session
    // filter was added, not substituted.
    expect(params[0]).toEqual([WALLET_EVM, WALLET_EVM_LOWER, WALLET_SOL]);
  });

  it("omits the session predicate entirely when no sessionId is supplied", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(pageCall().sql).not.toContain("aa.session_id");
  });
});

// ── Row selection ─────────────────────────────────────────────────────────

describe("getAgentScan row selection", () => {
  it("selects user actions by a positive role allow-list", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const { sql } = pageCall();
    expect(sql).toContain("aa.event_role IN (");
    for (const role of [
      "swap",
      "bridge_fill_expected",
      "lend_deposit",
      "lend_withdraw",
      "lend_borrow_operate",
      "wrap",
      "unwrap",
      "token_launch",
      "pools_claim",
    ]) {
      expect(AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE).toContain(`'${role}'`);
    }
  });

  it("includes every current yield action but excludes approval plumbing", () => {
    for (const role of [
      "yield_pt",
      "yield_yt",
      "yield_py",
      "yield_lp",
      "yield_sy",
      "yield_claim",
    ]) {
      expect(AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE).toContain(`'${role}'`);
    }
    expect(AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE).not.toContain("'allowance'");
    expect(AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE).not.toContain("'allowance_reset'");
  });

  // OWNER REVISION 2026-08-05, superseding "the fee leg renders as its own row
  // everywhere except the agent view". Live evidence: the feed rendered
  // "LAUNCH-FEE 0.0000031675 ETH → —" above "LAUNCH 0.001267 ETH → 105721 PUSSY"
  // — the same charge, at 25 bps of the launch, presented as a second user
  // action. The positive ROLE allow-list makes both known and future technical
  // legs fail closed instead of inheriting visibility from their kind.
  it("fails closed for fee and unknown technical roles", () => {
    for (const role of ["bridge_fee", "swap_fee", "trench_fee", "pools_fee"]) {
      expect(AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE).not.toContain(`'${role}'`);
    }
  });

  // Migration 102. The four family roles are user ACTIONS with their own
  // transactions; `vex_fee` is the LEG of one of them and must stay off this
  // list, or the same charge renders beside the action it is 25 bps of - the
  // exact defect the owner's 2026-08-05 revision recorded.
  it("admits the launchpad family as actions and still fails closed for its fee leg", () => {
    for (const role of [
      "creator_fee_claim",
      "holder_reward_claim",
      "reward_distribution",
      "launch_cancel",
    ]) {
      expect(AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE).toContain(`'${role}'`);
    }
    expect(AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE).not.toContain("'vex_fee'");
  });

  it("projects the fee leg onto its parent UNCONDITIONALLY - no fee leg is its own row now", async () => {
    // The projection used to skip a fee leg that was already its own ledger
    // entry. With no fee leg rendering as a row, that guard would hide the
    // charge completely; its removal is what keeps the money visible.
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const { sql } = pageCall();
    expect(sql).toContain(
      // Migration 088 adds `tx_vex_fee`: the generic EVM signing lane's fee leg
      // is a child of the transaction it charges for, so the parent reports it
      // here rather than the leg rendering as a row of its own.
      // Migration 102 adds `vex_fee`: the venue-independent name for the same
      // leg on the swap, bridge and launch arms. It is excluded from the
      // logical-row allow-list above and folded here, and the two have to move
      // together - excluded but not folded hides a real charge, folded but not
      // excluded shows it twice.
      "fee.event_role IN ('bridge_fee','swap_fee','trench_fee','pools_fee','tx_vex_fee','vex_fee')",
    );
    // The deleted guard was the logical-row predicate applied to the `fee`
    // alias - the only place this SQL ever spoke of `fee.kind`.
    expect(sql).not.toContain("fee.kind");
  });

  /**
   * OWNER RULE V1 (2026-09-04), and the defect it closes. The sibling lateral
   * used to select `AND fee.status = 'confirmed'`, so a swap or launch whose fee
   * transfer was still in flight, or had reverted, reported NO fee attempt at
   * all - while the fee leg was also excluded from the row list, which is the
   * only other place it could have appeared. The MONEY fields stay
   * confirmed-only, because an attempted charge is not a charge.
   *
   * This surface has no real-Postgres harness in this repository, so its
   * counterpart assertions are SQL-text pins; the executed behaviour is proven
   * against real Postgres for the sibling projection in
   * `src/__tests__/integration/agent-scan/vex-fee-projection.int.test.ts`.
   */
  it("admits a fee leg in ANY status, and only a CONFIRMED one may fill a money field", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const { sql } = pageCall();

    // The lateral no longer filters the leg on its status...
    expect(sql).not.toContain("fee.status     = 'confirmed'");
    // ...it ORDERS a confirmed leg first, so a confirmed retry after a failed
    // attempt is the leg the money is read from.
    expect(sql).toContain("ORDER BY (fee.status = 'confirmed') DESC");
    // ...and the money discriminator requires that the picked leg confirmed.
    expect(sql).toContain("AND fee_leg.leg_status = 'confirmed'");
    // The double-charge count filters on CONFIRMED, or a legitimate
    // failed-then-confirmed retry pair would read as an anomaly and blank a fee
    // that was really taken exactly once.
    expect(sql).toContain("count(*) FILTER (WHERE fee.status = 'confirmed') OVER ()");
  });

  it("projects the ATTEMPT's own status, hash and chain beside the money fields", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const { sql } = pageCall();

    expect(sql).toContain("AS vex_fee_leg_status");
    expect(sql).toContain("AS vex_fee_leg_tx_hash");
    expect(sql).toContain("vex_fee_leg_chain_id");
    expect(sql).toContain("AS vex_fee_leg_chain_family");
    // Visible only while the double-charge anomaly is ruled out: with two
    // confirmed legs the row cannot say which charge it is describing, so it
    // reports no fee at all rather than half of one.
    expect(sql).toContain("fee_flags.leg_visible");
    expect(sql).toContain("fee_leg.confirmed_leg_count <= 1");
    // The DTO's status vocabulary is `pending | confirmed | failed`, so the
    // stored terminal name is collapsed here exactly as the row's own is.
    expect(sql).toContain("WHEN 'definitively_failed' THEN 'failed'");
  });

  it("reads agent_activity ONLY - no legacy union arm", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const { sql } = pageCall();
    expect(sql).not.toContain("proj_activity");
    expect(sql).not.toContain("wallet_intents");
    expect(sql).not.toContain("UNION");
  });

  it("collapses definitively_failed to failed in SQL", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(pageCall().sql).toContain(
      "CASE aa.status WHEN 'definitively_failed' THEN 'failed' ELSE aa.status END",
    );
  });

  it("orders newest-first with a deterministic id tie-break", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(pageCall().sql).toContain("ORDER BY aa.created_at DESC, aa.id DESC");
  });

  it("runs BOTH arms inside ONE bounded REPEATABLE READ READ ONLY snapshot", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const texts = mocks.query.mock.calls.map((c) => c[0] as string);
    expect(texts).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(texts.some((t) => t.includes("SET LOCAL statement_timeout = '2s'"))).toBe(true);
    expect(texts).toContain("COMMIT");
  });
});

// ── Filter compilation ────────────────────────────────────────────────────

describe("getAgentScan filter compilation", () => {
  it("compiles the kinds filter as a bound array parameter", async () => {
    await getAgentScan({ cursor: null, filters: { kinds: ["bridge", "wrap"] } }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toMatch(/AND aa\.kind = ANY\(\$\d+::text\[\]\)/);
    expect(params).toContainEqual(["bridge", "wrap"]);
  });

  it("compiles the protocols filter as a bound array parameter", async () => {
    await getAgentScan({ cursor: null, filters: { protocols: ["khalani"] } }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toMatch(/AND aa\.protocol = ANY\(\$\d+::text\[\]\)/);
    expect(params).toContainEqual(["khalani"]);
  });

  it("EXPANDS the renderer-facing `failed` back to the stored `definitively_failed`", async () => {
    await getAgentScan({ cursor: null, filters: { statuses: ["failed", "pending"] } }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toMatch(/AND aa\.status = ANY\(\$\d+::text\[\]\)/);
    // Without this expansion the filter would silently match zero rows: the
    // renderer's vocabulary and the stored vocabulary are not the same.
    expect(params).toContainEqual(["definitively_failed", "pending"]);
  });

  it("compiles the chainFamily filter", async () => {
    await getAgentScan({ cursor: null, filters: { chainFamily: "solana" } }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toMatch(/AND aa\.chain_family = \$\d+/);
    expect(params).toContain("solana");
  });

  it("omits every predicate for a filter that was not supplied", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const { sql } = pageCall();
    expect(sql).not.toContain("aa.kind = ANY");
    expect(sql).not.toContain("aa.protocol = ANY");
    expect(sql).not.toContain("aa.status = ANY");
    expect(sql).not.toContain("aa.chain_family =");
  });

  it("compiles every filter together", async () => {
    await getAgentScan({
      cursor: null,
      filters: {
        kinds: ["lend"],
        statuses: ["confirmed"],
        protocols: ["jupiter"],
        chainFamily: "solana",
        sessionId: SESSION,
      },
    }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toMatch(/AND aa\.kind = ANY/);
    expect(sql).toMatch(/AND aa\.status = ANY/);
    expect(sql).toMatch(/AND aa\.protocol = ANY/);
    expect(sql).toMatch(/AND aa\.chain_family =/);
    expect(sql).toMatch(/AND aa\.session_id =/);
    expect(params).toContainEqual(["lend"]);
    expect(params).toContainEqual(["confirmed"]);
    expect(params).toContainEqual(["jupiter"]);
    expect(params).toContain("solana");
    expect(params).toContain(SESSION);
  });

  it("never interpolates a filter value into the SQL text", async () => {
    await getAgentScan({
      cursor: null,
      filters: { kinds: ["'; DROP TABLE agent_activity; --"] },
    }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).not.toContain("DROP TABLE");
    expect(params).toContainEqual(["'; DROP TABLE agent_activity; --"]);
  });
});

// ── Keyset pagination ─────────────────────────────────────────────────────

describe("getAgentScan keyset pagination", () => {
  it("issues no keyset predicate on the first page", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(pageCall().sql).not.toContain("aa.created_at <");
  });

  it("compares the id NUMERICALLY at equal timestamps", async () => {
    await getAgentScan({
      cursor: { createdAt: "2026-05-21T10:00:00.123456Z", sourceId: "500", sourceRank: 0 },
      filters: {},
    }, CORRELATION_ID);
    const { sql, params } = pageCall();
    expect(sql).toMatch(/aa\.created_at < \$\d+::timestamptz/);
    // The 3-field boundary: the arm's rank is a LITERAL, compared against the
    // cursor's, and only a tie on both reaches the id compare.
    expect(sql).toMatch(/aa\.created_at = \$\d+::timestamptz AND 0 < \$\d+::int/);
    expect(sql).toMatch(/AND 0 = \$\d+::int AND aa\.id < \$\d+::bigint/);
    expect(params).toContain("2026-05-21T10:00:00.123456Z");
    expect(params).toContain("500");
  });

  it("paginates stably when timestamps tie and only the id differs", async () => {
    const tied = "2026-05-21T10:00:00.123456Z";
    respondWith([
      row({ source_id: "9", cursor_ts: tied }),
      row({ source_id: "8", cursor_ts: tied }),
      row({ source_id: "7", cursor_ts: tied }),
    ]);
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.data.status !== "available") return;
    expect(outcome.data.entries.map((e) => e.id)).toEqual(["9", "8", "7"]);
  });

  it("emits nextCursor from the last KEPT row and reports hasMore", async () => {
    // 51 rows come back for a 50-row page: the read asks for limit+1.
    const rows = Array.from({ length: 51 }, (_, i) =>
      row({
        source_id: String(100 - i),
        cursor_ts: `2026-05-21T10:00:00.${String(100 - i).padStart(6, "0")}Z`,
      }),
    );
    respondWith(rows);
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.data.status !== "available") return;
    expect(outcome.data.entries).toHaveLength(50);
    expect(outcome.data.hasMore).toBe(true);
    expect(outcome.data.nextCursor).toEqual({
      createdAt: "2026-05-21T10:00:00.000051Z",
      sourceId: "51",
      // The arm the page ended on. Without it the next page could not resume
      // on the right side of a cross-arm tie at the same microsecond.
      sourceRank: 0,
    });
  });

  it("emits a null nextCursor on the last page", async () => {
    respondWith([row()]);
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.data.status !== "available") return;
    expect(outcome.data.hasMore).toBe(false);
    expect(outcome.data.nextCursor).toBeNull();
  });

  it("carries the SQL-rendered microsecond timestamp, never a Date round-trip", async () => {
    const rows = Array.from({ length: 51 }, () =>
      row({ cursor_ts: "2026-05-21T10:00:00.123456Z" }),
    );
    respondWith(rows);
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    if (!outcome.ok || outcome.data.status !== "available") return;
    // A `Date` round-trip would have truncated this to `.123Z`.
    expect(outcome.data.nextCursor?.createdAt).toBe("2026-05-21T10:00:00.123456Z");
  });

  it("selects the cursor timestamp at microsecond precision in SQL", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(pageCall().sql).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);
  });
});

// ── Bounded-read failure ──────────────────────────────────────────────────

describe("getAgentScan bounded-read failure", () => {
  it("degrades a statement timeout to the unavailable DTO, never an empty page", async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes("FROM agent_activity")) throw new FakeDbError("57014");
      return { rows: [] };
    });
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual({ status: "unavailable", reason: "query_timeout" });
  });

  it("rolls back and errors on any other query failure", async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes("FROM agent_activity")) throw new FakeDbError("42P01");
      return { rows: [] };
    });
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(false);
    const texts = mocks.query.mock.calls.map((c) => c[0] as string);
    expect(texts).toContain("ROLLBACK");
  });

  it("returns an error Result when the database is unreachable", async () => {
    mocks.buildPoolConfig.mockResolvedValue(null);
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(false);
  });
});

// ── The two arms ──────────────────────────────────────────────────────────

describe("getAgentScan two-arm composition", () => {
  it("issues BOTH arm queries inside the SAME transaction", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const texts = mocks.query.mock.calls.map((c) => c[0] as string);
    const begin = texts.findIndex((t) => t.startsWith("BEGIN"));
    const commit = texts.indexOf("COMMIT");
    const activity = texts.findIndex((t) => t.includes("FROM agent_activity"));
    const lighter = texts.findIndex((t) => t.includes("FROM lighter_fills"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(activity).toBeGreaterThan(begin);
    expect(lighter).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(Math.max(activity, lighter));
  });

  /**
   * REPEATABLE READ, not the default READ COMMITTED: at READ COMMITTED each
   * statement takes its OWN snapshot, so a fill inserted between the two arm
   * queries could be counted by one arm's `limit + 1` probe while the other
   * arm's boundary had already moved past it.
   */
  it("reads both arms from ONE snapshot", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const texts = mocks.query.mock.calls.map((c) => c[0] as string);
    expect(texts).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(texts.some((t) => t.includes("SET LOCAL statement_timeout = '2s'"))).toBe(true);
  });

  it("binds the SAME inventory allow-list to both arms", async () => {
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    const lighter = lighterCall();
    expect(lighter).not.toBeNull();
    expect(lighter?.params[0]).toEqual(pageCall().params[0]);
  });

  it("skips the Lighter arm entirely when the filters exclude it", async () => {
    await getAgentScan({ cursor: null, filters: { kinds: ["swap"] } }, CORRELATION_ID);
    expect(lighterCall()).toBeNull();
  });

  it("reads the Lighter arm when kinds names just that feed kind", async () => {
    respondWithArms([row()], [lighterRow()]);
    await getAgentScan({ cursor: null, filters: { kinds: ["lighter_fill"] } }, CORRELATION_ID);
    // The activity arm's own `kind` predicate compiles the same value, which
    // matches no `agent_activity.kind` - `lighter_fill` is a FEED kind, not a
    // ledger one, so that arm legitimately returns nothing for it.
    expect(pageCall().params).toContainEqual(["lighter_fill"]);
    expect(lighterCall()).not.toBeNull();
  });

  it("interleaves the two arms into one time-ordered page", async () => {
    respondWithArms(
      [
        row({ source_id: "20", cursor_ts: "2026-05-21T10:00:03.000000Z" }),
        row({ source_id: "18", cursor_ts: "2026-05-21T10:00:01.000000Z" }),
      ],
      [lighterRow({ source_id: "7", cursor_ts: "2026-05-21T10:00:02.000000Z" })],
    );
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.data.status !== "available") return;
    expect(outcome.data.entries.map((entry) => [entry.source, entry.id])).toEqual([
      ["agent_activity", "20"],
      ["lighter_fill", "7"],
      ["agent_activity", "18"],
    ]);
  });

  it("carries the arm the page ended on into nextCursor", async () => {
    // 51 rows across the two arms, 49 of them newer activity rows: the page
    // keeps 50, so the last kept row is the FIRST fill and the cursor has to
    // say which arm it came from.
    const activityRows = Array.from({ length: 49 }, (_, i) =>
      row({
        source_id: String(100 - i),
        cursor_ts: `2026-05-21T10:00:00.${String(900 - i).padStart(6, "0")}Z`,
      }),
    );
    respondWithArms(activityRows, [
      lighterRow({ source_id: "7", cursor_ts: "2026-05-21T10:00:00.000100Z" }),
      lighterRow({ source_id: "6", cursor_ts: "2026-05-21T10:00:00.000090Z" }),
    ]);
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.data.status !== "available") return;
    expect(outcome.data.entries).toHaveLength(50);
    expect(outcome.data.hasMore).toBe(true);
    expect(outcome.data.nextCursor).toEqual({
      createdAt: "2026-05-21T10:00:00.000100Z",
      sourceId: "7",
      sourceRank: 1,
    });
  });

  it("applies the SAME cursor boundary to both arms", async () => {
    await getAgentScan({
      cursor: { createdAt: "2026-05-21T10:00:00.123456Z", sourceId: "500", sourceRank: 1 },
      filters: {},
    }, CORRELATION_ID);
    expect(pageCall().params).toContain("2026-05-21T10:00:00.123456Z");
    expect(lighterCall()?.params).toContain("2026-05-21T10:00:00.123456Z");
    expect(pageCall().params).toContain(1);
    expect(lighterCall()?.params).toContain(1);
  });

  /**
   * A timeout on EITHER arm fails the WHOLE read closed. Returning the arm that
   * answered would present half a history as the history, on a surface whose
   * whole promise is that nothing is hidden.
   */
  it("fails the whole read closed when the LIGHTER arm times out", async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes("FROM lighter_fills")) throw new FakeDbError("57014");
      if (text.includes("FROM agent_activity")) return { rows: [row()] };
      return { rows: [] };
    });
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual({ status: "unavailable", reason: "query_timeout" });
  });

  it("rolls back and errors on any other LIGHTER arm failure", async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes("FROM lighter_fills")) throw new FakeDbError("42P01");
      if (text.includes("FROM agent_activity")) return { rows: [] };
      return { rows: [] };
    });
    const outcome = await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(outcome.ok).toBe(false);
    expect(mocks.query.mock.calls.map((c) => c[0] as string)).toContain("ROLLBACK");
  });

  it("returns the empty page WITHOUT issuing either arm when the inventory is empty", async () => {
    mocks.listWallets.mockReturnValue([]);
    await getAgentScan(EMPTY_INPUT, CORRELATION_ID);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

// ── Cursor compatibility ──────────────────────────────────────────────────

describe("the feed cursor across the two arms", () => {
  /**
   * A cursor minted before the second arm existed carries no `sourceRank`. It
   * must still parse, and must resume on the ACTIVITY side of a tie - which is
   * where it was issued.
   */
  it("parses a cursor minted before the Lighter arm existed", () => {
    const parsed = agentScanCursorSchema.parse({
      createdAt: "2026-05-21T10:00:00.123456Z",
      sourceId: "500",
    });
    expect(parsed).toEqual({
      createdAt: "2026-05-21T10:00:00.123456Z",
      sourceId: "500",
      sourceRank: 0,
    });
  });

  it("round-trips a cursor the feed itself minted", () => {
    const minted = {
      createdAt: "2026-05-21T10:00:00.123456Z",
      sourceId: "500",
      sourceRank: 1,
    };
    expect(agentScanCursorSchema.parse(minted)).toEqual(minted);
  });

  it("refuses a rank outside the two arms that exist", () => {
    expect(agentScanCursorSchema.safeParse({
      createdAt: "2026-05-21T10:00:00.123456Z",
      sourceId: "500",
      sourceRank: 2,
    }).success).toBe(false);
  });
});
