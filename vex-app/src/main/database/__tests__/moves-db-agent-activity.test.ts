/**
 * moves-db tests — the `agent_activity` swap half (Agent Scan §4.7), split
 * out of `moves-db.test.ts` by domain under test (Card C5, move-only, same
 * pattern as Cards F1/K7/K8: no assertion changes, no coverage loss) once
 * the parent file crossed the repo's 500-line cap. Mirrors
 * `moves-db.test.ts`'s own mock setup (mocked `pg`/`db-config`/
 * `sessions-db`/logger) — deliberately NOT sharing boilerplate across files.
 *
 * W5/R5 lend/prediction coverage for this same half lives in the sibling
 * `moves-db-lend-prediction.test.ts` (K8's own split, kept separate).
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

describe("moves-db getMovesForSession — agent_activity half (Agent Scan §4.7)", () => {
  it("unions the agent_activity table, scoped to session_id + wallet + swap/bridge logical rows, with a dedupe guard", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM agent_activity aa");
    expect(sql).toContain("aa.wallet_address = ANY($1::text[])");
    expect(sql).toContain("aa.session_id = $2");
    // Swap rows + bridge LOGICAL rows + any lend/prediction row (W5, migration
    // 049) — allowance/deposit/observed-fill/refund siblings (kind='swap'/
    // 'bridge' only) ride `legs`, never a ledger row.
    expect(sql).toContain("aa.event_role = 'swap'");
    expect(sql).toContain("aa.event_role = 'bridge_fill_expected'");
    expect(sql).toContain("aa.kind IN ('lend', 'prediction')");
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
          activity_kind: "swap",
          event_role: "swap",
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
      fromChain: null,
      toChain: null,
      providerOrderId: null,
      amountBasis: null,
      legs: [],
      lastCheckedAt: null,
      // The real canonical vocabulary: `productType: "spot"` above is the
      // legacy derivation this seam is meant to retire.
      activityKind: "swap",
      eventRole: "swap",
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
