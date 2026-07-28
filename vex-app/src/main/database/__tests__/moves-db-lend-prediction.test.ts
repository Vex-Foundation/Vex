/**
 * moves-db tests — the W5 (migration 049) `kind='lend'`/`'prediction'` half
 * of `getMovesForSession`'s `agent_activity` union, split out of
 * `moves-db.test.ts` (500-line-cap deviation — that file was ALREADY over
 * the repo's 500-line cap before this card touched it; see deltas/K8.md).
 * Mirrors that file's own mock setup (mocked `pg` Client + `db-config` +
 * `sessions-db` + logger, NO real DB) since the split, per the F1/K7
 * precedent, keeps each sibling file independently runnable rather than
 * sharing test-only boilerplate across files.
 *
 * Covers: the widened row-inclusion predicate (`kind IN ('lend',
 * 'prediction')`), the `product_type` CASE arms, and the executed-vs-
 * estimated amount rule (`resolveAmountWithEstimateBasis`, shared with
 * bridges) for lend/prediction rows — a confirmed row lacking decoder-proven
 * executed data falls back to the quote labelled `amountBasis: "estimated"`
 * instead of going blank (W5 design REVISION 1 R3/R5), unlike a plain swap.
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

describe("moves-db getMovesForSession — agent_activity lend/prediction (W5, migration 049)", () => {
  function lendRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 40,
      trade_side: null,
      product_type: "lend",
      venue: "jupiter",
      input_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      input_token_symbol: "USDC",
      input_token_local_symbol: null,
      input_amount: "5.0",
      output_token: null,
      output_token_symbol: null,
      output_token_local_symbol: null,
      output_amount: null,
      value_usd: "5.0",
      capture_status: null,
      instrument_key: null,
      chain: "solana",
      tx_ref: "sol_sig_1",
      wallet_address: WALLET_A,
      created_at: "2026-07-24T10:00:00.000Z",
      source: "agent_activity",
      status: "confirmed",
      failure_code: null,
      executed_amount_in_raw: null,
      executed_amount_out_raw: null,
      token_in_decimals: 6,
      token_out_decimals: null,
      from_chain: null,
      to_chain: null,
      provider_order_id: null,
      legs: null,
      last_checked_at: null,
      // The canonical vocabulary columns the agent_activity SELECT now
      // projects (migration 049's kind/event_role, clamped in SQL).
      activity_kind: "lend",
      event_role: "lend_deposit",
      ...overrides,
    };
  }

  it("maps a lend row to the FULL exhaustive MoveItem shape (Phase-2 lastCheckedAt lesson: every field, not a subset)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [lendRow()] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        id: "agent_activity:40",
        source: "agent_activity",
        tradeSide: null,
        productType: "lend",
        venue: "jupiter",
        inputToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputTokenSymbol: "USDC",
        inputTokenLocalSymbol: null,
        inputAmount: "5.0",
        outputToken: null,
        outputTokenSymbol: null,
        outputTokenLocalSymbol: null,
        outputAmount: null,
        valueUsd: 5,
        captureStatus: null,
        status: "confirmed",
        failureCode: null,
        instrumentKey: null,
        chain: "solana",
        txRef: "sol_sig_1",
        walletAddress: WALLET_A,
        fromChain: null,
        toChain: null,
        providerOrderId: null,
        amountBasis: "estimated",
        legs: [],
        lastCheckedAt: null,
        // Canonical vocabulary straight off the row — `productType: "lend"`
        // above is the legacy derivation, this is the real column.
        activityKind: "lend",
        eventRole: "lend_deposit",
        // Migration 053 Option C: yield-only; a lend row never carries one.
        secondaryInputLeg: null,
        secondaryOutputLeg: null,
        createdAt: "2026-07-24T10:00:00.000Z",
      },
    ]);
  });

  it("includes a lend/prediction row via the widened kind IN ('lend','prediction') predicate (SQL shape)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getMovesForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("aa.kind IN ('lend', 'prediction')");
  });

  it("maps a CONFIRMED lend row lacking decoder-proven executed data to the QUOTED amount labelled 'estimated' (never blank — W5 design R3/R5)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({ rows: [lendRow()] });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.productType).toBe("lend");
    expect(row?.status).toBe("confirmed");
    expect(row?.amountBasis).toBe("estimated");
    expect(row?.inputAmount).toBe("5.0"); // the quote, shown as an estimate
  });

  it("maps a CONFIRMED lend row WITH decoder-proven executed data to basis 'executed'", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        lendRow({
          executed_amount_in_raw: "5000000",
          token_in_decimals: 6,
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.amountBasis).toBe("executed");
    expect(row?.inputAmount).toBe("5"); // executed 5000000 / 10^6, not the "5.0" quote
  });

  it("maps a PENDING prediction row to the quoted amount labelled 'estimated'", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        lendRow({
          product_type: "prediction",
          venue: "jupiter",
          status: "pending",
          tx_ref: null,
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.productType).toBe("prediction");
    expect(row?.status).toBe("pending");
    expect(row?.amountBasis).toBe("estimated");
    expect(row?.inputAmount).toBe("5.0");
  });

  it("maps a FAILED lend row to NO amount and a null basis (an incomplete attempt's legs are moot)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        lendRow({
          status: "definitively_failed",
          failure_code: "solana_signature_expired",
          tx_ref: null,
        }),
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.status).toBe("failed");
    expect(row?.failureCode).toBe("solana_signature_expired");
    expect(row?.amountBasis).toBeNull();
    expect(row?.inputAmount).toBeNull();
  });

  it("a lend/prediction row never carries bridge-only fields (legs, fromChain, providerOrderId, lastCheckedAt)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [lendRow({ last_checked_at: "2026-07-24T10:05:00.000Z" })],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.legs).toEqual([]);
    expect(row?.fromChain).toBeNull();
    expect(row?.toChain).toBeNull();
    expect(row?.providerOrderId).toBeNull();
    // R12 tracking is a bridge-only concept — a lend row never surfaces it,
    // even if the underlying column happens to carry a value.
    expect(row?.lastCheckedAt).toBeNull();
  });
});
