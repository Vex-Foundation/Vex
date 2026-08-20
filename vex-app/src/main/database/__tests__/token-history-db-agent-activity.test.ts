/**
 * token-history-db tests — the `agent_activity` SWAP arm (Agent Scan §4.7),
 * split out of `token-history-db.test.ts` by domain under test (Card C5,
 * move-only, same pattern as Cards F1/K7/K8: no assertion changes, no
 * coverage loss) once the parent file crossed the repo's 500-line cap.
 * Mirrors `token-history-db.test.ts`'s own mock setup (mocked
 * `pg`/`db-config`/`@vex-lib/wallet.js`/logger) — deliberately NOT sharing
 * boilerplate across files.
 *
 * W5/R5 lend/prediction coverage for this same arm lives in the sibling
 * `token-history-db-lend-prediction.test.ts` (K8's own split, kept
 * separate).
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

describe("getTokenHistory - agent_activity arm (Agent Scan §4.7)", () => {
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

  it("SELECTs the raw executed legs + decimals (never a blind COALESCE of executed/requested - C20)", async () => {
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

  it("maps a confirmed agent_activity row's amount from raw+decimals - NEVER the quote-time requested echo, even when present (Codex final review C20)", async () => {
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

  it("tags valueUsd 'estimated' regardless of status - unlike the executed amount, there is no settlement-time USD repricing to fall back to (C35)", async () => {
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

  it("collapses a definitively_failed row to status='failed', surfaces its failureCode, and shows NO amount (a failed attempt's legs are moot - C20)", async () => {
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
