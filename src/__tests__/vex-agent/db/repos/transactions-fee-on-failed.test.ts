/**
 * transactions repo — the feed NEVER claims a Vex fee on a definitively-failed
 * row (mocked pool). Chain-proven by row #66: a Jupiter swap that LANDED with
 * `{"InstructionError":[3,"ProgramFailedToComplete"]}` (failure_code
 * `mined_revert`). A Solana transaction is atomic — a failing instruction
 * reverts every instruction in it, INCLUDING the integrator-fee transfer — so
 * nothing moved on-chain and no fee was collected. The mapper nonetheless
 * passed `vex_fee_*` straight through, and the agent/UI were served
 * `vexFeeAmountHuman: "0.023125"` JupUSD: a charge that never happened.
 *
 * Pins the P2 projection rule (owner rule 90-vex-project, Money-Path
 * Discipline: "order legs so a failure cannot charge for something that did
 * not happen"):
 *   - status `definitively_failed` → all SIX fee fields project as `null`
 *     (`vexFeeTokenAddress`, `vexFeeTokenSymbol`, `vexFeeTokenDecimals`,
 *     `vexFeeAmountRaw`, `vexFeeAmountHuman`, `usdVexFeeEst`);
 *   - every OTHER field is untouched — in particular the remaining `usd*Est`
 *     figures, which are labelled estimates of what the attempt would have
 *     cost and stay readable as such;
 *   - `confirmed` and `pending` rows preserve every fee field verbatim (a
 *     collected fee, and an in-flight plan, are both honest to show).
 *
 * The DB columns are NOT touched by this rule — the planned-fee provenance
 * stays on the row; only the agent-facing projection withdraws the claim.
 *
 * Sibling of `transactions.test.ts` / `transactions-lend-prediction.test.ts`
 * (same mocked-pool pattern); split by domain under test per Cards K7/C5.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { TransactionRow } from "@vex-agent/db/repos/transactions.js";

type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQuery: QueryMock;

function resetMocks() {
  mockQuery = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: vi.fn(),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/transactions.js");

const ADDRS = ["0xEVM", "SOL"];
const SESSION = "00000000-0000-4000-8000-000000000001";

/** JupUSD — row #66's real fee mint (a public mint address). */
const JUP_USD_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** The six fields the P2 rule governs — typed against the DTO so a rename breaks this test. */
const VEX_FEE_FIELDS: readonly (keyof TransactionRow)[] = [
  "vexFeeTokenAddress",
  "vexFeeTokenSymbol",
  "vexFeeTokenDecimals",
  "vexFeeAmountRaw",
  "vexFeeAmountHuman",
  "usdVexFeeEst",
];

/**
 * Row #66's real shape: a JupUSD→SOL Jupiter swap carrying a recorded 25 bps
 * Vex fee (9.25 JupUSD in → 0.023125 JupUSD fee). Overrides drive the status /
 * settlement variants.
 */
function activityRowWithVexFee(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    source: "agent_activity", source_rank: 0, id: 66, namespace: "jupiter",
    product_type: "spot", trade_side: null, chain: "solana",
    input_token: "JupUSD", input_amount: null, output_token: "SOL", output_amount: null,
    value_usd: "9.25", capture_status: null,
    failure_code: null, failure_reason: null,
    chain_id: 20011000000, protocol: "jupiter",
    tool_id: null, duration_ms: null,
    protocol_execution_id: 66, event_index: 0, event_role: "swap",
    token_in_address: JUP_USD_MINT, token_in_symbol: "JupUSD", token_in_decimals: 6,
    token_out_address: WSOL_MINT, token_out_symbol: "SOL", token_out_decimals: 9,
    amount_in_human: "9.25", amount_in_raw: "9250000",
    amount_out_human: "0.05", amount_out_raw: "50000000",
    executed_amount_in_human: null, executed_amount_in_raw: null,
    executed_amount_out_human: null, executed_amount_out_raw: null,
    usd_in_est: "9.25", usd_out_est: "9.21", usd_fee_est: "0.0004",
    usd_network_gas_est: "0.0004", usd_venue_fee_est: "0.0012",
    usd_destination_prepay_est: null,
    // The recorded Vex fee — present on the row regardless of outcome.
    usd_vex_fee_est: "0.023125",
    vex_fee_token_address: JUP_USD_MINT,
    vex_fee_token_symbol: "JupUSD",
    vex_fee_token_decimals: 6,
    vex_fee_amount_raw: "23125",
    vex_fee_amount_human: "0.023125",
    usd_source: "jupiter_quote",
    chain_family: "solana",
    from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
    provider_order_id: null, provider_status: null, legs: null,
    tx_hash: "sig66", created_at: "2026-07-25T10:00:00.000000Z",
    cursor_ts: "2026-07-25T10:00:00.000000Z",
    ...overrides,
  };
}

async function firstRow(raw: Record<string, unknown>): Promise<TransactionRow> {
  mockQuery.mockResolvedValueOnce([raw]);
  const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
  const [row] = res.items;
  if (row === undefined) throw new Error("expected the mocked feed to return exactly one row");
  return row;
}

