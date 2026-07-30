/**
 * `confirmJupiterPredictionPayoutSettlement` — the CAS finalizer for a Jupiter
 * Prediction sell/close whose payout arrived in a KEEPER's later settle
 * transaction, not in the transaction Vex broadcast (P1 fill-settlement lane).
 * Mocked-pool unit test mirroring `agent-activity-solana-staged-evidence.test.ts`.
 *
 * Pins the money-path rules this finalizer exists to enforce:
 *   - the CAS predicate is narrow BY ROLE AND PROTOCOL — `status='pending' AND
 *     protocol='jupiter' AND kind='prediction' AND event_role IN
 *     ('predict_sell','predict_close')` — so no other row shape can ever be
 *     rewritten by this path;
 *   - the out leg is relabelled to JupUSD ONLY from the COMPLETE legacy USDC
 *     tuple; an already-JupUSD row is accepted without a relabel; ANY other
 *     tuple fails closed with NO write at all (a row we cannot identify is a
 *     row we must not overwrite);
 *   - `route_provenance` is MERGED (`||`), never clobbered: unrelated
 *     provenance keys survive and `prediction_order.positionPubkey` — the
 *     per-row truth written at intent time — survives the settlement merge;
 *   - `tx_hash` is NEVER touched (it stays OUR create signature, not the
 *     keeper's settle signature);
 *   - `provider_order_id`/`provider_status`/`evidence_source` are never
 *     written — migration 049's `agent_activity_non_bridge_no_bridge_cols`
 *     CHECK requires them NULL on a prediction row;
 *   - duplicate-CAS awareness: `{applied,row}` like every sibling finalizer.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;

let mockQueryOne: QueryOneMock;

function resetMocks(): void {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: vi.fn(),
  // The agent-activity CAS writers now run inside a session-control-locked
  // transaction, so they reach the `…With` client variants. Routed to the SAME
  // fakes as their pool-level twins: the statement under test is identical, only
  // the connection it travels on changed.
  queryWith: vi.fn(),
  queryOneWith: (_c: unknown, sql: string, params?: unknown[]) => mockQueryOne(sql, params as never),
  executeWith: vi.fn(),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

const repo = await import("@vex-agent/db/repos/agent-activity.js");
const orderProvenance = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-order-provenance.js"
);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPUSD_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";

/** Chain-proven row 42 (2026-07-25 funded gate) — the settle credited +4,545,860 JupUSD. */
const PROVEN = {
  executedAmountOutRaw: "4545860",
  executedAmountOutHuman: "4.54586",
  orderPubkey: "BHhiu4YZpAq4mQBR4ks8QJ2ALt1AMYVDd9D6PxjUgxyK",
  createSignature:
    "5AChd2vmZtjVFJ2wTgBssFwn6oAgJktHUBQkqU8oAwXJ7fJoZNUN6J7jbkmgAHkfEHXLWrSfCeKgvE5626tiFGsx",
  matchedEventType: "order_created",
  matchedAt: "2026-07-26T10:00:00.000Z",
  settleSignature:
    "43TvehHpQUNCY2Jw2LZ5KZ2qjWd7hmyxUSnonzhftuUE2cCRvoPApDGScdDhQyrwuip2wKvrq2K2piBJ397fzFzX",
  escrowAta: "5cPEe71gehe8KWtHZYAMLDRX87nTk6Fm2Uf3UPAse1Hg",
} as const;

function activityRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 42,
    protocol_execution_id: 7,
    event_index: 0,
    event_role: "predict_sell",
    record_version: 1,
    kind: "prediction",
    protocol: "jupiter",
    chain_id: 20011000000,
    chain_slug: "solana",
    status: "pending",
    failure_code: null,
    failure_reason: null,
    token_in_address: null,
    token_in_symbol: null,
    token_in_decimals: null,
    amount_in_human: null,
    amount_in_raw: null,
    // The legacy shape every stuck row carries: labelled USDC before the
    // payout mint was known.
    token_out_address: USDC_MINT,
    token_out_symbol: "USDC",
    token_out_decimals: 6,
    amount_out_human: null,
    amount_out_raw: null,
    executed_amount_in_human: null,
    executed_amount_in_raw: null,
    executed_amount_out_human: null,
    executed_amount_out_raw: null,
    usd_in_est: null,
    usd_out_est: null,
    usd_fee_est: null,
    usd_source: null,
    tx_hash: PROVEN.createSignature,
    from_address: "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS",
    nonce: null,
    wallet_address: "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS",
    session_id: "00000000-0000-4000-8000-000000000001",
    route_provenance: null,
    from_chain_id: null,
    from_chain_slug: null,
    to_chain_id: null,
    to_chain_slug: null,
    chain_family: "solana",
    provider_order_id: null,
    normalized_route: null,
    provider_status: null,
    evidence_source: null,
    observed_at: null,
    last_attempted_at: null,
    submit_attempted_at: "2026-07-25T10:00:00.000Z",
    recent_blockhash: "11111111111111111111111111111112",
    last_valid_block_height: 12345,
    broadcast_at: "2026-07-25T10:00:01.000Z",
    confirmed_at: null,
    last_checked_at: null,
    created_at: "2026-07-25T09:59:00.000Z",
    updated_at: "2026-07-25T10:00:01.000Z",
    ...overrides,
  };
}

