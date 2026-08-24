/**
 * `wallet_transaction_intents` repo - the CAS PREDICATES and the strict row
 * parser, against a scripted `PoolClient`.
 *
 * What these tests are for: every mutation in this repo is a compare-and-swap
 * whose WHERE clause IS the safety property. `claimIfPendingWith` refusing a
 * drifted proposal digest, `markExecutedWith` only accepting a `consuming`
 * row, and every statement carrying `session_id` are not implementation
 * details; they are the reasons an intent cannot be consumed twice, consumed
 * after its proposal changed, or consumed by another session that learned the
 * id. So the SQL each function emits is inspected directly.
 *
 * What they are NOT: a substitute for the live-PostgreSQL lifecycle tests the
 * second pass of this arc owns (the coupled WTI + agent_activity +
 * protocol_executions transitions T3d, T4a/T4b, T5 and T6). A scripted client
 * cannot prove a transaction boundary. It can prove the predicates, which is
 * what the primitives shipped here are.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { PoolClient } from "pg";

import * as repo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const calls: QueryCall[] = [];

function durableRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent_id: "wtx-1",
    session_id: "session-1",
    wallet_address: "0x1111111111111111111111111111111111111111",
    family: "eip155",
    chain_alias: "base",
    chain_id: "8453",
    payload_json: {
      to: "0x2222222222222222222222222222222222222222",
      data: "0xa9059cbb",
      valueWei: "0",
    },
    decoded_json: {
      family: "eip155",
      role: "contract_call",
      standard: "erc20",
      functionName: "transfer",
      contract: "0x2222222222222222222222222222222222222222",
      criticalArgs: { amountRaw: "1000000" },
      unlimitedApproval: false,
      warnings: [],
    },
    preview_json: { label: "Call transfer", criticalArgs: { chain: "base" } },
    fee_bounds_json: {
      mode: "eip1559",
      gasLimit: "60000",
      maxFeePerGasWei: "2000000000",
      maxPriorityFeePerGasWei: "1000000000",
      maxTotalFeeWei: "120000000000000",
    },
    proposal_digest: "d".repeat(64),
    proposal_digest_version: PROPOSAL_DIGEST_VERSION,
    recent_blockhash: null,
    last_valid_block_height: null,
    status: "pending",
    failure_stage: null,
    activity_id: null,
    expires_at: new Date("2026-08-24T12:00:00.000Z"),
    consumed_at: null,
    cancelled_at: null,
    tx_hash: null,
    failure_reason: null,
    created_at: new Date("2026-08-24T11:50:00.000Z"),
    ...overrides,
  };
}

let nextRows: Record<string, unknown>[] = [];

const client = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { rows: nextRows };
  }),
} as unknown as PoolClient;

beforeEach(() => {
  calls.length = 0;
  nextRows = [durableRow()];
  (client.query as unknown as { mockClear: () => void }).mockClear();
});

function lastSql(): string {
  const call = calls[calls.length - 1];
  if (call === undefined) throw new Error("no query was issued");
  return call.sql;
}

/** The SET clause only. `RETURNING` names every column, so a whole-statement
 * search cannot answer "does this write touch tx_hash?". */
function lastSetClause(): string {
  const sql = lastSql();
  const start = sql.indexOf("SET ");
  const end = sql.indexOf("WHERE ");
  if (start === -1 || end === -1) throw new Error("not an UPDATE with SET and WHERE");
  return sql.slice(start, end);
}

function lastParams(): readonly unknown[] {
  const call = calls[calls.length - 1];
  if (call === undefined) throw new Error("no query was issued");
  return call.params;
}

// ── The invariant that holds for every statement ─────────────────────

describe("every mutation is session-scoped", () => {
  const mutations: readonly [string, () => Promise<unknown>][] = [
    ["claimIfPendingWith", () => repo.claimIfPendingWith(client, "wtx-1", "session-1", "d".repeat(64))],
    ["stampActivityWith", () => repo.stampActivityWith(client, "wtx-1", "session-1", "42")],
    ["markExecutedWith", () => repo.markExecutedWith(client, "wtx-1", "session-1", "0xhash")],
    ["markChainFailedWith", () => repo.markChainFailedWith(client, "wtx-1", "session-1", "0xhash", "K:1")],
    ["markPreBroadcastFailedWith", () => repo.markPreBroadcastFailedWith(client, "wtx-1", "session-1", "K:1")],
    ["markBroadcastUnconfirmedWith", () => repo.markBroadcastUnconfirmedWith(client, "wtx-1", "session-1", "0xhash")],
    ["markCrashedBeforeBroadcastWith", () => repo.markCrashedBeforeBroadcastWith(client, "wtx-1", "session-1", "K:1")],
    ["markAuditFailedWith", () => repo.markAuditFailedWith(client, "wtx-1", "session-1", "K:1")],
    ["settleUnconfirmedAsExecutedWith", () => repo.settleUnconfirmedAsExecutedWith(client, "wtx-1", "session-1")],
    ["settleUnconfirmedAsChainFailedWith", () => repo.settleUnconfirmedAsChainFailedWith(client, "wtx-1", "session-1", "K:1")],
    ["markSupersededUnprovenWith", () => repo.markSupersededUnprovenWith(client, "wtx-1", "session-1", "K:1")],
    ["cancelIfPendingWith", () => repo.cancelIfPendingWith(client, "wtx-1", "session-1")],
    ["expireStalePendingWith", () => repo.expireStalePendingWith(client, "session-1")],
  ];

  for (const [name, run] of mutations) {
    it(`${name} carries session_id in its predicate`, async () => {
      await run();
      // An intent id is not a capability: another session that learned one must
      // miss, not act.
      expect(lastSql()).toMatch(/session_id = \$/);
    });
  }
});

