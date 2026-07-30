/**
 * The EVM repair sweep against REAL Pendle receipts, end to end through the
 * REAL finalizer.
 *
 * A pending `yield_py` row is the shape the sweep exists for: the action is
 * broadcast, confirmation is ambiguous, and the row must be finalized later
 * from the receipt alone. Migration 053 makes such a row a TWO-INSTRUMENT row —
 * PT and YT both out on a mint, both in on a redeem — and
 * `confirmActivityEvent`'s `assertYieldConfirmLegs` REFUSES to confirm it
 * unless the caller supplies the matching `executedAmount{In,Out}2Raw`.
 *
 * NOTHING IS STUBBED BETWEEN THE SWEEP AND THAT GUARD. Only the Postgres
 * client (`@vex-agent/db/client.js`) is faked, by an in-memory table that
 * answers the three statements this path issues (candidate list, row read,
 * confirm CAS). The repo module, `mapRow`, `confirmActivityEvent` and
 * `assertYieldConfirmLegs` are the production ones — so a confirm that would
 * throw in production throws here, and a row reported as `confirmed` really
 * satisfied the per-role leg contract.
 *
 * The receipts are the real mainnet captures in `fixtures/pendle-settlement/`
 * (see its README). The dual-LP case is the one constructed receipt — Pendle
 * dual-sided LP has no capture in that folder yet — built from the SAME
 * ERC-20 Transfer layout, with the topic taken out of a real fixture log so it
 * cannot drift from the shape the chain actually emits.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach } from "vitest";

type SqlParams = readonly unknown[] | undefined;

/** The in-memory `agent_activity` table backing the faked client, keyed by id. */
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
      confirmed_at: "2026-07-27T09:05:00.000Z",
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

const mockExecute = vi.fn(async () => 0);

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: SqlParams) => mockQuery(sql, params),
  queryOne: (sql: string, params?: SqlParams) => mockQueryOne(sql, params),
  execute: (sql: string, params?: SqlParams) => mockExecute(sql, params),
  // The agent-activity CAS writers now run inside a session-control-locked
  // transaction, so they reach the `…With` client variants. Routed to the SAME
  // fakes as their pool-level twins: the statement under test is identical, only
  // the connection it travels on changed.
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

// Imported for its side effect: the module registers itself under "pendle" in
// the shared decoder registry, exactly as the production worker's import does.
await import("@vex-agent/sync/pendle-settlement-decoder.js");
const { repairPendingActivity } = await import("@vex-agent/sync/agent-activity-repair.js");
const { getActivityEventById } = await import("@vex-agent/db/repos/agent-activity.js");

interface Receipt {
  readonly logs: readonly { address: string; topics: string[]; data: string }[];
}

