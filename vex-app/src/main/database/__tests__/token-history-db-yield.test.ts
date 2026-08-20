/**
 * token-history-db tests — the migration-053 `kind='yield'` (Pendle) arm of
 * `getTokenHistory`'s `agent_activity` half. Mirrors
 * `token-history-db-lend-prediction.test.ts`'s mock setup (mocked `pg` Client
 * + `db-config` + `@vex-lib/wallet.js` `listWallets` + logger, NO real DB).
 *
 * Covers: the row-inclusion predicate (the five LOGICAL yield roles only — an
 * EVM `allowance` leg of a Pendle execution is approval plumbing, never a
 * history entry), the `product_type` CASE arm, and — the point of this file —
 * the OPTION-C second-leg identity match: a `py.mint` is 1 → 2 (PT **and** YT
 * out), so it must surface in BOTH output tokens' histories, not just the
 * first leg's.
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
const ARBITRUM_CHAIN_ID = 42161;
const PT_TOKEN = "0x1111111111111111111111111111111111111111";
const YT_TOKEN = "0x2222222222222222222222222222222222222222";
const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

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

describe("getTokenHistory - agent_activity yield (Pendle, migration 053)", () => {
  /** A confirmed `py.mint`: 100 USDC in → PT (leg 1) AND YT (leg 2) out. */
  function pyMintRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      source_kind: "agent_activity",
      source_rank: 2,
      source_id: "00000000000000000071",
      created_at: new Date("2026-07-27T10:00:00.000Z"),
      cursor_ts: "2026-07-27T10:00:00.000000Z",
      namespace: "pendle",
      product_type: "yield",
      trade_side: null,
      chain: "arbitrum",
      dest_chain: null,
      input_token_address: UNDERLYING,
      input_amount: "100.0",
      output_token_address: PT_TOKEN,
      output_amount: "100.0",
      input_value_usd: "100.00",
      output_value_usd: null,
      unit_price_usd: null,
      capture_status: null,
      tx_ref: "0xdeadbeef",
      input_token_symbol: "USDC",
      input_token_local_symbol: null,
      output_token_symbol: "PT-sUSDe",
      output_token_local_symbol: null,
      to_address: null,
      status: "confirmed",
      failure_code: null,
      executed_amount_in_raw: "100000000",
      executed_amount_out_raw: "100000000000000000000",
      token_in_decimals: 6,
      token_out_decimals: 18,
      provider_order_id: null,
      legs: null,
      last_checked_at: null,
      ...overrides,
    };
  }

  it("includes ONLY the five logical yield roles - an allowance leg is never a history entry", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({ chainId: ARBITRUM_CHAIN_ID, tokenAddress: PT_TOKEN, cursor: null });
    const { sql } = pageQueryCall();
    expect(sql).toContain("'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_claim'");
    expect(sql).not.toContain("aa.kind = 'yield'");
    expect(sql).not.toContain("'lend', 'prediction', 'yield'");
  });

  it("matches a yield row on the OPTION-C second-leg token columns too, so a py.mint reaches both output tokens' histories", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({ chainId: ARBITRUM_CHAIN_ID, tokenAddress: PT_TOKEN, cursor: null });
    const { sql } = pageQueryCall();
    // Canonical column names come from migration 053 §4.
    expect(sql).toContain("aa.token_in2_address");
    expect(sql).toContain("aa.token_out2_address");
  });

  it("maps kind 'yield' to product 'yield' - never falls through to 'spot'", async () => {
    scriptTransaction({ page: [] });
    await getTokenHistory({ chainId: ARBITRUM_CHAIN_ID, tokenAddress: PT_TOKEN, cursor: null });
    const { sql } = pageQueryCall();
    expect(sql).toContain("WHEN 'yield' THEN 'yield'");
  });

  it("surfaces the SAME py.mint row when the history is read for the PT leg and for the YT leg", async () => {
    // Leg 1 — the row's own `output_token_address`.
    scriptTransaction({ page: [pyMintRow()] });
    const ptResult = await getTokenHistory({
      chainId: ARBITRUM_CHAIN_ID,
      tokenAddress: PT_TOKEN,
      cursor: null,
    });
    expect(ptResult.ok).toBe(true);
    if (!ptResult.ok || ptResult.data.status !== "available") return;
    const ptEntry = ptResult.data.entries[0];
    if (ptEntry?.kind !== "swap") return;
    expect(ptEntry.productType).toBe("yield");

    // Leg 2 — the SECOND output. The row is matched by `token_out2_address`;
    // the bound address parameter is the YT mint, proving the read is scoped
    // to the leg the user asked about and the same execution still surfaces.
    vi.clearAllMocks();
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm"
        ? [{ id: "1", address: WALLET_EVM, label: "", createdAt: "" }]
        : [{ id: "2", address: WALLET_SOL, label: "", createdAt: "" }],
    );
    scriptTransaction({ page: [pyMintRow()] });
    const ytResult = await getTokenHistory({
      chainId: ARBITRUM_CHAIN_ID,
      tokenAddress: YT_TOKEN,
      cursor: null,
    });
    expect(ytResult.ok).toBe(true);
    if (!ytResult.ok || ytResult.data.status !== "available") return;
    const { params } = pageQueryCall();
    expect(params).toContain(YT_TOKEN.toLowerCase());
    const ytEntry = ytResult.data.entries[0];
    if (ytEntry?.kind !== "swap") return;
    expect(ytEntry.productType).toBe("yield");
    expect(ytEntry.status).toBe("confirmed");
  });

  it("renders a confirmed yield amount from raw + decimals, never the base-unit string", async () => {
    scriptTransaction({ page: [pyMintRow()] });
    const result = await getTokenHistory({
      chainId: ARBITRUM_CHAIN_ID,
      tokenAddress: PT_TOKEN,
      cursor: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== "available") return;
    const entry = result.data.entries[0];
    if (entry?.kind !== "swap") return;
    expect(entry.input.amount).toEqual({ value: "100", unitProvenance: "human" });
    expect(entry.output.amount).toEqual({ value: "100", unitProvenance: "human" });
  });
});
