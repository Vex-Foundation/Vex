/**
 * moves-db tests — server-side address resolution + bounded `proj_activity`
 * read, with NO real DB.
 *
 * Mirrors portfolio-db.test.ts (mocked `pg` Client + `db-config` + logger).
 * MOVES is session-scoped only, so the sole address source mocked is
 * `../sessions-db.js` `getSessionWalletScope` (no global inventory / no
 * `listWallets`).
 *
 * Split by domain under test (Card C5, move-only, same pattern as Cards
 * F1/K7/K8: no assertion changes, no coverage loss) once this file crossed
 * the repo's 500-line cap. This anchor covers the core query-shape/scoping
 * behavior; `moves-db-mapping.test.ts` covers the local-symbol-fallback and
 * tolerant-mapper coverage; `moves-db-agent-activity.test.ts` covers the
 * agent_activity swap half; `moves-db-bridge.test.ts` covers the
 * agent_activity bridge half.
 *
 * Security + correctness invariants under test:
 *  - empty session scope → empty DTO (`ok([])`), and NO SQL is ever issued
 *    (fail closed BEFORE query);
 *  - the SELECT binds `wallet_address = ANY($1::text[])` with the resolved
 *    address array (never a renderer-supplied address);
 *  - CROSS-SESSION ISOLATION: a session scoped to wallet A binds ONLY wallet
 *    A's address — wallet B's address never appears in any param;
 *  - STRICT PER-SESSION attribution: the SELECT INNER JOINs
 *    `protocol_executions` on `execution_id` and filters `session_id = $2`
 *    (bound to the session). NULL-execution rows and foreign/NULL-session
 *    rows are excluded at the DB BY THAT QUERY SHAPE — verified structurally
 *    here (query text + param binding), mirroring how the wallet-isolation
 *    test verifies exclusion via binding rather than a live DB filter (this
 *    package mocks `pg`, so no real JOIN runs);
 *  - a failed session-scope read propagates (fail closed);
 *  - the SELECT projects ONLY bounded columns: never params/result or raw
 *    JSONB.
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
  getSessionWalletScope: vi.fn(),
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

vi.mock("../sessions-db.js", () => ({
  getSessionWalletScope: mocks.getSessionWalletScope,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getMovesForSession } = await import("../moves-db.js");

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const WALLET_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const SOL_ADDR = "So11111111111111111111111111111111111111112";

function scopeOk(evmAddr: string | null, solAddr: string | null) {
  return {
    ok: true as const,
    data: {
      evm: evmAddr ? { id: "evm_1", address: evmAddr } : null,
      solana: solAddr ? { id: "sol_1", address: solAddr } : null,
    },
  };
}

/** All bound params across every issued query call, flattened. */
function allBoundParams(): unknown[] {
  return mocks.query.mock.calls.flatMap((call) => {
    const params = call[1];
    return Array.isArray(params) ? params.flat() : [];
  });
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("moves-db getMovesForSession — empty scope (fail closed)", () => {
  it("returns ok([]) and issues NO SQL when the session scope is empty", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(null, null));
    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("propagates a failed session-scope read (fail closed, no SQL)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue({
      ok: false as const,
      error: {
        code: "internal.unexpected",
        domain: "internal",
        message: "boom",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("moves-db getMovesForSession — scoping + binding", () => {
  it("binds the resolved addresses into ANY($1::text[])", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, SOL_ADDR));
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);

    const call = mocks.query.mock.calls[0];
    const sql = String(call?.[0] ?? "");
    expect(sql).toContain("ANY($1::text[])");
    expect(sql).toContain("FROM proj_activity");
    // $1 is the resolved address array (raw, deduped, NOT lowercased).
    const arr = Array.isArray(call?.[1]) ? call?.[1]?.[0] : undefined;
    expect(arr).toEqual([WALLET_A, SOL_ADDR]);
  });

  it("CROSS-SESSION ISOLATION: a session scoped to wallet A never binds wallet B", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);

    const bound = allBoundParams();
    expect(bound).toContain(WALLET_A);
    expect(bound).not.toContain(WALLET_B);
    const arr = Array.isArray(mocks.query.mock.calls[0]?.[1])
      ? mocks.query.mock.calls[0]?.[1]?.[0]
      : undefined;
    expect(arr).toEqual([WALLET_A]);
  });

  it("does NOT lowercase addresses (raw join key preserved)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const bound = allBoundParams();
    expect(bound).toContain(WALLET_A);
    expect(bound).not.toContain(WALLET_A.toLowerCase());
  });

  it("projects ONLY bounded columns and bounded capture-item symbol scalars", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).not.toContain("params");
    expect(sql).not.toContain("result");
    expect(sql).not.toContain("SELECT ci.trade_capture");
    expect(sql).toContain("jsonb_typeof(ci.trade_capture->'inputToken')");
    expect(sql).toContain("LEFT(ci.trade_capture->>'inputToken', 64)");
    expect(sql).toContain("jsonb_typeof(ci.trade_capture->'outputToken')");
    expect(sql).toContain("LEFT(ci.trade_capture->>'outputToken', 64)");
    expect(sql).toContain("LEFT JOIN protocol_capture_items ci");
    expect(sql).toContain("ci.id = a.capture_item_id");
    expect(sql).toContain("ci.execution_id = a.execution_id");
    expect(sql).toContain("LIMIT 50");
  });
});

