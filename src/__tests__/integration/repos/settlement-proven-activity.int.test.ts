/**
 * THE SETTLEMENT-PROVEN EXCHANGE ROW, AGAINST REAL POSTGRESQL.
 *
 * Everything this file proves is a property of the SCHEMA, and a fake client
 * proves none of it: which shapes the `agent_activity` CHECK matrix admits for
 * `kind='exchange'`, that the row the writer produces is exactly the shape the
 * EVM claim lane selects, and that the compaction safe-moment gate stops
 * blocking once the chain settles it.
 *
 * The matrix under test, arm by arm:
 *
 *   - `exchange_deposit` (an input leg: the asset left the wallet) is accepted;
 *   - `exchange_withdrawal` (an output leg: the asset arrived) is accepted;
 *   - the same row WITHOUT a nonce is refused by the writer before any SQL
 *     runs, because 045's `agent_activity_evm_signed_leg_has_nonce` is what
 *     would reject it and a refusal inside the caller's transaction would take
 *     the caller's money transition down with it;
 *   - a non-bridge row that sets `evidence_source` is refused BY THE DATABASE
 *     (049's `agent_activity_non_bridge_no_bridge_cols`), which is why the
 *     writer never sets it and why "record it as an observed row instead" is
 *     not an available fallback for an unsigned leg.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { execute, getPool, query, queryOne } from "@vex-agent/db/client.js";
import { createSession } from "@vex-agent/db/repos/sessions.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import {
  claimDuePendingEvm,
  confirmActivityEventStatusOnly,
} from "@vex-agent/db/repos/agent-activity.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  insertSettlementProvenActivityRowWith,
  type SettlementProvenActivityInput,
} from "@vex-agent/db/repos/agent-activity/settlement-proven.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const sessions: string[] = [];

afterEach(async () => {
  if (sessions.length === 0) return;
  const ids = sessions.splice(0, sessions.length);
  await execute("DELETE FROM agent_activity WHERE session_id = ANY($1::text[])", [ids]);
  await execute("DELETE FROM protocol_executions WHERE session_id = ANY($1::text[])", [ids]);
  await execute("DELETE FROM sessions WHERE id = ANY($1::text[])", [ids]);
});

async function newSession(): Promise<string> {
  const id = `r3c-${randomUUID()}`;
  await createSession(id);
  sessions.push(id);
  return id;
}

function freshHash(): string {
  return `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

function input(
  sessionId: string,
  overrides: Partial<SettlementProvenActivityInput> = {},
): SettlementProvenActivityInput {
  return {
    eventRole: "exchange_deposit",
    protocol: "lighter",
    sessionId,
    walletAddress: WALLET,
    execution: {
      toolId: "lighter.deposit",
      namespace: "lighter",
      intentParams: { intentId: "lighter-onboard-r3c" },
    },
    chainId: 1,
    txHash: freshHash(),
    fromAddress: WALLET,
    nonce: 7,
    asset: { address: USDC, symbol: "USDC", decimals: 6 },
    amountRaw: "11000000",
    venueEvidence: {
      source: "lighter_client_reported",
      environment: "core",
      accountIndex: 42,
      lighterTxHash: "lighter-tx-hash",
      lighterBlockHeight: 313_485_202,
    },
    ...overrides,
  };
}

/** Write the row the way production does: the caller's transaction, its lock. */
function writeRow(sessionId: string, overrides: Partial<SettlementProvenActivityInput> = {}) {
  return withSessionControlLock(sessionId, (client) =>
    insertSettlementProvenActivityRowWith(client, input(sessionId, overrides)));
}