function receiptFixture(name: string): Receipt {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/pendle-settlement/${name}.json`, import.meta.url)),
      "utf8",
    ),
  ) as Receipt;
}

const PY_MINT_RECEIPT = receiptFixture("py-mint-reusd");
const PY_REDEEM_RECEIPT = receiptFixture("py-redeem-reusd");

/** The one substituted identity in every fixture (fixtures README § Sanitisation). */
const WALLET = "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";
const REUSD_PT = "0xecfafdc7741323a945a163ed068b5a3c43483957";
const REUSD_YT = "0xa8bd3b21291ace53927b35563fc80615919e63d7";
const REUSD_TOKEN = "0x5086bf358635b81d8c47c66d1c8b9e567db70c72";

const MINT_IN_RAW = "73304758069703379880585";
const MINT_PT_OUT_RAW = "79998655357";
const MINT_YT_OUT_RAW = "79998655357";

const REDEEM_PT_IN_RAW = "150000000000";
const REDEEM_YT_IN_RAW = "150000000000";
const REDEEM_OUT_RAW = "137448731623104581990917";

/**
 * The ERC-20 `Transfer` topic as it appears in a REAL fixture log, not as a
 * literal retyped here — the constructed dual-LP receipt below must share the
 * chain's own layout, and re-deriving it from the capture is what guarantees
 * that.
 */
const TRANSFER_TOPIC = (() => {
  const log = PY_MINT_RECEIPT.logs.find((l) => l.topics.length === 3);
  if (!log?.topics[0]) throw new Error("fixture has no ERC-20 Transfer log to read the topic from");
  return log.topics[0];
})();

function padded(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function amountWord(value: string): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function transferLog(token: string, from: string, to: string, amount: string) {
  return { address: token, topics: [TRANSFER_TOPIC, padded(from), padded(to)], data: amountWord(amount) };
}

/**
 * A staged `agent_activity` row as the DB stores it (snake_case), so the
 * production `mapRow` does the mapping rather than the test.
 */
function stagedRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 7, protocol_execution_id: 71, event_index: 0, event_role: "yield_py", record_version: 1,
    kind: "yield", protocol: "pendle", chain_id: 1, chain_slug: "ethereum",
    status: "pending", failure_code: null, failure_reason: null,
    token_in_address: null, token_in_symbol: null, token_in_decimals: null,
    amount_in_human: null, amount_in_raw: null,
    token_out_address: null, token_out_symbol: null, token_out_decimals: null,
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
    tx_hash: "0x286f172db9963e6084fcb0f9c1a23918314a0afaf23fe0badf85d6825157cd5c",
    from_address: WALLET, nonce: 12,
    wallet_address: WALLET, session_id: "00000000-0000-4000-8000-000000000007",
    route_provenance: null,
    from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
    chain_family: "eip155", provider_order_id: null, normalized_route: null,
    provider_status: null, evidence_source: null, observed_at: null, last_attempted_at: null,
    submit_attempted_at: "2026-07-27T09:00:00.000Z",
    recent_blockhash: null, last_valid_block_height: null,
    broadcast_at: "2026-07-27T09:00:01.000Z",
    confirmed_at: null, last_checked_at: null,
    created_at: "2026-07-27T09:00:00.000Z", updated_at: "2026-07-27T09:00:01.000Z",
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

describe("repair sweep — Option-C second legs survive to the real finalizer", () => {
  it("confirms a real PY mint with BOTH out-legs (PT + YT)", async () => {
    table.set(7, stagedRow({
      event_role: "yield_py",
      token_in_address: REUSD_TOKEN, token_in_symbol: "reUSD", token_in_decimals: 18,
      amount_in_raw: MINT_IN_RAW,
      token_out_address: REUSD_PT, token_out_symbol: "PT-reUSD", token_out_decimals: 6,
      token_out2_address: REUSD_YT, token_out2_symbol: "YT-reUSD", token_out2_decimals: 6,
    }));

    const result = await sweepWith(PY_MINT_RECEIPT);

    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
    const row = await getActivityEventById(7);
    expect(row?.status).toBe("confirmed");
    expect(row?.executedAmountInRaw).toBe(MINT_IN_RAW);
    expect(row?.executedAmountOutRaw).toBe(MINT_PT_OUT_RAW);
    // The leg the sweep used to drop. Without it the real
    // `assertYieldConfirmLegs` throws and this row never leaves `pending`.
    expect(row?.executedAmountOut2Raw).toBe(MINT_YT_OUT_RAW);
    expect(row?.executedAmountIn2Raw).toBeNull();
  });

  it("confirms a real PY redeem with BOTH in-legs (PT + YT burned for one token)", async () => {
    table.set(7, stagedRow({
      event_role: "yield_py",
      token_in_address: REUSD_PT, token_in_symbol: "PT-reUSD", token_in_decimals: 6,
      token_in2_address: REUSD_YT, token_in2_symbol: "YT-reUSD", token_in2_decimals: 6,
      token_out_address: REUSD_TOKEN, token_out_symbol: "reUSD", token_out_decimals: 18,
      tx_hash: "0x52b4c116005b5d3bdafec6b79b97de4e4e67f2c354ba1169c662af9ff5d2d18b",
    }));

    const result = await sweepWith(PY_REDEEM_RECEIPT);

    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
    const row = await getActivityEventById(7);
    expect(row?.status).toBe("confirmed");
    expect(row?.executedAmountInRaw).toBe(REDEEM_PT_IN_RAW);
    expect(row?.executedAmountIn2Raw).toBe(REDEEM_YT_IN_RAW);
    expect(row?.executedAmountOutRaw).toBe(REDEEM_OUT_RAW);
    expect(row?.executedAmountOut2Raw).toBeNull();
  });

  it("confirms a dual-sided LP add with BOTH in-legs", async () => {
    // CONSTRUCTED, and the only constructed receipt in this file: the fixture
    // folder carries no dual-sided Pendle LP capture yet. Layout is the real
    // one — the ERC-20 Transfer topic is read out of the mint capture above,
    // the wallet is the same sanitised identity, and the amounts differ by
    // magnitude across decimals exactly as the real captures do. Replace this
    // with a real receipt the first time one is observed.
    const LP_TOKEN = "0x1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c";
    const OTHER = "0x2222222222222222222222222222222222222222";
    const receipt: Receipt = {
      logs: [
        transferLog(REUSD_PT, WALLET, OTHER, "150000000000"),
        transferLog(REUSD_TOKEN, WALLET, OTHER, "137448731623104581990917"),
        transferLog(LP_TOKEN, OTHER, WALLET, "144000000000000000000000"),
      ],
    };

    table.set(7, stagedRow({
      event_role: "yield_lp",
      token_in_address: REUSD_PT, token_in_symbol: "PT-reUSD", token_in_decimals: 6,
      token_in2_address: REUSD_TOKEN, token_in2_symbol: "reUSD", token_in2_decimals: 18,
      token_out_address: LP_TOKEN, token_out_symbol: "LP-reUSD", token_out_decimals: 18,
      tx_hash: "0x0000000000000000000000000000000000000000000000000000000000000abc",
    }));

    const result = await sweepWith(receipt);

    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
    const row = await getActivityEventById(7);
    expect(row?.status).toBe("confirmed");
    expect(row?.executedAmountInRaw).toBe("150000000000");
    expect(row?.executedAmountIn2Raw).toBe("137448731623104581990917");
    expect(row?.executedAmountOutRaw).toBe("144000000000000000000000");
  });

  it("leaves a two-instrument row PENDING when the receipt cannot prove the second leg", async () => {
    // The safety half of the same contract: the decoder declines the WHOLE
    // decode when a promised leg is absent, so the sweep must not confirm a
    // half-proven two-instrument row — it re-checks it instead.
    table.set(7, stagedRow({
      event_role: "yield_py",
      token_in_address: REUSD_TOKEN, token_in_decimals: 18,
      token_out_address: REUSD_PT, token_out_decimals: 6,
      // A token this receipt never credited.
      token_out2_address: "0x808507121b80c02388fad14726482e061b8da827",
    }));

    const result = await sweepWith(PY_MINT_RECEIPT);

    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
    expect((await getActivityEventById(7))?.status).toBe("pending");
  });
});