describe("moves-db getMovesForSession — strict per-session attribution (JOIN)", () => {
  it("excludes NULL-execution rows via an INNER JOIN on execution_id (not LEFT JOIN)", async () => {
    // The INNER JOIN is the DB mechanism that drops proj_activity rows whose
    // execution_id is NULL (externally-detected deposits, historical activity).
    // The mock cannot run the JOIN, so the exclusion is asserted structurally.
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);

    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("JOIN protocol_executions");
    expect(sql).not.toContain("LEFT JOIN protocol_executions");
    expect(sql).toContain("a.execution_id");
  });

  it("excludes foreign/NULL-session rows: filters protocol_executions.session_id = $2 bound to the session", async () => {
    // session_id = $2 (with $2 = the server-resolved session id) is the DB
    // mechanism that drops executions owned by another session or with a NULL
    // session_id (both comparisons evaluate to UNKNOWN → excluded).
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await getMovesForSession(SESSION);
    const call = mocks.query.mock.calls[0];
    const sql = String(call?.[0] ?? "");
    expect(sql).toContain("session_id = $2");
    // $2 is the session id — server-resolved, never renderer-supplied as an
    // address; bound alongside the address array as [$1, $2].
    expect(call?.[1]).toEqual([[WALLET_A], SESSION]);
  });

  it("keeps the wallet-address scope as defense-in-depth alongside the session filter", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, SOL_ADDR));
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await getMovesForSession(SESSION);
    const call = mocks.query.mock.calls[0];
    const sql = String(call?.[0] ?? "");
    // BOTH predicates present: the session attribution AND the wallet allow-list.
    expect(sql).toContain("ANY($1::text[])");
    expect(sql).toContain("session_id = $2");
    const params = call?.[1];
    expect(Array.isArray(params) ? params[0] : undefined).toEqual([WALLET_A, SOL_ADDR]);
    expect(Array.isArray(params) ? params[1] : undefined).toBe(SESSION);
  });

  it("admits and maps a session-attributed row the JOIN returns (happy path post-JOIN)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 42,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "uniswap",
          input_token: "USDC",
          input_token_symbol: "USDC",
          input_amount: "50",
          output_token: "ETH",
          output_token_symbol: "ETH",
          output_amount: "0.02",
          value_usd: "50",
          capture_status: "executed",
          instrument_key: "eth-usdc",
          chain: "ethereum",
          tx_ref: "0xfeed",
          wallet_address: WALLET_A,
          created_at: "2026-06-01T12:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe("success:42");
    expect(result.data[0]?.source).toBe("success");
    expect(result.data[0]?.chain).toBe("ethereum");
    expect(result.data[0]?.txRef).toBe("0xfeed");
    expect(result.data[0]?.walletAddress).toBe(WALLET_A);
    expect(result.data[0]?.productType).toBe("spot");
    expect(result.data[0]?.venue).toBe("uniswap");
    expect(result.data[0]?.inputTokenSymbol).toBe("USDC");
    expect(result.data[0]?.outputTokenSymbol).toBe("ETH");
  });

  it("selects product_type and namespace-as-venue for the chip derivation", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("a.product_type");
    expect(sql).toContain("a.namespace AS venue");
  });

  it("selects wallet_address for the account block-explorer link", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("a.wallet_address");
  });

  it("resolves a local symbol fallback via a bounded scalar subquery against proj_balances (not a JOIN)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM proj_balances b");
    expect(sql).toContain("b.wallet_address = a.wallet_address");
    expect(sql).toContain("b.token_address = a.input_token");
    expect(sql).toContain("b.token_address = a.output_token");
    expect(sql).toContain("b.token_symbol IS NOT NULL");
    // Bounded like every other symbol scalar; a scalar subquery, never a JOIN
    // that could fan out proj_activity rows.
    expect(sql).toContain(`LEFT(MIN(b.token_symbol), ${64})`);
    expect(sql).not.toContain("JOIN proj_balances");
  });

  it("DECLINES ON AMBIGUITY: guards each local-symbol subquery with HAVING COUNT(DISTINCT)=1 and NO nondeterministic LIMIT 1", async () => {
    // The same token_address can be held on multiple chains with different
    // symbols; proj_activity.chain (free-text venue slug) does not map to
    // proj_balances.chain_id, so the lookup cannot be chain-scoped. It must
    // therefore resolve ONLY when the wallet holds exactly one distinct symbol
    // for that address (else NULL → the renderer's truncateAddress fallback).
    // pg is mocked here, so — like the JOIN-isolation tests in this suite —
    // the determinism is asserted STRUCTURALLY on the query text.
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    const havingCount = (
      sql.match(/HAVING COUNT\(DISTINCT b\.token_symbol\) = 1/g) ?? []
    ).length;
    // Exactly the two local-symbol subqueries carry the ambiguity guard…
    expect(havingCount).toBe(2);
    // …and no nondeterministic single-row pick survives anywhere in the query.
    expect(sql).not.toContain("LIMIT 1");
  });
});

describe("moves-db getMovesForSession — DB failures + logging", () => {
  beforeEach(() => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
  });

  it("returns dbUnavailable (domain portfolio) when buildPoolConfig yields null", async () => {
    mocks.buildPoolConfig.mockResolvedValue(null);
    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.domain).toBe("portfolio");
    expect(result.error.code).toBe("internal.unexpected");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns dbError (domain portfolio) when the query throws", async () => {
    mocks.query.mockRejectedValueOnce(new Error("connection reset"));
    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.domain).toBe("portfolio");
    expect(result.error.code).toBe("internal.unexpected");
  });

  it("never logs raw addresses (only counts)", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const logged = mocks.log.info.mock.calls.flat().join(" ");
    expect(logged).not.toContain(WALLET_A);
    expect(logged).toContain("moves=0");
  });
});
