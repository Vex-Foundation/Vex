/**
 * token-history-db tests — the `agent_activity` BRIDGE arm (Agent Scan
 * Phase 2), split out of `token-history-db.test.ts` by domain under test
 * (Card C5, move-only, same pattern as Cards F1/K7/K8: no assertion
 * changes, no coverage loss) once the parent file crossed the repo's
 * 500-line cap. Mirrors `token-history-db.test.ts`'s own mock setup (mocked
 * `pg`/`db-config`/`@vex-lib/wallet.js`/logger) — deliberately NOT sharing
 * boilerplate across files.
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

describe("getTokenHistory - agent_activity bridge (Agent Scan Phase 2)", () => {
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
    expect(sql).toContain("aa.event_role = 'swap'");
    expect(sql).toContain("aa.event_role = 'bridge_fill_expected'");
    expect(sql).toContain("aa.kind IN ('lend', 'prediction', 'launch')");
    expect(sql).toContain("WHEN 'bridge' THEN 'bridge'");
    expect(sql).toContain("WHEN 'lend' THEN 'lend'");
    expect(sql).toContain("WHEN 'prediction' THEN 'prediction'");
    expect(sql).toContain("ELSE 'spot'");
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
