/**
 * The EVM repair sweep against the REAL registered decoders on REAL native-in
 * receipts, end to end through the REAL finalizer — KyberSwap (Arbitrum) and
 * Uniswap (Base).
 *
 * This is the suite that was missing when the native-in gap shipped green:
 * `src/__tests__/integration/agent-scan/repair-sweep.int.test.ts` proves the
 * sweep's plumbing with an INJECTED stub decoder, so it could never notice
 * that the registered KyberSwap decoder declines a native-tokenIn receipt.
 *
 * The two venues resolve a native input differently, and both halves are
 * pinned here: Uniswap's router wraps the value and WETH emits a `Deposit`
 * the decoder can read, while KyberSwap's receipt evidences NOTHING on the
 * input side — its amount is a certainty of the signed transaction instead.
 *
 * NOTHING IS STUBBED BETWEEN THE SWEEP AND THE DECODER. Only the Postgres
 * client is faked (in-memory table answering the three statements this path
 * issues), exactly as `pendle-repair-py-receipt.test.ts` does — the repo
 * module, `mapRow` and `confirmActivityEvent` are the production ones.
 *
 * The receipt is the real capture in `fixtures/kyberswap-settlement/` (see its
 * README): a native-in swap whose input leg appears in NO log the wallet is a
 * party to.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach } from "vitest";

type SqlParams = readonly unknown[] | undefined;

const table = new Map<number, Record<string, unknown>>();

const mockQuery = vi.fn(async (sql: string, _params?: SqlParams) => {
  if (/SELECT \* FROM agent_activity[\s\S]*status = 'pending'/.test(sql)) {
    return [...table.values()].filter((r) => r.status === "pending");
  }
  throw new Error(`fake client: unexpected query — ${sql}`);
});

const mockQueryOne = vi.fn(async (sql: string, params?: SqlParams) => {
  const args = params ?? [];
  if (/^SELECT \* FROM agent_activity WHERE id = \$1/.test(sql.trim())) {
    return table.get(Number(args[0])) ?? null;
  }
  if (/UPDATE agent_activity[\s\S]*SET status = 'confirmed'/.test(sql)) {
    const row = table.get(Number(args[0]));
    if (!row || row.status !== "pending") return null; // the CAS miss, faithfully
    const confirmed = {
      ...row,
      status: "confirmed",
      confirmed_at: "2026-07-30T12:00:05.000Z",
      executed_amount_in_human: args[1] ?? null,
      executed_amount_in_raw: args[2] ?? null,
      executed_amount_out_human: args[3] ?? null,
      executed_amount_out_raw: args[4] ?? null,
      executed_amount_in2_human: args[5] ?? null,
      executed_amount_in2_raw: args[6] ?? null,
      executed_amount_out2_human: args[7] ?? null,
      executed_amount_out2_raw: args[8] ?? null,
    };
    table.set(Number(args[0]), confirmed);
    return confirmed;
  }
  throw new Error(`fake client: unexpected queryOne — ${sql}`);
});

const mockExecute = vi.fn(async (_sql: string, _params?: SqlParams) => 0);

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: SqlParams) => mockQuery(sql, params),
  queryOne: (sql: string, params?: SqlParams) => mockQueryOne(sql, params),
  execute: (sql: string, params?: SqlParams) => mockExecute(sql, params),
  queryWith: (_c: unknown, sql: string, params?: unknown[]) => mockQuery(sql, params as never),
  queryOneWith: (_c: unknown, sql: string, params?: unknown[]) => mockQueryOne(sql, params as never),
  executeWith: vi.fn(),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

// Imported for its side effect: registers the REAL KyberSwap decoder under
// "kyberswap", exactly as the production handler module's import does.
await import("@vex-agent/tools/protocols/kyberswap/handlers/swap/settlement-decoder.js");
// Same, for "uniswap" — the registration lives in the handler module itself.
await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const { repairPendingActivity } = await import("@vex-agent/sync/agent-activity-repair.js");
const { getActivityEventById } = await import("@vex-agent/db/repos/agent-activity.js");
const { NATIVE_TOKEN_ADDRESS } = await import("@tools/kyberswap/constants.js");

interface Receipt {
  readonly status: string;
  readonly logs: readonly { address: string; topics: string[]; data: string }[];
}

function receiptFixture(path: string): Receipt {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url)), "utf8"),
  ) as Receipt;
}

const NATIVE_IN_RECEIPT = receiptFixture("kyberswap-settlement/native-in-eth-to-rain-arbitrum.json");
const UNISWAP_NATIVE_IN_RECEIPT = receiptFixture("uniswap-settlement/native-in-base-swaprouter02.json");

/** The one substituted identity in the fixture (fixtures README § Sanitisation). */
const WALLET = "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";
const ARBITRUM_CHAIN_ID = 42161;
const RAIN = "0x25118290e6a5f4139381d072181157035864099d";

/** `tx.value` of the captured transaction — the signed native input, and what the row persists. */
const NATIVE_IN_RAW = "2600000000000000";
const RAIN_OUT_RAW = "373036464521201391922";

function stagedRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 108, protocol_execution_id: 91, event_index: 0, event_role: "swap", record_version: 1,
    kind: "swap", protocol: "kyberswap", chain_id: ARBITRUM_CHAIN_ID, chain_slug: "arbitrum",
    status: "pending", failure_code: null, failure_reason: null,
    token_in_address: NATIVE_TOKEN_ADDRESS, token_in_symbol: "NATIVE", token_in_decimals: 18,
    amount_in_human: "0.0026", amount_in_raw: NATIVE_IN_RAW,
    token_out_address: RAIN, token_out_symbol: "RAIN", token_out_decimals: 18,
    amount_out_human: null, amount_out_raw: null,
    executed_amount_in_human: null, executed_amount_in_raw: null,
    executed_amount_out_human: null, executed_amount_out_raw: null,
    token_in2_address: null, token_in2_symbol: null, token_in2_decimals: null,
    amount_in2_human: null, amount_in2_raw: null,
    executed_amount_in2_human: null, executed_amount_in2_raw: null,
    token_out2_address: null, token_out2_symbol: null, token_out2_decimals: null,
    amount_out2_human: null, amount_out2_raw: null,
    executed_amount_out2_human: null, executed_amount_out2_raw: null,
    usd_in_est: null, usd_out_est: null, usd_fee_est: null, usd_source: null,
    usd_network_gas_est: null, usd_venue_fee_est: null, usd_destination_prepay_est: null,
    usd_vex_fee_est: null, vex_fee_token_address: null, vex_fee_token_symbol: null,
    vex_fee_token_decimals: null, vex_fee_amount_raw: null, vex_fee_amount_human: null,
    tx_hash: "0x07f1d5bade588a6275e25d80b497b2f7de0414b6b3ad59e9a4bbd86d6ea80072",
    from_address: WALLET, nonce: 41,
    wallet_address: WALLET, session_id: "00000000-0000-4000-8000-000000000108",
    route_provenance: null,
    from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
    chain_family: "eip155", provider_order_id: null, normalized_route: null,
    provider_status: null, evidence_source: null, observed_at: null, last_attempted_at: null,
    submit_attempted_at: "2026-07-30T12:00:00.000Z",
    recent_blockhash: null, last_valid_block_height: null,
    broadcast_at: "2026-07-30T12:00:01.000Z",
    confirmed_at: null, last_checked_at: null,
    created_at: "2026-07-30T12:00:00.000Z", updated_at: "2026-07-30T12:00:01.000Z",
    ...over,
  };
}

async function sweepWith(receipt: unknown) {
  return repairPendingActivity({
    checkReceiptByHash: vi.fn().mockResolvedValue({ status: "success", receipt }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  table.clear();
});

describe("repair sweep — the REAL KyberSwap decoder on a REAL native-in receipt", () => {
  it("confirms a native-tokenIn swap with the signed value as the executed input", async () => {
    table.set(108, stagedRow({}));

    const result = await sweepWith(NATIVE_IN_RECEIPT);

    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
    const row = await getActivityEventById(108);
    expect(row?.status).toBe("confirmed");
    // Kyber is exact-input: the SIGNED transaction's own value IS the executed
    // native input. No log in this receipt carries it.
    expect(row?.executedAmountInRaw).toBe(NATIVE_IN_RAW);
    // Decoded from the one wallet-touching log, by net Transfer delta.
    expect(row?.executedAmountOutRaw).toBe(RAIN_OUT_RAW);
  });

  it("leaves the row pending when the native-in row has no persisted signed value", async () => {
    // A pre-C21 row (or any row whose input amount was never recorded): the
    // executed native input is then genuinely unknowable from this receipt,
    // and the decoder must DECLINE rather than guess.
    table.set(108, stagedRow({ amount_in_raw: null, amount_in_human: null }));

    const result = await sweepWith(NATIVE_IN_RECEIPT);

    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
    expect((await getActivityEventById(108))?.status).toBe("pending");
  });

  it("never uses the persisted amount for an ERC-20 input leg", async () => {
    // The row's `amount_in_raw` is the REQUESTED amount for an ERC-20 leg, not
    // an executed truth — this receipt has no wallet-side RAIN outflow, so the
    // decode must decline instead of echoing the request back as executed.
    table.set(108, stagedRow({
      token_in_address: RAIN, token_in_symbol: "RAIN",
      token_out_address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", token_out_symbol: "WETH",
      amount_in_raw: "999", amount_in_human: "0.000000000000000999",
    }));

    const result = await sweepWith(NATIVE_IN_RECEIPT);

    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
    expect((await getActivityEventById(108))?.status).toBe("pending");
  });
});

describe("repair sweep — the REAL Uniswap decoder on a REAL native-in receipt", () => {
  /** `tx.value` of the captured Base transaction — and the router's WETH `Deposit` `wad`. */
  const UNISWAP_NATIVE_IN_RAW = "230000000000000";
  const UNISWAP_OUT_RAW = "5806404302237278686";
  const UNISWAP_TOKEN_OUT = "0x55365c9e68e70122020184f4441b498e8bf06ac6";

  it("confirms a native-in swap WITHOUT the persisted amount — Uniswap has no such gap", async () => {
    // Uniswap records `token_in_address = NULL` for a native leg and reads the
    // amount from the router's WETH Deposit event, so it never needed the
    // row's persisted value. `amount_in_raw` is deliberately NULL here: the
    // proof is that the decode still succeeds without it.
    table.set(108, stagedRow({
      protocol: "uniswap", chain_id: 8453, chain_slug: "base",
      token_in_address: null, token_in_symbol: "ETH", token_in_decimals: 18,
      amount_in_raw: null, amount_in_human: null,
      token_out_address: UNISWAP_TOKEN_OUT, token_out_symbol: "TOKEN", token_out_decimals: 18,
      tx_hash: "0x1622280f77b79704f58e3a87096554fc5d960f1e79637a72e50a03e281da186a",
    }));

    const result = await sweepWith(UNISWAP_NATIVE_IN_RECEIPT);

    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
    const row = await getActivityEventById(108);
    expect(row?.status).toBe("confirmed");
    expect(row?.executedAmountInRaw).toBe(UNISWAP_NATIVE_IN_RAW);
    expect(row?.executedAmountOutRaw).toBe(UNISWAP_OUT_RAW);
  });
});