async function readMoneyState(sessionId: string) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    return await getUnresolvedMoneyStateForSession(client, sessionId);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe("the exchange CHECK matrix", () => {
  it("accepts an exchange_deposit row and records the spend as the input leg", async () => {
    const sessionId = await newSession();
    const txHash = freshHash().toUpperCase().replace("0X", "0x");

    const outcome = await writeRow(sessionId, { txHash });

    expect(outcome.outcome).toBe("recorded");
    if (outcome.outcome !== "recorded") throw new Error("expected a recorded row");
    const row = await queryOne<Record<string, unknown>>(
      "SELECT * FROM agent_activity WHERE id = $1",
      [outcome.activityId],
    );
    expect(row).toMatchObject({
      kind: "exchange",
      event_role: "exchange_deposit",
      chain_family: "eip155",
      protocol: "lighter",
      status: "pending",
      chain_id: "1",
      token_in_address: USDC,
      amount_in_raw: "11000000",
      // Exact decimal rendering derived from the raw amount and its decimals,
      // never a float and never a second number the caller could disagree with.
      amount_in_human: "11",
      token_out_address: null,
      amount_out_raw: null,
      // Every column 049's non-bridge CHECK forbids stays NULL, and the two
      // that would additionally disqualify the row from the claim lane are the
      // reason: `evidence_source` forbids a sender, a nonce and a submit stamp.
      evidence_source: null,
      observed_at: null,
      normalized_route: null,
      provider_order_id: null,
      from_chain_id: null,
      to_chain_id: null,
      confirmed_at: null,
      failure_code: null,
    });
    // Stored lowercase so migration 044's UNIQUE partial index on `tx_hash`
    // actually holds: one broadcast can back exactly one activity row, and a
    // case variant would defeat that.
    expect(row?.tx_hash).toBe(txHash.toLowerCase());
    expect(row?.nonce).toBe("7");
    expect(row?.submit_attempted_at).not.toBeNull();
    // The venue credit is CLIENT-REPORTED evidence (AgentScan contract R2.7):
    // it rides in provenance, never in a column a reader could mistake for a
    // proven settlement fact.
    expect(row?.route_provenance).toMatchObject({
      environment: "core",
      accountIndex: 42,
      lighterTxHash: "lighter-tx-hash",
    });
  });

  it("accepts an exchange_withdrawal row and records the receipt as the output leg", async () => {
    const sessionId = await newSession();

    const outcome = await writeRow(sessionId, { eventRole: "exchange_withdrawal" });

    expect(outcome.outcome).toBe("recorded");
    if (outcome.outcome !== "recorded") throw new Error("expected a recorded row");
    const row = await queryOne<Record<string, unknown>>(
      "SELECT * FROM agent_activity WHERE id = $1",
      [outcome.activityId],
    );
    expect(row).toMatchObject({
      kind: "exchange",
      event_role: "exchange_withdrawal",
      status: "pending",
      token_out_address: USDC,
      amount_out_raw: "11000000",
      token_in_address: null,
      amount_in_raw: null,
    });
  });

  it("refuses a row with no nonce before any SQL runs, and leaves the caller's transaction usable", async () => {
    const sessionId = await newSession();

    const outcome = await withSessionControlLock(sessionId, async (client) => {
      const refused = await insertSettlementProvenActivityRowWith(
        client,
        input(sessionId, { nonce: null }),
      );
      // The transaction is still healthy: a refusal is a decision, not an
      // aborted statement, so the caller's own money write can still commit.
      await client.query("SELECT 1");
      return refused;
    });

    expect(outcome).toMatchObject({ outcome: "refused", reason: "no_signed_leg" });
    const rows = await query("SELECT id FROM agent_activity WHERE session_id = $1", [sessionId]);
    expect(rows).toHaveLength(0);
    const executions = await query(
      "SELECT id FROM protocol_executions WHERE session_id = $1",
      [sessionId],
    );
    expect(executions).toHaveLength(0);
  });

  it("has the database itself refuse an exchange row that names an evidence source", async () => {
    const sessionId = await newSession();
    const outcome = await writeRow(sessionId);
    if (outcome.outcome !== "recorded") throw new Error("expected a recorded row");

    // The writer never sets `evidence_source`. This proves it COULD not: the
    // non-bridge CHECK rejects it, which is exactly why an unsigned leg has no
    // observed-row fallback and must be refused instead.
    await expect(
      execute(
        `UPDATE agent_activity SET evidence_source = 'lighter_account' WHERE id = $1`,
        [outcome.activityId],
      ),
    ).rejects.toThrow(/agent_activity_non_bridge_no_bridge_cols/);
  });

  it("returns the existing row for a settlement transaction that is already recorded", async () => {
    const sessionId = await newSession();
    const txHash = freshHash();

    const first = await writeRow(sessionId, { txHash });
    const second = await writeRow(sessionId, { txHash });

    if (first.outcome !== "recorded") throw new Error("expected a recorded row");
    expect(second).toMatchObject({ outcome: "already_recorded", activityId: first.activityId });
    const rows = await query("SELECT id FROM agent_activity WHERE LOWER(tx_hash) = $1", [
      txHash.toLowerCase(),
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe("the row the claim lane owns", () => {
  it("is claimed and confirmed by the existing EVM claim lane, and stops blocking the compaction gate", async () => {
    const sessionId = await newSession();
    const outcome = await writeRow(sessionId);
    if (outcome.outcome !== "recorded") throw new Error("expected a recorded row");

    // The durable execution this call opened is already COMPLETE. An execution
    // left at `intent` is unresolved money state in its own right, and nothing
    // else would ever come back to finish this one.
    const execution = await queryOne<{ execution_status: string }>(
      "SELECT execution_status FROM protocol_executions WHERE id = $1",
      [outcome.executionId],
    );
    expect(execution?.execution_status).toBe("succeeded");

    // Pending, so the gate defers: a settlement whose receipt we have not read
    // is exactly the state a transcript rewrite must not race.
    const blocked = await readMoneyState(sessionId);
    expect(blocked.clear).toBe(false);
    if (blocked.clear) throw new Error("expected the pending row to block");
    expect(blocked.reasons.map((reason) => reason.kind)).toContain("agent_activity_pending");

    // The claim's own due predicate: pending, eip155, a hash, a submit stamp.
    // Backdated so the row is due without a wall-clock wait.
    await execute(
      `UPDATE agent_activity
          SET submit_attempted_at = NOW() - make_interval(secs => 600)
        WHERE id = $1`,
      [outcome.activityId],
    );
    const claim = await claimDuePendingEvm(25);
    const claimed = claim.claimed.find((entry) => entry.row.id === outcome.activityId);
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error("the claim lane did not select the settlement row");
    expect(claimed.row.txHash).not.toBeNull();
    expect(claimed.row.nonce).toBe(7);

    const confirmed = await confirmActivityEventStatusOnly(
      outcome.activityId,
      "receipt_status_only_evm",
      { kind: "claim", claimToken: claimed.claimToken },
    );
    expect(confirmed.applied).toBe(true);
    expect(confirmed.row.status).toBe("confirmed");

    const cleared = await readMoneyState(sessionId);
    expect(cleared.clear).toBe(true);
  });
});
