/**
 * token-history-db tests — the W5 (migration 049) `kind='lend'`/`'prediction'`
 * half of `getTokenHistory`'s `agent_activity` arm, split out of
 * `token-history-db.test.ts` (500-line-cap deviation — that file was ALREADY
 * over the repo's 500-line cap before this card touched it; see
 * deltas/K8.md). Mirrors that file's own mock setup (mocked `pg` Client +
 * `db-config` + `@vex-lib/wallet.js` `listWallets` + logger, NO real DB)
 * since the split, per the F1/K7 precedent, keeps each sibling file
 * independently runnable rather than sharing test-only boilerplate across
 * files.
 *
 * Covers: the widened row-inclusion + identity-match predicate
 * (`kind IN ('lend', 'prediction')`, sharing the swap arm's chain_id+token
 * match), the `product_type` CASE arms, and the DELIBERATE scope limit
 * (documented, not a bug) that a confirmed lend/prediction row lacking
 * decoder-proven executed data still renders a BLANK amount here — unlike
 * `moves-db.ts`, `swapEntrySchema` has no `amountBasis` field to carry an
 * "estimated" label, and `TokenHistoryScreen.tsx`'s own basis read is
 * bridge-kind-gated, so adding a dormant field would have no consumer.
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
const SOLANA_CHAIN_ID = 20011000000;
const SOL_TOKEN = "TokMintABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk";

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

describe("getTokenHistory — agent_activity lend/prediction (W5, migration 049)", () => {
  /** A Jupiter Lend deposit — one role per on-chain tx, no allowance legs. */
  function lendAgentRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      source_kind: "agent_activity",
      source_rank: 2,
      source_id: "00000000000000000041",
      created_at: new Date("2026-07-24T10:00:00.000Z"),
      cursor_ts: "2026-07-24T10:00:00.000000Z",
      namespace: "jupiter",
      product_type: "lend",
      trade_side: null,
      chain: "solana",
      dest_chain: null,
      input_token_address: SOL_TOKEN,
      input_amount: "5.0",
      output_token_address: null,
      output_amount: null,
      input_value_usd: "5.00",
      output_value_usd: null,
      unit_price_usd: null,
      capture_status: null,
      tx_ref: "sol_sig_1",
      input_token_symbol: "USDC",
      input_token_local_symbol: null,
      output_token_symbol: null,
      output_token_local_symbol: null,
      to_address: null,
      status: "confirmed",
      failure_code: null,
      executed_amount_in_raw: null,
      executed_amount_out_raw: null,
      token_in_decimals: 6,
      token_out_decimals: null,
      provider_order_id: null,
      legs: null,
      last_checked_at: null,
      ...overrides,
    };
  }

  it("matches lend/prediction rows via kind IN ('lend','prediction') sharing the swap arm's chain_id+token identity match", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({ chainId: SOLANA_CHAIN_ID, tokenAddress: SOL_TOKEN, cursor: null });
    const { sql } = pageQueryCall();
    expect(sql).toContain("aa.kind IN ('lend', 'prediction')");
  });

  it("maps a confirmed lend row to a kind:'swap' entry with productType 'lend'", async () => {
    scriptTransaction({ page: [lendAgentRow()] });
    const result = await getTokenHistory({ chainId: SOLANA_CHAIN_ID, tokenAddress: SOL_TOKEN, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    expect(entry?.kind).toBe("swap");
    if (entry?.kind !== "swap") return;
    expect(entry.productType).toBe("lend");
    expect(entry.status).toBe("confirmed");
  });

  it("maps a confirmed prediction row lacking decoder-proven executed data to a BLANK amount (deliberate scope limit — see delta log; never a mislabelled value)", async () => {
    scriptTransaction({
      page: [lendAgentRow({ product_type: "prediction", namespace: "jupiter" })],
    });
    const result = await getTokenHistory({ chainId: SOLANA_CHAIN_ID, tokenAddress: SOL_TOKEN, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    if (entry?.kind !== "swap") return;
    expect(entry.productType).toBe("prediction");
    // Confirmed but no executed_amount_in_raw → the plain-swap rule blanks it
    // rather than showing the "5.0" quote as if it were settlement.
    expect(entry.input.amount).toEqual({ value: null, unitProvenance: "unknown" });
  });

  it("maps a pending lend row to the requested echo, same rule as a plain swap", async () => {
    scriptTransaction({ page: [lendAgentRow({ status: "pending", tx_ref: null })] });
    const result = await getTokenHistory({ chainId: SOLANA_CHAIN_ID, tokenAddress: SOL_TOKEN, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    if (entry?.kind !== "swap") return;
    expect(entry.status).toBe("pending");
    expect(entry.input.amount).toEqual({ value: "5.0", unitProvenance: "human" });
  });
});
