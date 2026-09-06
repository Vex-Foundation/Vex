/**
 * Integration: the pending-debit compensation's in-flight query against REAL
 * Postgres.
 *
 * The unit suite proves the POLICY through an injected reader. It structurally
 * cannot prove the one thing the whole compensation rests on: that the SQL
 * string in `readInFlightBroadcast` parses against the real schema and its
 * predicates match production row shapes. That query gates spendability on
 * every chain whose `pending` tag is an alias for `latest` (14 of 18 measured
 * endpoints), and its failure mode is fail-closed - a column or status-name
 * error would refuse EVERY swap on those chains, loudly but wrongly. Real
 * columns, real CHECK constraints, real `lower()` semantics.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { queryOne } from "@vex-agent/db/client.js";
import { readInFlightBroadcast } from "@vex-agent/tools/protocols/quote-authority/pending-debit-compensation.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0xAbCd000000000000000000000000000000000001";
const CHAIN = 42161;

async function insertProtocolExecution(sessionId: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO protocol_executions
       (tool_id, namespace, session_id, params, result, success, external_refs, execution_status)
     VALUES ('swap_execute', 'agentscan', $1, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb, 'succeeded')
     RETURNING id`,
    [sessionId],
  );
  if (row === null) throw new Error("protocol_executions insert returned no row");
  return row.id;
}

async function insertActivity(input: {
  sessionId: string;
  status: "pending" | "confirmed";
  txHash: string | null;
  chainId?: number;
  fromAddress?: string;
}): Promise<void> {
  const executionId = await insertProtocolExecution(input.sessionId);
  await queryOne(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_role, kind, protocol, chain_family, chain_id,
        wallet_address, session_id, status, from_address, nonce, tx_hash, confirmed_at,
        executed_amount_in_raw, executed_amount_out_raw)
     VALUES ($1, 'swap', 'swap', 'kyberswap', 'eip155', $2, $3, $4, $5, $3,
             CASE WHEN $6::text IS NULL THEN NULL ELSE 7 END, $6,
             CASE WHEN $5 = 'confirmed' THEN NOW() ELSE NULL END,
             CASE WHEN $5 = 'confirmed' THEN '1' ELSE NULL END,
             CASE WHEN $5 = 'confirmed' THEN '1' ELSE NULL END)
     RETURNING id`,
    [executionId, input.chainId ?? CHAIN, input.fromAddress ?? WALLET,
     input.sessionId, input.status, input.txHash],
  );
}

let nextNonce = 5;

async function insertReservation(input: {
  status: "reserved" | "staged" | "accepted" | "terminal";
  chainId?: number;
  fromAddress?: string;
}): Promise<void> {
  const hash = input.status === "reserved" ? null : `0xres-${Math.random().toString(16).slice(2)}`;
  // Each row takes its own nonce: the schema enforces one ACTIVE reservation
  // per (chain, wallet, nonce), which is exactly the production invariant.
  nextNonce += 1;
  await queryOne(
    `INSERT INTO evm_nonce_reservations
       (chain_id, from_address, nonce, status, tx_hash, purpose, terminal_at)
     VALUES ($1, $2, $3, $4, $5, 'pendle_allowance',
             CASE WHEN $4 IN ('terminal', 'abandoned') THEN NOW() ELSE NULL END)
     RETURNING id`,
    [input.chainId ?? CHAIN, input.fromAddress ?? WALLET, nextNonce, input.status, hash],
  );
}

beforeEach(async () => {
  await resetDb();
});

describe("readInFlightBroadcast against the real schema", () => {
  it("answers false on an empty record - the SQL parses and both EXISTS branches run", async () => {
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(false);
  });

  it("a pending activity row WITH a tx hash is in flight", async () => {
    const sessionId = await makeSession();
    await insertActivity({ sessionId, status: "pending", txHash: "0xbeef" });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(true);
  });

  it("a pending row WITHOUT a hash is a reservation, not a broadcast - not in flight", async () => {
    const sessionId = await makeSession();
    await insertActivity({ sessionId, status: "pending", txHash: null });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(false);
  });

  it("a confirmed row is terminal - not in flight", async () => {
    const sessionId = await makeSession();
    await insertActivity({ sessionId, status: "confirmed", txHash: "0xdead" });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(false);
  });

  it("staged and accepted nonce reservations are in flight; reserved and terminal are not", async () => {
    await insertReservation({ status: "reserved" });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(false);
    await insertReservation({ status: "staged" });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(true);
    await resetDb();
    await insertReservation({ status: "terminal" });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(false);
    await insertReservation({ status: "accepted" });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(true);
  });

  it("matches the wallet case-insensitively, exactly like the durable writers", async () => {
    const sessionId = await makeSession();
    await insertActivity({
      sessionId, status: "pending", txHash: "0xcafe",
      fromAddress: WALLET.toUpperCase().replace("0X", "0x"),
    });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET.toLowerCase() })).toBe(true);
  });

  it("another chain's broadcast does not block this chain", async () => {
    const sessionId = await makeSession();
    await insertActivity({ sessionId, status: "pending", txHash: "0xf00d", chainId: 8453 });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(false);
  });

  it("another wallet's broadcast does not block this wallet", async () => {
    const sessionId = await makeSession();
    await insertActivity({
      sessionId, status: "pending", txHash: "0xaaaa",
      fromAddress: "0x9999000000000000000000000000000000000009",
    });
    expect(await readInFlightBroadcast({ chainId: CHAIN, wallet: WALLET })).toBe(false);
  });
});
