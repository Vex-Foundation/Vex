/**
 * moves-db tests — the `agent_activity` BRIDGE half (Agent Scan Phase 2),
 * split out of `moves-db.test.ts` by domain under test (Card C5, move-only,
 * same pattern as Cards F1/K7/K8: no assertion changes, no coverage loss)
 * once the parent file crossed the repo's 500-line cap. Mirrors
 * `moves-db.test.ts`'s own mock setup (mocked `pg`/`db-config`/
 * `sessions-db`/logger) — deliberately NOT sharing boilerplate across files.
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

describe("moves-db getMovesForSession — agent_activity bridge (Agent Scan Phase 2)", () => {
  it("surfaces the bridge LOGICAL row (event_role IN swap/bridge_fill_expected), product_type from kind, route + legs", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    // Only the swap row + the bridge logical row + lend/prediction rows are
    // ledger rows (swap/bridge siblings ride legs).
    expect(sql).toContain("aa.event_role = 'swap'");
    expect(sql).toContain("aa.event_role = 'bridge_fill_expected'");
    expect(sql).toContain("aa.kind IN ('lend', 'prediction')");
    expect(sql).toContain("WHEN 'bridge' THEN 'bridge'");
    expect(sql).toContain("WHEN 'lend' THEN 'lend'");
    expect(sql).toContain("WHEN 'prediction' THEN 'prediction'");
    expect(sql).toContain("ELSE 'spot'");
    // Route endpoints + provider order id + legs aggregation (NO LIMIT — OWNER RULE).
    expect(sql).toContain("aa.from_chain_slug");
    expect(sql).toContain("aa.to_chain_slug");
    expect(sql).toContain("aa.provider_order_id");
    // R12: last successful sweep check surfaced for the tracking-delay UX.
    expect(sql).toContain("aa.last_checked_at");
    expect(sql).toContain("jsonb_agg(jsonb_build_object");
    expect(sql).toContain("leg.protocol_execution_id = aa.protocol_execution_id");
    // Bounded to the legs SUBQUERY — the outer pagination LIMIT after the UNION
    // is legitimate and must not trip this.
    const legsSubquery = sql.slice(sql.indexOf("jsonb_agg"), sql.indexOf(") END AS legs"));
    expect(legsSubquery).not.toMatch(/\bLIMIT\b/);
    // Reuses the SAME two params — no new binds.
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([[WALLET_A], SESSION]);
  });

  it("maps a CONFIRMED bridge (executed evidence) → executed amounts, from→to, legs, providerOrderId, basis 'executed'", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 30,
          trade_side: null,
          product_type: "bridge",
          venue: "khalani",
          input_token: "0xUSDCbase",
          input_token_symbol: "USDC",
          input_token_local_symbol: null,
          input_amount: "2.0",
          output_token: "0xUSDCarb",
          output_token_symbol: "USDC",
          output_token_local_symbol: null,
          output_amount: "1.99",
          value_usd: "2.0",
          capture_status: null,
          instrument_key: null,
          chain: "arbitrum",
          tx_ref: "0xfill",
          wallet_address: WALLET_A,
          created_at: "2026-07-20T10:00:00.000Z",
          source: "agent_activity",
          status: "confirmed",
          failure_code: null,
          executed_amount_in_raw: "2000000",
          executed_amount_out_raw: "1988000",
          token_in_decimals: 6,
          token_out_decimals: 6,
          from_chain: "base",
          to_chain: "arbitrum",
          provider_order_id: "ord_1",
          legs: [
            { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xdep", status: "confirmed", failureCode: null },
            { role: "bridge_fill_expected", chainId: 42161, chainFamily: "eip155", txHash: "0xfill", status: "confirmed", failureCode: null },
          ],
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.productType).toBe("bridge");
    expect(row?.venue).toBe("khalani");
    expect(row?.fromChain).toBe("base");
    expect(row?.toChain).toBe("arbitrum");
    expect(row?.providerOrderId).toBe("ord_1");
    expect(row?.amountBasis).toBe("executed");
    expect(row?.inputAmount).toBe("2"); // executed 2000000 / 10^6
    expect(row?.outputAmount).toBe("1.988"); // executed, NOT the 1.99 quote
    expect(row?.legs).toHaveLength(2);
    expect(row?.legs[1]?.role).toBe("bridge_fill_expected");
    expect(row?.legs[1]?.txHash).toBe("0xfill");
  });

  it("maps a PENDING bridge → quoted amounts labelled 'estimated' (never blanked)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 31,
          trade_side: null,
          product_type: "bridge",
          venue: "relay",
          input_token: "0xETHbase",
          input_token_symbol: "ETH",
          input_token_local_symbol: null,
          input_amount: "0.001",
          output_token: "0xETHop",
          output_token_symbol: "ETH",
          output_token_local_symbol: null,
          output_amount: "0.00099",
          value_usd: null,
          capture_status: null,
          instrument_key: null,
          chain: "optimism",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-07-20T11:00:00.000Z",
          source: "agent_activity",
          status: "pending",
          failure_code: null,
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          token_in_decimals: 18,
          token_out_decimals: 18,
          from_chain: "base",
          to_chain: "optimism",
          provider_order_id: "req_1",
          legs: [
            { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xdep2", status: "confirmed", failureCode: null },
            { role: "bridge_fill_expected", chainId: 10, chainFamily: "eip155", txHash: null, status: "pending", failureCode: null },
          ],
          last_checked_at: "2026-07-20T11:05:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.status).toBe("pending");
    expect(row?.amountBasis).toBe("estimated");
    expect(row?.inputAmount).toBe("0.001"); // the QUOTE, shown as estimate
    expect(row?.outputAmount).toBe("0.00099");
    expect(row?.legs).toHaveLength(2);
    // R12: the last successful sweep check is surfaced for a pending bridge.
    expect(row?.lastCheckedAt).toBe("2026-07-20T11:05:00.000Z");
  });

  it("swap regression: an agent_activity swap row keeps product_type 'spot', empty legs, null route", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 32,
          trade_side: null,
          product_type: "spot",
          venue: "kyberswap",
          input_token: "0xIn",
          input_token_symbol: "USDC",
          input_token_local_symbol: null,
          input_amount: "50",
          output_token: "0xOut",
          output_token_symbol: "WETH",
          output_token_local_symbol: null,
          output_amount: null,
          value_usd: null,
          capture_status: null,
          instrument_key: null,
          chain: "8453",
          tx_ref: "0xswap",
          wallet_address: WALLET_A,
          created_at: "2026-07-20T12:00:00.000Z",
          source: "agent_activity",
          status: "pending",
          failure_code: null,
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          token_in_decimals: 6,
          token_out_decimals: 18,
          from_chain: null,
          to_chain: null,
          provider_order_id: null,
          legs: null,
          // Even if the column is populated for a swap, it is bridge-only on the
          // DTO — the mapper must gate it out.
          last_checked_at: "2026-07-20T12:05:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.productType).toBe("spot");
    expect(row?.inputAmount).toBe("50"); // swap pending → requested echo (C20, unchanged)
    expect(row?.amountBasis).toBeNull(); // swaps don't set amountBasis
    expect(row?.legs).toEqual([]);
    expect(row?.fromChain).toBeNull();
    expect(row?.providerOrderId).toBeNull();
    // R12 is bridge-only: a swap row never surfaces lastCheckedAt.
    expect(row?.lastCheckedAt).toBeNull();
  });
});