beforeEach(() => {
  resetMocks();
});

// ── the withdrawn claim ───────────────────────────────────────────────────

describe("vex fee on a definitively_failed row (P2)", () => {
  it("row #66 (atomic on-chain failure) projects ALL SIX Vex-fee fields as null", async () => {
    const row = await firstRow(
      activityRowWithVexFee({
        status: "definitively_failed",
        failure_code: "mined_revert",
        failure_reason: '{"InstructionError":[3,"ProgramFailedToComplete"]}',
      }),
    );

    expect(row.status).toBe("definitively_failed");
    for (const field of VEX_FEE_FIELDS) {
      expect(row[field], `${field} must not claim a fee on a failed row`).toBeNull();
    }
  });

  it("withdraws the fee claim on a PRE-broadcast failure too (nothing was ever charged)", async () => {
    const row = await firstRow(
      activityRowWithVexFee({
        status: "definitively_failed",
        failure_code: "slippage",
        failure_reason: "quote moved beyond the price floor",
        tx_hash: null,
      }),
    );

    for (const field of VEX_FEE_FIELDS) {
      expect(row[field], `${field} must not claim a fee on a failed row`).toBeNull();
    }
  });

  it("withdraws ONLY the Vex-fee claim — the other usd*Est estimates and the row's identity survive", async () => {
    const row = await firstRow(
      activityRowWithVexFee({
        status: "definitively_failed",
        failure_code: "mined_revert",
        failure_reason: '{"InstructionError":[3,"ProgramFailedToComplete"]}',
      }),
    );

    // Labelled estimates of what the attempt would have cost — they stay.
    expect(row.usdInEst).toBe("9.25");
    expect(row.usdOutEst).toBe("9.21");
    expect(row.usdFeeEst).toBe("0.0004");
    expect(row.usdNetworkGasEst).toBe("0.0004");
    expect(row.usdVenueFeeEst).toBe("0.0012");
    expect(row.usdSource).toBe("jupiter_quote");
    // Identity, evidence, and the quoted legs are untouched.
    expect(row.failureCode).toBe("mined_revert");
    expect(row.failureReason).toBe('{"InstructionError":[3,"ProgramFailedToComplete"]}');
    expect(row.txHash).toBe("sig66");
    expect(row.tokenInAddress).toBe(JUP_USD_MINT);
    expect(row.tokenInSymbol).toBe("JupUSD");
    expect(row.tokenInDecimals).toBe(6);
    expect(row.amountInRaw).toBe("9250000");
    expect(row.amountOutRaw).toBe("50000000");
    // C20: a failed row still shows no DISPLAY amount (unchanged rule).
    expect(row.inputAmount).toBeNull();
    expect(row.outputAmount).toBeNull();
    expect(row.amountBasis).toBeNull();
  });
});

// ── the claims that stand ─────────────────────────────────────────────────

describe("vex fee on non-failed rows (unchanged)", () => {
  it("a CONFIRMED row preserves every Vex-fee field verbatim (the fee was collected)", async () => {
    const row = await firstRow(
      activityRowWithVexFee({
        status: "confirmed",
        executed_amount_in_human: "9.25", executed_amount_in_raw: "9250000",
        executed_amount_out_human: "0.0499", executed_amount_out_raw: "49900000",
      }),
    );

    expect(row.status).toBe("confirmed");
    expect(row.vexFeeTokenAddress).toBe(JUP_USD_MINT);
    expect(row.vexFeeTokenSymbol).toBe("JupUSD");
    expect(row.vexFeeTokenDecimals).toBe(6);
    expect(row.vexFeeAmountRaw).toBe("23125");
    expect(row.vexFeeAmountHuman).toBe("0.023125");
    expect(row.usdVexFeeEst).toBe("0.023125");
    expect(row.amountBasis).toBe("executed");
  });

  it("a PENDING row preserves every Vex-fee field (the in-flight plan is legitimately shown)", async () => {
    const row = await firstRow(activityRowWithVexFee({ status: "pending" }));

    expect(row.status).toBe("pending");
    expect(row.vexFeeTokenAddress).toBe(JUP_USD_MINT);
    expect(row.vexFeeTokenSymbol).toBe("JupUSD");
    expect(row.vexFeeTokenDecimals).toBe(6);
    expect(row.vexFeeAmountRaw).toBe("23125");
    expect(row.vexFeeAmountHuman).toBe("0.023125");
    expect(row.usdVexFeeEst).toBe("0.023125");
    expect(row.amountBasis).toBe("requested");
  });

  it("a row with NO recorded fee stays null on all six fields regardless of status", async () => {
    const row = await firstRow(
      activityRowWithVexFee({
        status: "confirmed",
        usd_vex_fee_est: null,
        vex_fee_token_address: null,
        vex_fee_token_symbol: null,
        vex_fee_token_decimals: null,
        vex_fee_amount_raw: null,
        vex_fee_amount_human: null,
      }),
    );

    for (const field of VEX_FEE_FIELDS) {
      expect(row[field]).toBeNull();
    }
  });
});