/** The finalizer reads the row first (decide relabel / fail closed), then does ONE atomic UPDATE. */
function stubSelectThenUpdate(row: Record<string, unknown>, updated: Record<string, unknown> | null): void {
  mockQueryOne.mockResolvedValueOnce(row).mockResolvedValueOnce(updated);
}

function updateCall(): [string, unknown[] | undefined] {
  const call = mockQueryOne.mock.calls[1];
  if (!call) throw new Error("expected an UPDATE call after the row read");
  return call;
}

beforeEach(() => {
  resetMocks();
});

describe("confirmJupiterPredictionPayoutSettlement — CAS predicate", () => {
  it("guards status, protocol, kind and the two payout roles in ONE atomic UPDATE", async () => {
    stubSelectThenUpdate(
      activityRow(),
      activityRow({ status: "confirmed", token_out_address: JUPUSD_MINT, token_out_symbol: "JupUSD" }),
    );

    const result = await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    expect(result.applied).toBe(true);
    // exactly two round-trips: the row read, then the single UPDATE
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    const [sql] = updateCall();
    expect(sql).toMatch(/UPDATE agent_activity/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).toMatch(/protocol = 'jupiter'/);
    expect(sql).toMatch(/kind = 'prediction'/);
    expect(sql).toMatch(/event_role IN \('predict_sell', ?'predict_close'\)/);
  });

  it("keeps the token_out tuple guard in the SQL predicate too (a concurrent relabel cannot slip through)", async () => {
    stubSelectThenUpdate(activityRow(), activityRow({ status: "confirmed" }));

    await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    const [sql, params] = updateCall();
    expect(sql).toMatch(/token_out_address/);
    expect(sql).toMatch(/token_out_symbol/);
    expect(sql).toMatch(/token_out_decimals/);
    expect(params).toContain(USDC_MINT);
    expect(params).toContain(JUPUSD_MINT);
  });

  it("returns {applied:false, row} on a CAS miss instead of throwing (duplicate-CAS awareness)", async () => {
    // UPDATE returns nothing (already settled by a concurrent sweep), then the
    // finalizer re-reads the current row to report it.
    mockQueryOne
      .mockResolvedValueOnce(activityRow())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activityRow({ status: "confirmed" }));

    const result = await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    expect(result.applied).toBe(false);
    expect(result.row.status).toBe("confirmed");
  });
});

describe("confirmJupiterPredictionPayoutSettlement — the out-leg relabel", () => {
  it("relabels the complete legacy USDC tuple to the JupUSD tuple", async () => {
    stubSelectThenUpdate(activityRow(), activityRow({ status: "confirmed" }));

    await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    const [sql, params] = updateCall();
    expect(sql).toMatch(/token_out_address = \$/);
    expect(sql).toMatch(/token_out_symbol = \$/);
    expect(sql).toMatch(/token_out_decimals = \$/);
    expect(params).toContain(JUPUSD_MINT);
    expect(params).toContain("JupUSD");
  });

  it("accepts a row already carrying the JupUSD tuple (no relabel needed)", async () => {
    stubSelectThenUpdate(
      activityRow({ token_out_address: JUPUSD_MINT, token_out_symbol: "JupUSD", token_out_decimals: 6 }),
      activityRow({ status: "confirmed", token_out_address: JUPUSD_MINT, token_out_symbol: "JupUSD" }),
    );

    const result = await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    expect(result.applied).toBe(true);
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a partial legacy tuple (right mint, wrong symbol)", { token_out_symbol: "usdc" }],
    ["a partial legacy tuple (right mint, wrong decimals)", { token_out_decimals: 9 }],
    ["a foreign mint", { token_out_address: "So11111111111111111111111111111111111111112" }],
    ["no out leg at all", { token_out_address: null, token_out_symbol: null, token_out_decimals: null }],
  ])("fails closed with NO write for %s", async (_label, overrides) => {
    mockQueryOne.mockResolvedValueOnce(activityRow(overrides));

    const result = await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    expect(result.applied).toBe(false);
    // the row read only — the UPDATE must never be attempted
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });
});

