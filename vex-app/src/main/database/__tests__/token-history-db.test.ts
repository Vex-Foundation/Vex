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
 * Security/behavior invariants under test:
 *  - empty inventory → the empty available page, NO SQL issued;
 *  - EVM addresses are lower-cased end-to-end; Solana stays verbatim;
 *  - leg-aware bridge matching (destination-chain leg via a DIFFERENT
 *    numeric chain than the origin `chain` column);
 *  - `wallet_intents` inclusion (executed + hash) and exclusion
 *    (non-address token, wrong network);
 *  - `agent_activity` inclusion (Agent Scan plan §4.7 + Phase 2 bridges):
 *    a SWAP row matches its exact chain_id + token address; a BRIDGE logical
 *    row (`event_role = 'bridge_fill_expected'`) matches LEG-AWARE (origin
 *    from_chain_id+token_in OR dest to_chain_id+token_out) and maps to a
 *    `kind: "bridge"` entry with legs/status/route; status collapse
 *    (definitively_failed → failed), failureCode passthrough, pending/failed
 *    rows surfaced (not just confirmed);
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

describe("getTokenHistory — entry mapping", () => {
  it("maps a matched spot activity row to a swap entry with tagged amounts", async () => {
    scriptTransaction({ page: [activityRow()] });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    expect(result.data.entries).toHaveLength(1);
    const entry = result.data.entries[0];
    expect(entry?.kind).toBe("swap");
    if (entry?.kind === "swap") {
      expect(entry.input.amount).toEqual({ value: "1.5", unitProvenance: "human" });
      // C35: a legacy (proj_activity) leg's USD figure is tagged "recorded" —
      // it never carries the agent_activity quote-time "estimated" tag.
      expect(entry.input.valueUsd).toEqual({ value: "100.00", usdProvenance: "recorded" });
      expect(entry.output.valueUsd).toEqual({ value: "100.00", usdProvenance: "recorded" });
      expect(entry.txRefs).toEqual([{ chainId: BASE_CHAIN_ID, ref: "0xhash1" }]);
      expect(entry.status).toBeNull();
      expect(entry.failureCode).toBeNull();
    }
  });

  it("maps a bridge row with a destination leg on a DIFFERENT numeric chain than the origin", async () => {
    scriptTransaction({
      page: [
        activityRow({
          product_type: "bridge",
          chain: String(BASE_CHAIN_ID),
          dest_chain: String(ARBITRUM_CHAIN_ID),
        }),
      ],
    });
    const result = await getTokenHistory({
      chainId: ARBITRUM_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    expect(entry?.kind).toBe("bridge");
    if (entry?.kind === "bridge") {
      expect(entry.originChain).toBe(String(BASE_CHAIN_ID));
      expect(entry.destinationChain).toBe(String(ARBITRUM_CHAIN_ID));
      // Shares the same legacy leg-construction code path as the swap
      // mapping above — "recorded" provenance either way (C35).
      expect(entry.input.valueUsd).toEqual({ value: "100.00", usdProvenance: "recorded" });
    }
  });

  it("maps an executed wallet_intents row to a transfer entry", async () => {
    scriptTransaction({ page: [intentRow()] });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    expect(entry?.kind).toBe("transfer");
    if (entry?.kind === "transfer") {
      expect(entry.toAddress).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      expect(entry.amount).toEqual({ value: "5", unitProvenance: "human" });
    }
  });

  it("tags a bare atomic-integer amount as unknown, never human (unit-guessing heuristic retired — Agent Scan §4.7)", async () => {
    scriptTransaction({ page: [activityRow({ input_amount: "1500000000000000000" })] });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    const entry = result.data.entries[0];
    if (entry?.kind === "swap") {
      expect(entry.input.amount.unitProvenance).toBe("unknown");
    }
  });
});

describe("getTokenHistory — agent_activity arm (Agent Scan §4.7)", () => {
  it("matches by EXACT chain_id (bound as a plain int, no alias-string dance) and either leg's token address", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    const { sql, params } = pageQueryCall();
    expect(sql).toContain("FROM agent_activity aa");
    expect(sql).toContain("aa.chain_id = $");
    expect(sql).toContain("aa.event_role = 'swap'");
    expect(sql).toContain("aa.token_in_address");
    expect(sql).toContain("aa.token_out_address");
    expect(params).toContain(BASE_CHAIN_ID);
  });

  it("carries a defensive dedupe guard on the legacy activity half (mirrors the engine feed's own posture)", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    const { sql } = pageQueryCall();
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("agent_activity aa2");
    expect(sql).toContain("aa2.protocol_execution_id = a.execution_id");
  });

  it("SELECTs the raw executed legs + decimals (never a blind COALESCE of executed/requested — C20)", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    const { sql } = pageQueryCall();
    expect(sql).toContain("aa.executed_amount_in_raw");
    expect(sql).toContain("aa.executed_amount_out_raw");
    expect(sql).toContain("aa.token_in_decimals");
    expect(sql).toContain("aa.token_out_decimals");
    expect(sql).toContain("aa.amount_in_human AS input_amount");
    expect(sql).toContain("aa.amount_out_human AS output_amount");
    expect(sql).not.toContain("COALESCE(aa.executed_amount_in_human");
    expect(sql).not.toContain("COALESCE(aa.executed_amount_out_human");
  });

  it("maps a confirmed agent_activity row's amount from raw+decimals — NEVER the quote-time requested echo, even when present (Codex final review C20)", async () => {
    scriptTransaction({ page: [agentActivityRow()] });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    expect(entry?.kind).toBe("swap");
    if (entry?.kind === "swap") {
      expect(entry.status).toBe("confirmed");
      expect(entry.failureCode).toBeNull();
      expect(entry.captureStatus).toBeNull();
      expect(entry.tradeSide).toBeNull();
      // Computed from raw+decimals (50000000/1e6="50", 2000000000000000000/1e18="2")
      // — the fixture's requested echo ("999") never appears.
      expect(entry.input.amount).toEqual({ value: "50", unitProvenance: "human" });
      expect(entry.output.amount).toEqual({ value: "2", unitProvenance: "human" });
      expect(entry.input.amount.value).not.toBe("999");
      expect(entry.output.amount.value).not.toBe("999");
      // C35: usd_in/out_est is tagged "estimated" — a quote-time price,
      // never re-derived from the settled fill, even on a confirmed row.
      expect(entry.input.valueUsd).toEqual({ value: "50.00", usdProvenance: "estimated" });
      expect(entry.output.valueUsd).toEqual({ value: "50.00", usdProvenance: "estimated" });
      expect(entry.txRefs).toEqual([{ chainId: BASE_CHAIN_ID, ref: "0xagenttx" }]);
    }
  });

  it("tags valueUsd 'estimated' regardless of status — unlike the executed amount, there is no settlement-time USD repricing to fall back to (C35)", async () => {
    scriptTransaction({
      page: [agentActivityRow({ status: "definitively_failed", failure_code: "slippage" })],
    });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    const entry = result.data.entries[0];
    if (entry?.kind === "swap") {
      expect(entry.status).toBe("failed");
      // The amount honestly goes to null on a failed row (C20)...
      expect(entry.input.amount).toEqual({ value: null, unitProvenance: "unknown" });
      // ...but the USD figure is STILL tagged "estimated", not silently
      // dropped or reclassified — it was always a quote-time number and
      // stays labeled as such.
      expect(entry.input.valueUsd).toEqual({ value: "50.00", usdProvenance: "estimated" });
    }
  });

  it("computes a confirmed 18-decimal wei-scale executed amount BigInt-safely (never via Number/parseFloat, which would lose precision)", async () => {
    scriptTransaction({
      page: [
        agentActivityRow({
          // Well past Number.MAX_SAFE_INTEGER (2^53-1) — a Number-based
          // conversion would silently round it.
          executed_amount_in_raw: "1234567890123456789",
          token_in_decimals: 18,
        }),
      ],
    });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    const entry = result.data.entries[0];
    if (entry?.kind === "swap") {
      expect(entry.input.amount).toEqual({
        value: "1.234567890123456789",
        unitProvenance: "human",
      });
    }
  });

  it("collapses a definitively_failed row to status='failed', surfaces its failureCode, and shows NO amount (a failed attempt's legs are moot — C20)", async () => {
    scriptTransaction({
      page: [agentActivityRow({ status: "definitively_failed", failure_code: "slippage", tx_ref: null })],
    });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    const entry = result.data.entries[0];
    if (entry?.kind === "swap") {
      expect(entry.status).toBe("failed");
      expect(entry.failureCode).toBe("slippage");
      expect(entry.txRefs).toEqual([]);
      // Never the requested echo ("999") either.
      expect(entry.input.amount).toEqual({ value: null, unitProvenance: "unknown" });
      expect(entry.output.amount).toEqual({ value: null, unitProvenance: "unknown" });
    }
  });

  it("surfaces a pending (not-yet-broadcast-confirmed) agent_activity row with the REQUESTED echo, not just confirmed fills", async () => {
    scriptTransaction({
      page: [
        agentActivityRow({
          status: "pending",
          tx_ref: null,
          input_amount: "999",
          executed_amount_in_raw: null,
        }),
      ],
    });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    expect(result.data.entries).toHaveLength(1);
    const entry = result.data.entries[0];
    if (entry?.kind === "swap") {
      expect(entry.status).toBe("pending");
      // Nothing has settled yet — the ONLY honest value is the requested echo.
      expect(entry.input.amount).toEqual({ value: "999", unitProvenance: "human" });
    }
  });

  it("falls back to null status for an unrecognized/malformed status value (fail closed)", async () => {
    scriptTransaction({ page: [agentActivityRow({ status: "some_future_value" })] });
    const result = await getTokenHistory({
      chainId: BASE_CHAIN_ID,
      tokenAddress: TOKEN_ADDR_LOWER,
      cursor: null,
    });
    if (!result.ok || result.data.status !== "available") throw new Error("expected available");
    const entry = result.data.entries[0];
    if (entry?.kind === "swap") {
      expect(entry.status).toBeNull();
    }
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

describe("getTokenHistory — agent_activity bridge (Agent Scan Phase 2)", () => {
  function bridgeAgentRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      source_kind: "agent_activity",
      source_rank: 2,
      source_id: "00000000000000000030",
      created_at: new Date("2026-07-20T10:00:00.000Z"),
      cursor_ts: "2026-07-20T10:00:00.000000Z",
      namespace: "khalani",
      product_type: "bridge",
      trade_side: null,
      chain: "base", // origin (SQL sets chain = from_chain for bridges)
      dest_chain: "arbitrum", // destination (to_chain)
      input_token_address: TOKEN_ADDR_LOWER,
      input_amount: "2.0",
      output_token_address: "0xUSDCarb",
      output_amount: "1.99",
      input_value_usd: "2.00",
      output_value_usd: "1.99",
      unit_price_usd: null,
      capture_status: null,
      tx_ref: "0xfill",
      input_token_symbol: "USDC",
      input_token_local_symbol: null,
      output_token_symbol: "USDC",
      output_token_local_symbol: null,
      to_address: null,
      status: "confirmed",
      failure_code: null,
      executed_amount_in_raw: "2000000",
      executed_amount_out_raw: "1988000",
      token_in_decimals: 6,
      token_out_decimals: 6,
      provider_order_id: "ord_1",
      legs: [
        { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xdep", status: "confirmed", failureCode: null },
        { role: "bridge_fill_expected", chainId: 42161, chainFamily: "eip155", txHash: "0xfill", status: "confirmed", failureCode: null },
      ],
      last_checked_at: "2026-07-20T10:05:00.000Z",
      ...overrides,
    };
  }

  it("the agent_activity half surfaces bridge logical rows LEG-AWARE + product_type from kind + legs subquery", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({ chainId: BASE_CHAIN_ID, tokenAddress: TOKEN_ADDR_LOWER, cursor: null });
    const pageCall = mocks.query.mock.calls[2];
    const sql = String(pageCall?.[0] ?? "");
    expect(sql).toContain("aa.event_role IN ('swap', 'bridge_fill_expected')");
    expect(sql).toContain("CASE aa.kind WHEN 'bridge' THEN 'bridge' ELSE 'spot' END AS product_type");
    // Leg-aware bridge match: origin leg (from_chain_id + token_in) OR dest leg.
    expect(sql).toContain("aa.from_chain_id = $");
    expect(sql).toContain("aa.to_chain_id = $");
    // R12: last successful sweep check surfaced for the tracking-delay UX.
    expect(sql).toContain("aa.last_checked_at");
    // Legs aggregation (no LIMIT — OWNER RULE).
    expect(sql).toContain("jsonb_agg(jsonb_build_object");
    // Bounded to the legs SUBQUERY — the outer pagination LIMIT after the UNION
    // is legitimate and must not trip this.
    const legsSubquery = sql.slice(sql.indexOf("jsonb_agg"), sql.indexOf(") END AS legs"));
    expect(legsSubquery).not.toMatch(/\bLIMIT\b/);
  });

  it("maps a CONFIRMED bridge → kind:'bridge', from→to, executed amounts, legs, providerOrderId, basis 'executed'", async () => {
    scriptTransaction({ page: [bridgeAgentRow()] });
    const result = await getTokenHistory({ chainId: BASE_CHAIN_ID, tokenAddress: TOKEN_ADDR_LOWER, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    expect(entry?.kind).toBe("bridge");
    if (entry?.kind !== "bridge") return;
    expect(entry.originChain).toBe("base");
    expect(entry.destinationChain).toBe("arbitrum");
    expect(entry.venue).toBe("khalani");
    expect(entry.status).toBe("confirmed");
    expect(entry.providerOrderId).toBe("ord_1");
    expect(entry.amountBasis).toBe("executed");
    // executed 2000000/10^6 = 2 ; 1988000/10^6 = 1.988 (NOT the 1.99 quote).
    expect(entry.input.amount).toEqual({ value: "2", unitProvenance: "human" });
    expect(entry.output.amount).toEqual({ value: "1.988", unitProvenance: "human" });
    // USD is always a quote-time estimate for agent_activity (C35).
    expect(entry.input.valueUsd.usdProvenance).toBe("estimated");
    expect(entry.legs).toHaveLength(2);
    expect(entry.legs[1]?.role).toBe("bridge_fill_expected");
    // Per-leg hashes ride `legs`; the top-level txRefs stays empty for bridges.
    expect(entry.txRefs).toEqual([]);
    // R12: the last successful sweep check is surfaced for the tracking-delay UX.
    expect(entry.lastCheckedAt).toBe("2026-07-20T10:05:00.000Z");
  });

  it("maps a PENDING bridge → estimated (quoted) amounts, status pending, fill leg hashless but preserved", async () => {
    scriptTransaction({
      page: [
        bridgeAgentRow({
          status: "pending",
          tx_ref: null,
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          legs: [
            { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xdep", status: "confirmed", failureCode: null },
            { role: "bridge_fill_expected", chainId: 42161, chainFamily: "eip155", txHash: null, status: "pending", failureCode: null },
          ],
        }),
      ],
    });
    const result = await getTokenHistory({ chainId: BASE_CHAIN_ID, tokenAddress: TOKEN_ADDR_LOWER, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    if (entry?.kind !== "bridge") return;
    expect(entry.status).toBe("pending");
    expect(entry.amountBasis).toBe("estimated");
    expect(entry.input.amount).toEqual({ value: "2.0", unitProvenance: "human" }); // the QUOTE
    expect(entry.legs).toHaveLength(2);
    expect(entry.legs[1]?.txHash).toBeNull();
  });

  it("maps a refunded bridge → status failed + failureCode 'bridge_refunded' (money back ≠ success), no amount", async () => {
    scriptTransaction({
      page: [
        bridgeAgentRow({
          status: "definitively_failed",
          failure_code: "bridge_refunded",
          tx_ref: null,
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          legs: [
            { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xdep", status: "confirmed", failureCode: null },
            { role: "bridge_fill_expected", chainId: 42161, chainFamily: "eip155", txHash: null, status: "definitively_failed", failureCode: "bridge_refunded" },
            { role: "bridge_refund", chainId: 8453, chainFamily: "eip155", txHash: "0xrefund", status: "confirmed", failureCode: null },
          ],
        }),
      ],
    });
    const result = await getTokenHistory({ chainId: BASE_CHAIN_ID, tokenAddress: TOKEN_ADDR_LOWER, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    if (entry?.kind !== "bridge") return;
    expect(entry.status).toBe("failed");
    expect(entry.failureCode).toBe("bridge_refunded");
    expect(entry.amountBasis).toBeNull();
    expect(entry.input.amount).toEqual({ value: null, unitProvenance: "unknown" });
    expect(entry.legs).toHaveLength(3);
    expect(entry.legs[2]?.role).toBe("bridge_refund");
    expect(entry.legs[2]?.txHash).toBe("0xrefund");
  });
});
