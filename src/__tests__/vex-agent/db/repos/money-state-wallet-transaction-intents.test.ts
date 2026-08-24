/**
 * The compaction money-state gate, extended for `wallet_transaction_intents`.
 *
 * The gate is a licence to rewrite a session's transcript. It FAILS CLOSED, so
 * the property that matters is which of the nine A4b statuses BLOCK and which
 * RELEASE, and that split is decided entirely by the two new SQL branches.
 *
 * This is a unit test on a scripted client: it proves the predicate the reader
 * issues and the reasons it maps back. It does NOT prove the writer-side
 * serialization on the session control lock, which is a two-client interleaving
 * property and lives in the integration lane
 * (`__tests__/integration/engine/compaction-apply-money-gate-*.int.test.ts`).
 * Mocked SQL cannot prove a transaction boundary, and this file does not claim to.
 */

import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";

import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { WALLET_TRANSACTION_INTENT_STATUSES } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

let issuedSql = "";

function scriptedClient(rows: readonly Record<string, unknown>[]): PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      issuedSql = sql;
      return { rows: [...rows] };
    }),
  } as unknown as PoolClient;
}

/** The whitespace-normalized statement, so the assertions read like the SQL does. */
function normalized(): string {
  return issuedSql.replace(/\s+/g, " ");
}

describe("the gate reads wallet_transaction_intents", () => {
  it("issues both new branches in the same single round trip", async () => {
    await getUnresolvedMoneyStateForSession(scriptedClient([]), "session-1");
    const sql = normalized();
    expect(sql).toContain("FROM wallet_transaction_intents t");
    // One statement, one lock hold: the gate runs on the critical path of every
    // apply while the session control lock is held.
    expect(sql.split("FROM wallet_transaction_intents").length - 1).toBe(2);
    expect(sql).toContain("t.session_id = $1");
  });

  it("BLOCKS on consuming, broadcast_unconfirmed, and unexpired pending", async () => {
    await getUnresolvedMoneyStateForSession(scriptedClient([]), "session-1");
    const sql = normalized();
    // `broadcast_unconfirmed` is the whole point of the extension: the bytes
    // are on the network and the outcome is not provable yet, which is exactly
    // an unresolved money state.
    expect(sql).toContain(
      "t.status IN ('consuming', 'broadcast_unconfirmed') OR (t.status = 'pending' AND t.expires_at > NOW())",
    );
  });

  it("RELEASES on every proven or never-signed terminal", async () => {
    await getUnresolvedMoneyStateForSession(scriptedClient([]), "session-1");
    const sql = normalized();
    // The staged-hash rule, written as defence in depth against a future status
    // added to the migration's CHECK without a thought for this gate.
    expect(sql).toContain(
      "t.tx_hash IS NOT NULL AND t.status NOT IN ('executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed')",
    );
  });

  it("classifies every one of the nine statuses, with none left unconsidered", async () => {
    await getUnresolvedMoneyStateForSession(scriptedClient([]), "session-1");
    const sql = normalized();
    // A status that appears in NEITHER the live set nor the proven-terminal set
    // is a status nobody decided about. `audit_failed`, `cancelled` and
    // `expired` are decided by carrying no hash, which the migration's evidence
    // CHECK enforces, so they are named here rather than in the SQL.
    const blocking = ["consuming", "broadcast_unconfirmed", "pending"];
    const releasedByProof = ["executed", "failed", "superseded_unproven"];
    const releasedByHavingNoHash = ["audit_failed", "cancelled", "expired"];
    expect(
      [...blocking, ...releasedByProof, ...releasedByHavingNoHash].sort(),
    ).toEqual([...WALLET_TRANSACTION_INTENT_STATUSES].sort());
    for (const status of [...blocking, ...releasedByProof]) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it("maps the rows back to their own reason kinds", async () => {
    const state = await getUnresolvedMoneyStateForSession(
      scriptedClient([
        { kind: "wallet_transaction_intent_live", ref: "wtx-1", detail: "broadcast_unconfirmed" },
        { kind: "wallet_transaction_confirmation_unknown", ref: "wtx-2", detail: "consuming" },
      ]),
      "session-1",
    );
    expect(state.clear).toBe(false);
    if (state.clear) return;
    expect(state.reasons).toEqual([
      { kind: "wallet_transaction_intent_live", ref: "wtx-1", detail: "broadcast_unconfirmed" },
      { kind: "wallet_transaction_confirmation_unknown", ref: "wtx-2", detail: "consuming" },
    ]);
  });

  it("still answers `clear` when the session has nothing in flight", async () => {
    const state = await getUnresolvedMoneyStateForSession(scriptedClient([]), "session-1");
    expect(state).toEqual({ clear: true });
  });

  it("does not disturb the transfer table's own branches", async () => {
    await getUnresolvedMoneyStateForSession(scriptedClient([]), "session-1");
    const sql = normalized();
    expect(sql).toContain("FROM wallet_intents w");
    expect(sql).toContain("'wallet_intent_live'");
    expect(sql).toContain("'wallet_confirmation_unknown'");
  });
});
