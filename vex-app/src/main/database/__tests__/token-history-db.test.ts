/**
 * token-history-db tests — read-only, global-scope per-token TX history,
 * with NO real DB.
 *
 * Mirrors `portfolio-db.test.ts`: mocked `pg` Client (scripted
 * `mockResolvedValueOnce` per statement, in the exact order
 * `getTokenHistory` issues them: BEGIN READ ONLY, SET LOCAL
 * statement_timeout, the page UNION, then COMMIT/ROLLBACK), mocked
 * `db-config`, mocked `@vex-lib/wallet.js` `listWallets`, mocked logger.
 *
 * Split by domain under test (Card C5, move-only, same pattern as Cards
 * F1/K7/K8: no assertion changes, no coverage loss) once this file crossed
 * the repo's 500-line cap. This anchor covers empty-inventory, address
 * normalization, pagination, and page-phase failure classification;
 * `token-history-db-entry-mapping.test.ts` covers entry-mapping shape
 * details; `token-history-db-agent-activity.test.ts` covers the
 * `agent_activity` swap arm; `token-history-db-bridge.test.ts` covers the
 * `agent_activity` bridge arm.
 *
 * Security/behavior invariants under test:
 *  - empty inventory → the empty available page, NO SQL issued;
 *  - EVM addresses are lower-cased end-to-end; Solana stays verbatim;
 *  - keyset pagination (limit+1 → nextCursor/hasMore) across all three arms;
 *  - SQLSTATE 57014 on the PAGE phase → `{status:"unavailable"}`; any other
 *    page failure → a Result error.
 *
 * Cost basis was retired (Agent Scan plan §4.7) along with the
 * decimal-point unit-guessing heuristic — see `token-history-db.ts`'s module
 * header and `amountField`'s doc comment.
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
    return {
      connect: mocks.connect,
      end: mocks.end,
      query: mocks.query,
    };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("@vex-lib/wallet.js", () => ({
  listWallets: mocks.listWallets,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getTokenHistory } = await import("../token-history-db.js");

const WALLET_EVM = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_SOL = "So11111111111111111111111111111111111111112";
const BASE_CHAIN_ID = 8453;
const ARBITRUM_CHAIN_ID = 42161;
const SOLANA_CHAIN_ID = 20011000000;
const TOKEN_ADDR_MIXED_CASE = "0xBEEFbeefBEEFbeefBEEFbeefBEEFbeefBEEFbeef";
const TOKEN_ADDR_LOWER = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
const SOL_TOKEN = "TokMintABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk";

class FakeDbError extends Error {
  code: string;
  constructor(code: string) {
    super("db error");
    this.code = code;
  }
}

function activityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_kind: "activity",
    source_rank: 1,
    source_id: "00000000000000000001",
    created_at: new Date("2026-05-21T10:00:00.000Z"),
    cursor_ts: "2026-05-21T10:00:00.000000Z",
    namespace: "kyberswap",
    product_type: "spot",
    trade_side: "buy",
    chain: "base",
    dest_chain: null,
    input_token_address: TOKEN_ADDR_LOWER,
    input_amount: "1.5",
    output_token_address: TOKEN_ADDR_LOWER,
    output_amount: "2.0",
    input_value_usd: "100.00",
    output_value_usd: "100.00",
    unit_price_usd: "50.00",
    capture_status: "executed",
    tx_ref: "0xhash1",
    input_token_symbol: "USDC",
    input_token_local_symbol: null,
    output_token_symbol: "USDC",
    output_token_local_symbol: null,
    to_address: null,
    status: null,
    failure_code: null,
    ...overrides,
  };
}

function intentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_kind: "intent",
    source_rank: 0,
    source_id: "intent-abc",
    created_at: new Date("2026-05-20T10:00:00.000Z"),
    cursor_ts: "2026-05-20T10:00:00.000000Z",
    namespace: null,
    product_type: null,
    trade_side: null,
    chain: "base",
    dest_chain: null,
    input_token_address: null,
    input_amount: null,
    output_token_address: TOKEN_ADDR_LOWER,
    output_amount: "5",
    input_value_usd: null,
    output_value_usd: null,
    unit_price_usd: null,
    capture_status: "executed",
    tx_ref: "0xintenthash",
    input_token_symbol: null,
    input_token_local_symbol: null,
    output_token_symbol: null,
    output_token_local_symbol: null,
    to_address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    status: null,
    failure_code: null,
    ...overrides,
  };
}

/** Agent Scan §4.7 — one row per EVM swap ATTEMPT (pending/confirmed/failed). */
/**
 * Default status is "confirmed" — `input_amount`/`output_amount` (the
 * quote-time REQUESTED echo) are deliberately DECOY values ("999") distinct
 * from what `executed_amount_*_raw`/`token_*_decimals` compute, so any test
 * that forgets to override status and still asserts the executed value
 * would catch a regression back to showing the quote as settlement (C20).
 * 50000000 raw @ 6 decimals = "50"; 2000000000000000000 raw @ 18 decimals =
 * "2" (viem's `formatUnits` never prints a trailing ".0").
 */
function agentActivityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_kind: "agent_activity",
    source_rank: 2,
    source_id: "00000000000000000009",
    created_at: new Date("2026-07-10T10:00:00.000Z"),
    cursor_ts: "2026-07-10T10:00:00.000000Z",
    namespace: "kyberswap",
    product_type: "spot",
    trade_side: null,
    chain: String(BASE_CHAIN_ID),
    dest_chain: null,
    input_token_address: "0xInputToken",
    input_amount: "999",
    output_token_address: TOKEN_ADDR_LOWER,
    output_amount: "999",
    input_value_usd: "50.00",
    output_value_usd: "50.00",
    unit_price_usd: null,
    capture_status: null,
    tx_ref: "0xagenttx",
    input_token_symbol: "USDC",
    input_token_local_symbol: null,
    output_token_symbol: "WETH",
    output_token_local_symbol: null,
    to_address: null,
    status: "confirmed",
    failure_code: null,
    executed_amount_in_raw: "50000000",
    executed_amount_out_raw: "2000000000000000000",
    token_in_decimals: 6,
    token_out_decimals: 18,
    ...overrides,
  };
}

/** Scripts BEGIN + SET LOCAL, then the caller's page response + COMMIT/ROLLBACK. */
function scriptTransaction(opts: {
  page: ReadonlyArray<Record<string, unknown>> | Error;
}): void {
  mocks.query.mockResolvedValueOnce({ rows: [] }); // BEGIN READ ONLY
  mocks.query.mockResolvedValueOnce({ rows: [] }); // SET LOCAL statement_timeout

  if (opts.page instanceof Error) {
    mocks.query.mockRejectedValueOnce(opts.page); // page
    mocks.query.mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    return;
  }
  mocks.query.mockResolvedValueOnce({ rows: opts.page }); // page
  mocks.query.mockResolvedValueOnce({ rows: [] }); // COMMIT
}

/**
 * Flattens across CALLS only (one call's `params` array spreads into the
 * result) — NOT within a call's own params, since some params (`wallets`,
 * `chainAliases`) are themselves bound as arrays for `= ANY($n::text[])`.
 * A deeper `.flat()` would destroy that nesting and make it impossible to
 * assert on the alias candidate set as its OWN bound array (see the
 * chain-alias test below).
 */
function allBoundParams(): unknown[] {
  return mocks.query.mock.calls.flatMap((call) => {
    const params = call[1];
    return Array.isArray(params) ? params : [];
  });
}

/** The bound params array of the page-query call (the 3rd query() invocation). */
function pageQueryCall(): { readonly sql: string; readonly params: unknown[] } {
  const call = mocks.query.mock.calls[2];
  return { sql: String(call?.[0] ?? ""), params: (call?.[1] as unknown[]) ?? [] };
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
      ? [{ id: "1", address: WALLET_EVM, label: "", createdAt: "" }]
      : [{ id: "2", address: WALLET_SOL, label: "", createdAt: "" }],
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getTokenHistory — empty inventory", () => {
  it("returns the empty available page and issues NO SQL when no wallets are configured", async () => {
    mocks.listWallets.mockReturnValue([]);
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("getTokenHistory — address normalization", () => {
  it("lower-cases the EVM tokenAddress before binding it into the page query", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_MIXED_CASE,
      cursor: null,
    });
    expect(allBoundParams()).toContain(TOKEN_ADDR_LOWER);
    expect(allBoundParams()).not.toContain(TOKEN_ADDR_MIXED_CASE);
  });

  it("keeps a Solana address verbatim (case-sensitive base58)", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({
      chainId: SOLANA_CHAIN_ID,
      tokenAddress: SOL_TOKEN,
      cursor: null,
    });
    expect(allBoundParams()).toContain(SOL_TOKEN);
  });

  it("binds the chain-alias candidate set including the bare decimal chain id", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    const params = allBoundParams();
    const aliasArray = params.find(
      (p): p is string[] => Array.isArray(p) && p.includes("base"),
    );
    expect(aliasArray).toBeDefined();
    expect(aliasArray).toContain(String(BASE_CHAIN_ID));
  });
});

