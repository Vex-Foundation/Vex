/**
 * moves-db tests — server-side address resolution + bounded `proj_activity`
 * read, with NO real DB.
 *
 * Mirrors portfolio-db.test.ts (mocked `pg` Client + `db-config` + logger).
 * MOVES is session-scoped only, so the sole address source mocked is
 * `../sessions-db.js` `getSessionWalletScope` (no global inventory / no
 * `listWallets`).
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
 *  - the tolerant mapper passes through a row with `trade_side = null`,
 *    `capture_status = 'filled'`, and `value_usd = null`;
 *  - a failed session-scope read propagates (fail closed);
 *  - the SELECT projects ONLY bounded columns: never params/result or raw
 *    JSONB; token symbols are type-checked, length-bounded scalar
 *    extractions from the exact capture item, then re-validated in JS by the
 *    shared ASCII-allowlist sanitizer (trims whitespace, drops control
 *    characters/bidi controls/zero-width characters/Unicode confusables).
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

describe("moves-db getMovesForSession — local symbol fallback mapping", () => {
  it("maps and sanitizes a resolved local symbol on either leg", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: "7jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK",
          input_token_symbol: null,
          input_token_local_symbol: "  wif  ",
          input_amount: "100",
          output_token: "AnotherMint1111111111111111111111111111111",
          output_token_symbol: null,
          output_token_local_symbol: null,
          output_amount: "1",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sanitized (trimmed) — the raw column value itself is never echoed.
    expect(result.data[0]?.inputTokenLocalSymbol).toBe("wif");
    // Absent local symbol (no proj_balances row matched) → null, not "".
    expect(result.data[0]?.outputTokenLocalSymbol).toBeNull();
  });

  it("drops a local symbol carrying Unicode confusables (same sanitizer as the captured symbol)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 12,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: "ScamMint111111111111111111111111111111111",
          input_token_symbol: null,
          // Cyrillic Es (U+0405) standing in for Latin S.
          input_token_local_symbol: "ЅOL",
          input_amount: "1",
          output_token: null,
          output_token_symbol: null,
          output_token_local_symbol: null,
          output_amount: null,
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputTokenLocalSymbol).toBeNull();
  });
});

describe("moves-db getMovesForSession — tolerant mapping", () => {
  it("trims valid capture symbols and drops symbols containing control characters", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 6,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: SOL_ADDR,
          input_token_symbol: "  SOL  ",
          input_amount: "100",
          output_token: "7jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK",
          output_token_symbol: "BAD\nSYMBOL",
          output_amount: "1",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputTokenSymbol).toBe("SOL");
    expect(result.data[0]?.outputTokenSymbol).toBeNull();
  });

  it("drops a captured symbol containing Unicode confusables (e.g. a fake SOL claim)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: "ScamMint111111111111111111111111111111111",
          // Cyrillic Es (U+0405) standing in for Latin S — never surfaces as "SOL".
          input_token_symbol: "ЅOL",
          input_amount: "1",
          output_token: SOL_ADDR,
          output_token_symbol: "SOL",
          output_amount: "1",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputTokenSymbol).toBeNull();
    expect(result.data[0]?.outputTokenSymbol).toBe("SOL");
  });

  it("maps a tolerant row (trade_side=null, capture_status='filled', value_usd=null)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          source: "success",
          trade_side: null,
          product_type: null,
          venue: null,
          input_token: "USDC",
          input_token_symbol: null,
          input_amount: "100",
          output_token: "SOL",
          output_token_symbol: null,
          output_amount: "1.2",
          value_usd: null,
          capture_status: "filled",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          wallet_address: SOL_ADDR,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        id: "success:7",
        source: "success",
        tradeSide: null,
        productType: null,
        venue: null,
        inputToken: "USDC",
        inputTokenSymbol: null,
        inputTokenLocalSymbol: null,
        inputAmount: "100",
        outputToken: "SOL",
        outputTokenSymbol: null,
        outputTokenLocalSymbol: null,
        outputAmount: "1.2",
        valueUsd: null,
        captureStatus: "filled",
        status: null,
        failureCode: null,
        instrumentKey: null,
        chain: "solana",
        txRef: null,
        walletAddress: SOL_ADDR,
        createdAt: "2026-05-21T10:00:00.000Z",
      },
    ]);
  });

  it("maps a bridge row (product_type bridge, venue relay)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 8,
          source: "success",
          trade_side: null,
          product_type: "bridge",
          venue: "relay",
          input_token: "ETH",
          input_token_symbol: "ETH",
          input_amount: "0.001714",
          output_token: "ETH",
          output_token_symbol: "ETH",
          output_amount: "0.001693",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "4663",
          tx_ref: "0xbridge",
          created_at: "2026-07-05T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.productType).toBe("bridge");
    expect(row?.venue).toBe("relay");
    expect(row?.inputToken).toBe("ETH");
    expect(row?.inputTokenSymbol).toBe("ETH");
    expect(row?.inputAmount).toBe("0.001714");
    expect(row?.outputAmount).toBe("0.001693");
  });

  it("coerces a NUMERIC value_usd string to a finite number and a Date created_at to ISO", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    const at = new Date("2026-05-21T10:00:00.000Z");
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 9,
          source: "success",
          trade_side: "buy",
          input_token: "USDC",
          input_amount: "100",
          output_token: "ETH",
          output_amount: "0.03",
          value_usd: "123.45",
          capture_status: "executed",
          instrument_key: "eth-usdc",
          chain: "ethereum",
          tx_ref: "0xdeadbeef",
          created_at: at,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.valueUsd).toBeCloseTo(123.45, 4);
    expect(row?.createdAt).toBe("2026-05-21T10:00:00.000Z");
    expect(row?.chain).toBe("ethereum");
    expect(row?.txRef).toBe("0xdeadbeef");
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

describe("moves-db getMovesForSession — agent_activity half (Agent Scan §4.7)", () => {
  it("unions the agent_activity table, scoped to session_id + wallet + event_role='swap', with a dedupe guard", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM agent_activity aa");
    expect(sql).toContain("aa.wallet_address = ANY($1::text[])");
    expect(sql).toContain("aa.session_id = $2");
    expect(sql).toContain("aa.event_role = 'swap'");
    // Defensive dedupe guard on the legacy half (mirrors the engine feed's
    // own belt-and-suspenders posture — a no-op today since capture:"none"
    // means the two sources never share an execution id).
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("agent_activity aa");
    expect(sql).toContain("aa.protocol_execution_id = e.id");
    // Reuses the SAME two bound params as the legacy half — no new params.
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([[WALLET_A], SESSION]);
  });

  it("SELECTs the raw executed legs + decimals (never a blind COALESCE of executed/requested — C20)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("aa.executed_amount_in_raw");
    expect(sql).toContain("aa.executed_amount_out_raw");
    expect(sql).toContain("aa.token_in_decimals");
    expect(sql).toContain("aa.token_out_decimals");
    expect(sql).toContain("aa.amount_in_human AS input_amount");
    expect(sql).toContain("aa.amount_out_human AS output_amount");
    expect(sql).not.toContain("COALESCE(aa.executed_amount_in_human");
    expect(sql).not.toContain("COALESCE(aa.executed_amount_out_human");
  });

  it("maps a pending agent_activity row to the REQUESTED echo (nothing has settled yet)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          trade_side: null,
          product_type: "spot",
          venue: "kyberswap",
          input_token: "0xInputToken",
          input_token_symbol: "USDC",
          input_token_local_symbol: null,
          input_amount: "50",
          output_token: "0xOutputToken",
          output_token_symbol: "WETH",
          output_token_local_symbol: null,
          output_amount: null,
          value_usd: "50",
          capture_status: null,
          instrument_key: null,
          chain: "8453",
          tx_ref: "0xpendingtx",
          wallet_address: WALLET_A,
          created_at: "2026-07-10T10:00:00.000Z",
          source: "agent_activity",
          status: "pending",
          failure_code: null,
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          token_in_decimals: 6,
          token_out_decimals: 18,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toEqual({
      id: "agent_activity:5",
      source: "agent_activity",
      tradeSide: null,
      productType: "spot",
      venue: "kyberswap",
      inputToken: "0xInputToken",
      inputTokenSymbol: "USDC",
      inputTokenLocalSymbol: null,
      inputAmount: "50",
      outputToken: "0xOutputToken",
      outputTokenSymbol: "WETH",
      outputTokenLocalSymbol: null,
      outputAmount: null,
      valueUsd: 50,
      captureStatus: null,
      status: "pending",
      failureCode: null,
      instrumentKey: null,
      chain: "8453",
      txRef: "0xpendingtx",
      walletAddress: WALLET_A,
      createdAt: "2026-07-10T10:00:00.000Z",
    });
  });

  it("maps a CONFIRMED row's amount from raw+decimals — NEVER the quote-time requested echo, even when present (Codex final review C20)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 8,
          trade_side: null,
          product_type: "spot",
          venue: "kyberswap",
          input_token: "0xInputToken",
          input_token_symbol: "USDC",
          input_token_local_symbol: null,
          // The requested (quote-time) echo is DELIBERATELY different from
          // the executed amount below — if the mapper ever fell back to
          // this, the test would catch it.
          input_amount: "999",
          output_token: "0xOutputToken",
          output_token_symbol: "WETH",
          output_token_local_symbol: null,
          output_amount: "999",
          value_usd: "50",
          capture_status: null,
          instrument_key: null,
          chain: "8453",
          tx_ref: "0xconfirmedtx",
          wallet_address: WALLET_A,
          created_at: "2026-07-10T10:00:00.000Z",
          source: "agent_activity",
          status: "confirmed",
          failure_code: null,
          executed_amount_in_raw: "50000000",
          executed_amount_out_raw: "1500000000000000000",
          token_in_decimals: 6,
          token_out_decimals: 18,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 50000000 / 10^6 = 50 (whole number — no decimal point; C27 covers the
    // renderer side of this). 1500000000000000000 / 10^18 = 1.5.
    expect(result.data[0]?.inputAmount).toBe("50");
    expect(result.data[0]?.outputAmount).toBe("1.5");
    expect(result.data[0]?.inputAmount).not.toBe("999");
  });

  it("computes a confirmed 18-decimal wei-scale executed amount BigInt-safely (never via Number/parseFloat, which would lose precision)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    // 1234567890123456789 wei is well past Number.MAX_SAFE_INTEGER (2^53-1)
    // — a Number-based conversion would silently round it.
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 9,
          trade_side: null,
          product_type: "spot",
          venue: "uniswap",
          input_token: "0xIn",
          input_token_symbol: null,
          input_token_local_symbol: null,
          input_amount: null,
          output_token: "0xOut",
          output_token_symbol: null,
          output_token_local_symbol: null,
          output_amount: null,
          value_usd: null,
          capture_status: null,
          instrument_key: null,
          chain: "1",
          tx_ref: "0xbig",
          wallet_address: WALLET_A,
          created_at: "2026-07-10T10:00:00.000Z",
          source: "agent_activity",
          status: "confirmed",
          failure_code: null,
          executed_amount_in_raw: "1234567890123456789",
          executed_amount_out_raw: null,
          token_in_decimals: 18,
          token_out_decimals: null,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputAmount).toBe("1.234567890123456789");
  });

  it("maps a definitively_failed row to status='failed' with its failureCode and NO amount (a failed attempt's legs are moot — C20)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 6,
          trade_side: null,
          product_type: "spot",
          venue: "uniswap",
          input_token: "0xIn",
          input_token_symbol: null,
          input_token_local_symbol: null,
          input_amount: "10",
          output_token: "0xOut",
          output_token_symbol: null,
          output_token_local_symbol: null,
          output_amount: null,
          value_usd: null,
          capture_status: null,
          instrument_key: null,
          chain: "1",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-07-10T11:00:00.000Z",
          source: "agent_activity",
          status: "definitively_failed",
          failure_code: "slippage",
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          token_in_decimals: null,
          token_out_decimals: null,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.status).toBe("failed");
    expect(result.data[0]?.failureCode).toBe("slippage");
    expect(result.data[0]?.txRef).toBeNull();
    // Never the requested echo ("10") either — a failed attempt shows no amount.
    expect(result.data[0]?.inputAmount).toBeNull();
    expect(result.data[0]?.outputAmount).toBeNull();
  });

  it("falls back to null status for an unrecognized/malformed status value (fail closed, never a parse-breaking value)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          trade_side: null,
          product_type: "spot",
          venue: "kyberswap",
          input_token: null,
          input_token_symbol: null,
          input_token_local_symbol: null,
          input_amount: null,
          output_token: null,
          output_token_symbol: null,
          output_token_local_symbol: null,
          output_amount: null,
          value_usd: null,
          capture_status: null,
          instrument_key: null,
          chain: "1",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-07-10T11:00:00.000Z",
          source: "agent_activity",
          status: "some_future_value",
          failure_code: null,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.status).toBeNull();
  });

  it("prefixes ids by source so agent_activity and legacy rows can never collide as list keys", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: "USDC",
          input_token_symbol: null,
          input_amount: "1",
          output_token: "SOL",
          output_token_symbol: null,
          output_amount: "1",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-07-10T09:00:00.000Z",
        },
        {
          id: 1,
          trade_side: null,
          product_type: "spot",
          venue: "kyberswap",
          input_token: "0xIn",
          input_token_symbol: null,
          input_amount: "1",
          output_token: "0xOut",
          output_token_symbol: null,
          output_amount: "1",
          value_usd: null,
          capture_status: null,
          instrument_key: null,
          chain: "1",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-07-10T09:00:00.000Z",
          source: "agent_activity",
          status: "pending",
          failure_code: null,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.map((m) => m.id);
    expect(ids).toEqual(["success:1", "agent_activity:1"]);
    expect(new Set(ids).size).toBe(2);
  });
});