// ── T1 ───────────────────────────────────────────────────────────────

describe("T1 create", () => {
  it("writes the fifteen columns positionally with the JSONB casts", async () => {
    nextRows = [];
    await repo.createWith(client, {
      intentId: "wtx-1",
      sessionId: "session-1",
      walletAddress: "0x1111111111111111111111111111111111111111",
      family: "eip155",
      chainAlias: "base",
      chainId: 8453,
      payload: {
        family: "eip155",
        evm: { to: "0x2222222222222222222222222222222222222222", data: "0x", valueWei: "1" },
      },
      decoded: durableRow().decoded_json as never,
      preview: { label: "Call transfer", criticalArgs: {} },
      feeBounds: {
        mode: "legacy",
        gasLimit: "21000",
        gasPriceWei: "1000000000",
        maxTotalFeeWei: "21000000000000",
      },
      proposalDigest: "d".repeat(64),
      proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
      recentBlockhash: null,
      lastValidBlockHeight: null,
      expiresAt: "2026-08-24T12:00:00.000Z",
    });
    const sql = lastSql();
    expect(sql).toContain("INSERT INTO wallet_transaction_intents");
    // The four JSONB columns are cast explicitly rather than handed to `pg` as
    // objects, matching the transfer repo and migration 087's column order.
    expect(sql).toContain("$7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb");
    expect(lastParams()).toHaveLength(15);
    // No status is written: the column defaults to `pending`, so there is one
    // owner of the initial state and it is the migration.
    expect(sql).not.toContain("status,");
  });
});

// ── T2 ───────────────────────────────────────────────────────────────

describe("T2 claim", () => {
  it("puts the proposal digest IN the predicate, not in a later comparison", async () => {
    await repo.claimIfPendingWith(client, "wtx-1", "session-1", "d".repeat(64));
    const sql = lastSql();
    expect(sql).toContain("status = 'consuming'");
    expect(sql).toMatch(/AND status = 'pending'/);
    expect(sql).toMatch(/AND expires_at > NOW\(\)/);
    // The point: a digest compared AFTER a successful claim would already have
    // consumed a row whose proposal drifted, leaving a `consuming` intent
    // nobody may execute. In the predicate, the row stays `pending`.
    expect(sql).toMatch(/AND proposal_digest = \$3/);
  });

  it("returns null when the predicate misses, and null is the only race signal", async () => {
    nextRows = [];
    await expect(
      repo.claimIfPendingWith(client, "wtx-1", "session-1", "wrong-digest"),
    ).resolves.toBeNull();
  });

  it("stampActivityWith refuses a second stamp instead of repointing the link", async () => {
    await repo.stampActivityWith(client, "wtx-1", "session-1", "42");
    expect(lastSql()).toContain("activity_id IS NULL");
    expect(lastSql()).toContain("status = 'consuming'");
  });
});

// ── T3, T4 ───────────────────────────────────────────────────────────

describe("T3 and T4 terminal writes", () => {
  it("T3a executed writes the hash and moves only from consuming", async () => {
    await repo.markExecutedWith(client, "wtx-1", "session-1", "0xhash");
    expect(lastSql()).toContain("status = 'executed'");
    expect(lastSql()).toContain("AND status = 'consuming'");
  });

  it("T3b a chain failure stamps `chain_reverted` and keeps the hash", async () => {
    await repo.markChainFailedWith(client, "wtx-1", "session-1", "0xhash", "Revert:ab12");
    expect(lastSql()).toContain("failure_stage = 'chain_reverted'");
    expect(lastParams()).toContain("0xhash");
  });

  it("T3c a pre-broadcast failure writes NO hash column at all", async () => {
    await repo.markPreBroadcastFailedWith(client, "wtx-1", "session-1", "Timeout:ab12");
    expect(lastSql()).toContain("failure_stage = 'pre_broadcast'");
    // Not "writes NULL": the statement must not touch `tx_hash`, so there is no
    // shape in which a stale hash could survive into a pre-broadcast failure.
    expect(lastSetClause()).not.toContain("tx_hash");
  });

  it("T3d and T4b share one primitive: broadcast happened, outcome unprovable", async () => {
    await repo.markBroadcastUnconfirmedWith(client, "wtx-1", "session-1", "0xhash");
    const sql = lastSql();
    expect(sql).toContain("status = 'broadcast_unconfirmed'");
    // Never `failed` with a hash: that shape cannot be told apart from a
    // revert, and a caller who reads "failed" retries.
    expect(lastSetClause()).not.toContain("'failed'");
  });

  it("T4a a crash with no staged hash is honestly terminal and hashless", async () => {
    await repo.markCrashedBeforeBroadcastWith(client, "wtx-1", "session-1", "Crash:ab12");
    expect(lastSql()).toContain("failure_stage = 'crashed_before_broadcast'");
    expect(lastSetClause()).not.toContain("tx_hash");
  });

  it("audit_failed never writes a hash, because nothing was signed", async () => {
    await repo.markAuditFailedWith(client, "wtx-1", "session-1", "Audit:ab12");
    expect(lastSql()).toContain("status = 'audit_failed'");
    expect(lastSetClause()).not.toContain("tx_hash");
  });
});