describe("getTokenHistory — pagination", () => {
  it("detects hasMore via limit+1 and mints nextCursor from the last KEPT row", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      activityRow({ source_id: String(i).padStart(20, "0"), cursor_ts: `2026-05-21T10:00:0${i % 10}.000000Z` }),
    );
    scriptTransaction({ page: rows });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    expect(result.data.entries).toHaveLength(50);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextCursor).not.toBeNull();
  });

  it("reports hasMore=false and nextCursor=null when the page is under the cap", async () => {
    scriptTransaction({ page: [activityRow()] });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextCursor).toBeNull();
  });

  it("mints a cursor whose sourceRank/sourceId match the last KEPT row's OWN arm across a mixed activity+intent tie (no gaps/dupes at a cross-arm tie)", async () => {
    // 49 activity rows (source_rank=1) tied on ONE created_at, followed by TWO
    // intent rows (source_rank=0) tied on the SAME created_at. The total order
    // (created_at DESC, source_rank DESC, source_id DESC) keeps every activity
    // row ahead of every intent row at an exact timestamp tie, and orders the
    // two intent rows by their own intent_id DESC — so row 50 (the last KEPT
    // row) is the FIRST intent row, and row 51 (dropped, hasMore-only) is the
    // second. The mock supplies rows already in this true sorted order (it
    // stands in for Postgres having already applied ORDER BY).
    const tiedTs = "2026-05-21T10:00:00.000000Z";
    const activityRows = Array.from({ length: 49 }, (_, i) =>
      activityRow({ source_id: String(i).padStart(20, "0"), cursor_ts: tiedTs, created_at: new Date(tiedTs) }),
    );
    const keptIntent = intentRow({ source_id: "intent-b", cursor_ts: tiedTs, created_at: new Date(tiedTs) });
    const droppedIntent = intentRow({ source_id: "intent-a", cursor_ts: tiedTs, created_at: new Date(tiedTs) });
    scriptTransaction({ page: [...activityRows, keptIntent, droppedIntent] });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    expect(result.data.entries).toHaveLength(50);
    expect(result.data.hasMore).toBe(true);
    // The last KEPT row (position 50) is the intent arm — the cursor must say
    // sourceRank=0, never silently coerce to the activity arm's rank.
    expect(result.data.nextCursor).toEqual({
      createdAt: tiedTs,
      sourceRank: 0,
      sourceId: "intent-b",
    });
  });

  it("mints a sourceRank=2 cursor when the last kept row is an agent_activity row", async () => {
    const tiedTs = "2026-07-10T10:00:00.000000Z";
    const rows = Array.from({ length: 51 }, (_, i) =>
      agentActivityRow({
        source_id: String(i).padStart(20, "0"),
        cursor_ts: tiedTs,
        created_at: new Date(tiedTs),
      }),
    );
    scriptTransaction({ page: rows });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextCursor?.sourceRank).toBe(2);
  });
});

describe("getTokenHistory — page-phase failure classification", () => {
  it("SQLSTATE 57014 on the page phase returns the unavailable degraded-success shape", async () => {
    scriptTransaction({ page: new FakeDbError("57014") });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ status: "unavailable", reason: "query_timeout" });
  });

  it("a non-timeout page failure returns a Result error, never the unavailable DTO", async () => {
    scriptTransaction({ page: new FakeDbError("08006") });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    expect(result.ok).toBe(false);
  });
});
