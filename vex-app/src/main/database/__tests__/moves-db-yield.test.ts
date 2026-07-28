/**
 * moves-db tests — the migration-053 `kind='yield'` (Pendle) half of
 * `getMovesForSession`'s `agent_activity` union. Mirrors
 * `moves-db-lend-prediction.test.ts`'s mock setup (mocked `pg` Client +
 * `db-config` + `sessions-db` + logger, NO real DB) per the established
 * one-file-per-kind split in this directory.
 *
 * Covers: the row-inclusion predicate (the five LOGICAL yield roles, NEVER a
 * bare `kind = 'yield'`, so an EVM `allowance`/`allowance_reset` leg of a
 * Pendle execution stays approval plumbing and never becomes its own ledger
 * row), the `product_type` CASE arm (a yield row must never be mislabelled
 * `spot`), and the amount rule (raw + decimals via the shared BigInt-safe
 * formatter — never a base-unit string shown as a human amount).
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
const { buildAgentActivityMovesHalf } = await import("../moves-db-query.js");

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const WALLET_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";

function scopeOk(evmAddr: string | null, solAddr: string | null) {
  return {
    ok: true as const,
    data: {
      evm: evmAddr ? { id: "evm_1", address: evmAddr } : null,
      solana: solAddr ? { id: "sol_1", address: solAddr } : null,
    },
  };
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

describe("moves-db getMovesForSession — agent_activity yield (Pendle, migration 053)", () => {
  /** A confirmed Pendle PT buy: 10 USDC in, 10.4 PT out, both legs proven. */
  function yieldRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 70,
      trade_side: null,
      // The SQL CASE maps kind 'yield' → this; see the SQL-shape test below.
      product_type: "yield",
      venue: "pendle",
      input_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      input_token_symbol: "USDC",
      input_token_local_symbol: null,
      input_amount: "10.0",
      output_token: "0x1111111111111111111111111111111111111111",
      output_token_symbol: "PT-sUSDe",
      output_token_local_symbol: null,
      output_amount: "10.4",
      value_usd: "10.0",
      capture_status: null,
      instrument_key: null,
      chain: "arbitrum",
      tx_ref: "0xdeadbeef",
      wallet_address: WALLET_A,
      created_at: "2026-07-27T10:00:00.000Z",
      source: "agent_activity",
      status: "confirmed",
      failure_code: null,
      executed_amount_in_raw: "10000000",
      executed_amount_out_raw: "10412345678901234567",
      token_in_decimals: 6,
      token_out_decimals: 18,
      from_chain: null,
      to_chain: null,
      provider_order_id: null,
      legs: null,
      last_checked_at: null,
      activity_kind: "yield",
      event_role: "yield_pt",
      ...overrides,
    };
  }

  it("surfaces a yield row with productType 'yield' and the canonical kind/role", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [yieldRow()] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.productType).toBe("yield");
    expect(row?.activityKind).toBe("yield");
    expect(row?.eventRole).toBe("yield_pt");
    expect(row?.venue).toBe("pendle");
  });

  it("maps kind 'yield' to product 'yield' in SQL — never falls through to 'spot'", () => {
    const sql = buildAgentActivityMovesHalf();
    expect(sql).toContain("WHEN 'yield' THEN 'yield'");
    // The ELSE arm still exists (swap/wrap legitimately derive to 'spot');
    // the point is that yield no longer reaches it.
    expect(sql).toContain("ELSE 'spot'");
  });

  it("includes ONLY the five logical yield roles — an allowance leg of a Pendle execution is never its own move", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");

    expect(sql).toContain("'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_claim'");
    // Fail LOUDLY if anyone widens this to a kind-level include: `allowance`
    // and `allowance_reset` are legal `kind='yield'` roles (migration 053
    // constraint 3), so a bare kind predicate would leak approval plumbing
    // into the ledger.
    expect(sql).not.toContain("aa.kind = 'yield'");
    expect(sql).not.toContain("'lend', 'prediction', 'yield'");
    expect(sql).not.toContain("'allowance'");
    expect(sql).not.toContain("'allowance_reset'");
  });

  it("renders CONFIRMED amounts from raw + decimals, never the raw base-unit string", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [yieldRow()] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.inputAmount).toBe("10"); // 10000000 / 10^6
    expect(row?.outputAmount).toBe("10.412345678901234567"); // 18 decimals, BigInt-safe
    // Not the quote echo, and emphatically not the base-unit integer.
    expect(row?.outputAmount).not.toBe("10.4");
    expect(row?.outputAmount).not.toBe("10412345678901234567");
    // Yield follows the plain-swap rule: migration 053's per-role CHECKs make
    // a confirmed row's executed legs mandatory, so there is no
    // confirmed-without-decode case needing an "estimated" label.
    expect(row?.amountBasis).toBeNull();
  });

  it("shows the quote echo while a yield row is still PENDING", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        yieldRow({
          status: "pending",
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          tx_ref: null,
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputAmount).toBe("10.0");
    expect(result.data[0]?.outputAmount).toBe("10.4");
  });

  it("a confirmed yield_claim shows the credited OUTPUT and a BLANK input (a claim spends nothing)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        yieldRow({
          event_role: "yield_claim",
          input_token: null,
          input_token_symbol: null,
          input_amount: null,
          // Migration 053 constraint 9: a confirmed claim has NO executed
          // input leg, by construction.
          executed_amount_in_raw: null,
          token_in_decimals: null,
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputAmount).toBeNull();
    expect(result.data[0]?.outputAmount).toBe("10.412345678901234567");
  });

  it("a confirmed yield_py MINT renders BOTH output legs with human amounts (1 → 2)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        yieldRow({
          event_role: "yield_py",
          // 10 USDC in → PT **and** YT out. Migration 053 constraint 7: a
          // `yield_py` populates exactly ONE side's second leg — here, OUT.
          output_token_symbol: "PT-sUSDe",
          token_out2_address: "0x2222222222222222222222222222222222222222",
          token_out2_symbol: "YT-sUSDe",
          token_out2_decimals: 18,
          amount_out2_human: "10.4",
          executed_amount_out2_raw: "10412345678901234567",
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    // Primary OUT leg, unchanged.
    expect(row?.outputAmount).toBe("10.412345678901234567");
    expect(row?.outputTokenSymbol).toBe("PT-sUSDe");
    // The second OUT leg — without it the feed claims a 1→1 swap for an
    // action that produced two instruments.
    expect(row?.secondaryOutputLeg).toEqual({
      token: "0x2222222222222222222222222222222222222222",
      tokenSymbol: "YT-sUSDe",
      amount: "10.412345678901234567",
    });
    // Raw base-unit integer must never surface as the human amount.
    expect(row?.secondaryOutputLeg?.amount).not.toBe("10412345678901234567");
    // A mint has no second INPUT leg (constraint 7).
    expect(row?.secondaryInputLeg).toBeNull();
  });

  it("a confirmed yield_py REDEEM renders BOTH input legs with human amounts (2 → 1)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        yieldRow({
          event_role: "yield_py",
          // PT **and** YT in → 10 USDC out.
          input_token: "0x1111111111111111111111111111111111111111",
          input_token_symbol: "PT-sUSDe",
          input_amount: "10.4",
          executed_amount_in_raw: "10412345678901234567",
          token_in_decimals: 18,
          token_in2_address: "0x2222222222222222222222222222222222222222",
          token_in2_symbol: "YT-sUSDe",
          // DIFFERENT decimals from the primary leg on purpose: a leg formatted
          // at its sibling's scale is a thousandfold error (rules/90).
          token_in2_decimals: 6,
          amount_in2_human: "10.4",
          executed_amount_in2_raw: "10412345",
          output_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          output_token_symbol: "USDC",
          output_amount: "10.0",
          executed_amount_out_raw: "10000000",
          token_out_decimals: 6,
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.inputAmount).toBe("10.412345678901234567");
    expect(row?.secondaryInputLeg).toEqual({
      token: "0x2222222222222222222222222222222222222222",
      tokenSymbol: "YT-sUSDe",
      amount: "10.412345", // 10412345 / 10^6 — this leg's OWN decimals
    });
    expect(row?.secondaryOutputLeg).toBeNull();
    expect(row?.outputAmount).toBe("10");
  });

  it("a PENDING yield_py shows the second leg's quote echo, not a settlement claim", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        yieldRow({
          event_role: "yield_py",
          status: "pending",
          tx_ref: null,
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
          token_out2_address: "0x2222222222222222222222222222222222222222",
          token_out2_symbol: "YT-sUSDe",
          token_out2_decimals: 18,
          amount_out2_human: "10.4",
          executed_amount_out2_raw: null,
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.secondaryOutputLeg?.amount).toBe("10.4");
  });

  it("a one-leg yield_pt row is UNCHANGED — no secondary legs (regression)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [yieldRow()] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.eventRole).toBe("yield_pt");
    expect(row?.inputAmount).toBe("10");
    expect(row?.outputAmount).toBe("10.412345678901234567");
    expect(row?.secondaryInputLeg).toBeNull();
    expect(row?.secondaryOutputLeg).toBeNull();
    expect(row?.legs).toEqual([]);
  });

  it("SELECTs the Option-C second-leg columns for yield rows", () => {
    const sql = buildAgentActivityMovesHalf();
    for (const col of [
      "token_in2_address",
      "token_in2_symbol",
      "token_in2_decimals",
      "amount_in2_human",
      "executed_amount_in2_raw",
      "token_out2_address",
      "token_out2_symbol",
      "token_out2_decimals",
      "amount_out2_human",
      "executed_amount_out2_raw",
    ]) {
      expect(sql).toContain(`aa.${col}`);
    }
  });

  it("a yield row never carries bridge-only fields", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [yieldRow({ last_checked_at: "2026-07-27T10:05:00.000Z" })],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.legs).toEqual([]);
    expect(row?.fromChain).toBeNull();
    expect(row?.toChain).toBeNull();
    expect(row?.lastCheckedAt).toBeNull();
  });
});