// ── T5, T6, T7, T8 ───────────────────────────────────────────────────

describe("the repair lane and the sweeps", () => {
  it("T5 settles only from broadcast_unconfirmed, both ways", async () => {
    await repo.settleUnconfirmedAsExecutedWith(client, "wtx-1", "session-1");
    expect(lastSql()).toContain("AND status = 'broadcast_unconfirmed'");
    await repo.settleUnconfirmedAsChainFailedWith(client, "wtx-1", "session-1", "Revert:ab12");
    expect(lastSql()).toContain("failure_stage = 'chain_reverted'");
    expect(lastSql()).toContain("AND status = 'broadcast_unconfirmed'");
  });

  it("T6 superseded_unproven is its own terminal and retains the hash", async () => {
    await repo.markSupersededUnprovenWith(client, "wtx-1", "session-1", "Superseded:ab12");
    const sql = lastSql();
    expect(sql).toContain("status = 'superseded_unproven'");
    expect(sql).toContain("AND status = 'broadcast_unconfirmed'");
    // The hash is not cleared: it is the only handle an investigation has.
    expect(lastSetClause()).not.toContain("tx_hash");
    expect(lastParams()).toEqual(["wtx-1", "session-1", "Superseded:ab12"]);
  });

  it("T7 expires only stale pending rows, and reports what it retired", async () => {
    nextRows = [durableRow({ status: "expired" })];
    const expired = await repo.expireStalePendingWith(client, "session-1");
    expect(lastSql()).toContain("AND status = 'pending' AND expires_at <= NOW()");
    expect(expired.map((row) => row.status)).toEqual(["expired"]);
  });

  it("T8 cancel is CAS-guarded against a concurrent claim", async () => {
    await repo.cancelIfPendingWith(client, "wtx-1", "session-1");
    expect(lastSql()).toContain("status = 'cancelled'");
    expect(lastSql()).toContain("AND status = 'pending'");
  });
});

// ── The strict row parser ────────────────────────────────────────────

describe("parseDurableIntentRow", () => {
  it("parses a well-formed EVM row into the typed DTO", () => {
    const intent = repo.parseDurableIntentRow(durableRow());
    expect(intent.family).toBe("eip155");
    expect(intent.chainId).toBe(8453);
    expect(intent.payload.family).toBe("eip155");
    expect(intent.feeBounds.mode).toBe("eip1559");
    // TIMESTAMPTZ arrives as a Date and leaves as an ISO string.
    expect(intent.expiresAt).toBe("2026-08-24T12:00:00.000Z");
  });

  it("parses a Solana row and keeps its height evidence numeric", () => {
    const intent = repo.parseDurableIntentRow(
      durableRow({
        family: "solana",
        chain_alias: null,
        chain_id: null,
        payload_json: { messageBase64: "AQAB", feePayer: "11111111111111111111111111111112" },
        decoded_json: {
          family: "solana",
          role: "native_transfer",
          instructions: [
            {
              program: "system",
              variant: "transfer",
              programId: "11111111111111111111111111111112",
              criticalArgs: { lamports: "1" },
            },
          ],
          accountKeys: ["11111111111111111111111111111112"],
          addressTableLookupsResolved: false,
          warnings: [],
        },
        fee_bounds_json: {
          mode: "solana",
          computeUnitLimit: "200000",
          computeUnitPriceMicroLamports: "1000",
          baseFeeLamports: "5000",
          maxPriorityFeeLamports: "200",
          maxTotalFeeLamports: "5200",
        },
        recent_blockhash: "GfV1...",
        last_valid_block_height: "123456789",
      }),
    );
    expect(intent.lastValidBlockHeight).toBe(123456789);
    expect(intent.feeBounds.mode).toBe("solana");
  });

  it("THROWS on a malformed money row rather than returning a partial intent", () => {
    // A row we cannot parse is not a row we may act on. A best-effort mapping
    // would reach confirm as an intent with no fee bounds.
    expect(() =>
      repo.parseDurableIntentRow(durableRow({ fee_bounds_json: { mode: "eip1559" } })),
    ).toThrow();
  });

  it("THROWS when a fee bound arrives as a JSON number", () => {
    expect(() =>
      repo.parseDurableIntentRow(
        durableRow({
          fee_bounds_json: {
            mode: "legacy",
            gasLimit: 21000,
            gasPriceWei: "1",
            maxTotalFeeWei: "21000",
          },
        }),
      ),
    ).toThrow();
  });
});