describe("confirmJupiterPredictionPayoutSettlement — what it writes", () => {
  it("writes the chain-proven executed amount raw + its exact-decimal human sibling", async () => {
    stubSelectThenUpdate(activityRow(), activityRow({ status: "confirmed" }));

    await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    const [sql, params] = updateCall();
    expect(sql).toMatch(/executed_amount_out_raw = \$/);
    expect(sql).toMatch(/executed_amount_out_human = \$/);
    expect(params).toContain("4545860");
    expect(params).toContain("4.54586");
  });

  it("MERGES route_provenance rather than clobbering it, and merges INTO prediction_order", async () => {
    stubSelectThenUpdate(activityRow(), activityRow({ status: "confirmed" }));

    await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    const [sql, params] = updateCall();
    // top-level merge onto whatever the row already had
    expect(sql).toMatch(/route_provenance\s*=\s*COALESCE\(route_provenance, '\{\}'::jsonb\)\s*\|\|/);
    // and a nested merge into prediction_order, so positionPubkey survives.
    // The key is BOUND rather than inlined, so assert it reaches the params.
    expect(sql).toMatch(/COALESCE\(route_provenance -> \$\d+::text, '\{\}'::jsonb\)\s*\|\|/);
    expect(params).toContain("prediction_order");
    expect(params).toContain("payout_settlement");

    const provenanceParams = (params ?? []).filter((p): p is string => typeof p === "string");
    const orderFragmentJson = provenanceParams.find((p) => p.includes("orderPubkey"));
    const settlementFragmentJson = provenanceParams.find((p) => p.includes("settleSignature"));
    expect(orderFragmentJson).toBeDefined();
    expect(settlementFragmentJson).toBeDefined();
    expect(JSON.parse(orderFragmentJson!)).toEqual({
      orderPubkey: PROVEN.orderPubkey,
      createSignature: PROVEN.createSignature,
      matchedEventType: "order_created",
      matchedAt: PROVEN.matchedAt,
    });
    expect(JSON.parse(settlementFragmentJson!)).toEqual({
      settleSignature: PROVEN.settleSignature,
      escrowAta: PROVEN.escrowAta,
      source: "escrow_transfer_balance_delta",
      laneVersion: 1,
    });
  });

  it("never touches tx_hash, and never writes a bridge-only column", async () => {
    stubSelectThenUpdate(activityRow(), activityRow({ status: "confirmed" }));

    await repo.confirmJupiterPredictionPayoutSettlement(42, PROVEN);

    const [sql] = updateCall();
    expect(sql).not.toMatch(/tx_hash\s*=/);
    expect(sql).not.toMatch(/provider_order_id\s*=/);
    expect(sql).not.toMatch(/provider_status\s*=/);
    expect(sql).not.toMatch(/evidence_source\s*=/);
    // the settle signature is recorded as PROVENANCE, never as the row's hash
    expect(sql).toMatch(/status = 'confirmed'/);
    expect(sql).toMatch(/confirmed_at = NOW\(\)/);
  });
});

describe("prediction_order provenance contract", () => {
  it("builds the versioned per-row positionPubkey provenance written at intent time", () => {
    expect(orderProvenance.buildPredictionOrderProvenance("JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd")).toEqual({
      prediction_order: { version: 1, positionPubkey: "JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd" },
    });
  });

  it("reads the positionPubkey back out of a row's route_provenance", () => {
    const fragment = orderProvenance.buildPredictionOrderProvenance("JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd");
    expect(orderProvenance.readPredictionOrderPositionPubkey(fragment)).toBe(
      "JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd",
    );
  });

  it("survives the settlement merge — a settled row still reports its own position", () => {
    expect(
      orderProvenance.readPredictionOrderPositionPubkey({
        prediction_order: {
          version: 1,
          positionPubkey: "JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd",
          orderPubkey: PROVEN.orderPubkey,
          createSignature: PROVEN.createSignature,
        },
        payout_settlement: { settleSignature: PROVEN.settleSignature },
      }),
    ).toBe("JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd");
  });

  it.each([
    ["null provenance", null],
    ["no prediction_order key", { settlement_profile: { kind: "jupiter_fee_swap" } }],
    ["a non-object prediction_order", { prediction_order: "JBKuLxTk81jhm5VGmmWxXKxKKz8NAqjYad8TXgWMGkJd" }],
    ["a non-string positionPubkey", { prediction_order: { version: 1, positionPubkey: 42 } }],
    ["an empty positionPubkey", { prediction_order: { version: 1, positionPubkey: "" } }],
    ["an unknown provenance version", { prediction_order: { version: 2, positionPubkey: "JBKuLx" } }],
  ])("returns null for %s rather than guessing", (_label, provenance) => {
    expect(orderProvenance.readPredictionOrderPositionPubkey(provenance as Record<string, unknown> | null)).toBeNull();
  });
});
