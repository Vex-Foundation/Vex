/**
 * Migration 045 bridge schema — CHECK matrix + partial UNIQUE indexes, against a
 * REAL local Postgres with 044+045 applied (the `_fixtures.ts` contract). These
 * invariants genuinely live in SQL, so a mocked client would prove nothing.
 *
 * Pins (plan §2 + REVISION 2/3/4):
 *   - kind<->role binding (R3): a swap row cannot carry a bridge role and a
 *     bridge row cannot carry a swap role;
 *   - bridge rows require route endpoints (R1); swap rows require bridge columns
 *     NULL (R3);
 *   - chain_family is NOT NULL (C4) and closed to eip155|solana;
 *   - the logical-row marker (B2): normalized_route is present IFF the row is
 *     `bridge_fill_expected`; provider_order_id lives ONLY on the logical row;
 *     the logical row is always session-scoped;
 *   - provenance (R3/B1): a provider-observed row (evidence_source set) has NO
 *     local submit/broadcast fields; the nonce matrix (Solana never has a nonce;
 *     an EVM locally-signed leg with a staged hash MUST have one);
 *   - indexes: exactly one logical row per execution; UNIQUE
 *     (protocol, provider_order_id); and the in-flight guard — at most ONE
 *     pending logical row per (wallet, session, normalized route), with a
 *     DIFFERENT route allowed alongside.
 *
 * 044 swap invariants are NOT retested here (agent-activity-*.int.test.ts own
 * them) beyond confirming a valid swap row still inserts unchanged.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";
import { execute, query } from "../../../vex-agent/db/client.js";
import { seedIntent, cleanupSeeded } from "./_fixtures.js";

afterEach(async () => {
  await cleanupSeeded();
});

async function expectReject(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow();
}

const WALLET = "0xBRIDGEW";

describe("migration 045 — bridge schema constraints", () => {
  it("kind<->role binding: a swap row rejects a bridge role, a bridge row rejects a swap role", async () => {
    const { protocolExecutionId } = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id)
         VALUES ($1, 10, 'bridge_deposit', 'swap', 'kyberswap', 8453, $2, 8453, 42161)`,
        [protocolExecutionId, WALLET],
      ),
    );
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id)
         VALUES ($1, 11, 'swap', 'bridge', 'khalani', 8453, $2, 8453, 42161)`,
        [protocolExecutionId, WALLET],
      ),
    );
  });

  it("bridge rows require route endpoints; a swap row rejects bridge columns", async () => {
    const { protocolExecutionId } = await seedIntent();
    // bridge without to_chain_id
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id)
         VALUES ($1, 12, 'bridge_deposit', 'bridge', 'khalani', 8453, $2, 8453)`,
        [protocolExecutionId, WALLET],
      ),
    );
    // swap carrying a bridge column
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, to_chain_id)
         VALUES ($1, 13, 'swap', 'swap', 'kyberswap', 8453, $2, 42161)`,
        [protocolExecutionId, WALLET],
      ),
    );
  });

  it("chain_family is NOT NULL and closed to eip155|solana", async () => {
    const { protocolExecutionId } = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, chain_family)
         VALUES ($1, 14, 'bridge_deposit', 'bridge', 'khalani', 8453, $2, 8453, 42161, NULL)`,
        [protocolExecutionId, WALLET],
      ),
    );
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, chain_family)
         VALUES ($1, 15, 'bridge_deposit', 'bridge', 'khalani', 8453, $2, 8453, 42161, 'bitcoin')`,
        [protocolExecutionId, WALLET],
      ),
    );
  });

  it("normalized_route is present IFF the row is the logical bridge_fill_expected row", async () => {
    const { protocolExecutionId, sessionId } = await seedIntent();
    // logical row WITHOUT normalized_route → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id)
         VALUES ($1, 16, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, $3, 8453, 42161)`,
        [protocolExecutionId, WALLET, sessionId],
      ),
    );
    // non-logical row WITH normalized_route → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, normalized_route)
         VALUES ($1, 17, 'bridge_deposit', 'bridge', 'khalani', 8453, $2, 8453, 42161, 'eip155:8453:0xa->eip155:42161:0xb')`,
        [protocolExecutionId, WALLET],
      ),
    );
  });

  it("provider_order_id lives only on the logical row; the logical row is session-scoped", async () => {
    const { protocolExecutionId, sessionId } = await seedIntent();
    // non-logical row carrying an order id → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, provider_order_id)
         VALUES ($1, 18, 'bridge_deposit', 'bridge', 'khalani', 8453, $2, 8453, 42161, 'ORDER-1')`,
        [protocolExecutionId, WALLET],
      ),
    );
    // logical row with NULL session → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route)
         VALUES ($1, 19, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, NULL, 8453, 42161, 'eip155:8453:0xa->eip155:42161:0xb')`,
        [protocolExecutionId, WALLET],
      ),
    );
    // matching session provided → accepted
    const ok = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route)
       VALUES ($1, 20, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, $3, 8453, 42161, 'eip155:8453:0xa->eip155:42161:0xb') RETURNING id`,
      [protocolExecutionId, WALLET, sessionId],
    );
    expect(ok).toHaveLength(1);
  });

  it("provider-observed rows carry no local submit/broadcast fields", async () => {
    const { protocolExecutionId } = await seedIntent();
    // evidence_source set together with a nonce → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, evidence_source, nonce)
         VALUES ($1, 21, 'bridge_fill_observed', 'bridge', 'khalani', 42161, $2, 8453, 42161, 'khalani_order_status', 7)`,
        [protocolExecutionId, WALLET],
      ),
    );
    // evidence_source set together with a broadcast_at → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, evidence_source, broadcast_at)
         VALUES ($1, 22, 'bridge_refund', 'bridge', 'khalani', 8453, $2, 8453, 42161, 'khalani_order_status', NOW())`,
        [protocolExecutionId, WALLET],
      ),
    );
  });

  it("nonce matrix (B1): Solana rows never carry a nonce; an EVM locally-signed hashed leg must", async () => {
    const { protocolExecutionId } = await seedIntent();
    // solana row with a nonce → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, chain_family, nonce)
         VALUES ($1, 23, 'bridge_deposit', 'bridge', 'khalani', 20011000000, $2, 20011000000, 8453, 'solana', 4)`,
        [protocolExecutionId, WALLET],
      ),
    );
    // EVM locally-signed leg (evidence_source NULL) WITH tx_hash but NULL nonce → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, chain_family, tx_hash)
         VALUES ($1, 24, 'bridge_deposit', 'bridge', 'khalani', 8453, $2, 8453, 42161, 'eip155', '0xdeposit-nononce')`,
        [protocolExecutionId, WALLET],
      ),
    );
    // same EVM leg WITH a nonce → accepted
    const ok = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, chain_family, tx_hash, nonce)
       VALUES ($1, 25, 'bridge_deposit', 'bridge', 'khalani', 8453, $2, 8453, 42161, 'eip155', '0xdeposit-withnonce', 4) RETURNING id`,
      [protocolExecutionId, WALLET],
    );
    expect(ok).toHaveLength(1);
    // a solana observed row with NO nonce and a base58 "hash" → accepted
    const okSol = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, from_chain_id, to_chain_id, chain_family, tx_hash, evidence_source, status, confirmed_at)
       VALUES ($1, 26, 'bridge_fill_observed', 'bridge', 'khalani', 8453, $2, 20011000000, 8453, 'solana', '5xBase58Signature', 'khalani_order_status', 'confirmed', NOW()) RETURNING id`,
      [protocolExecutionId, WALLET],
    );
    expect(okSol).toHaveLength(1);
  });

  it("exactly one logical row per execution", async () => {
    const { protocolExecutionId, sessionId } = await seedIntent();
    await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route)
       VALUES ($1, 30, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, $3, 8453, 42161, 'route-a') RETURNING id`,
      [protocolExecutionId, WALLET, sessionId],
    );
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route)
         VALUES ($1, 31, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, $3, 8453, 42161, 'route-b')`,
        [protocolExecutionId, WALLET, sessionId],
      ),
    );
  });

  it("UNIQUE (protocol, provider_order_id) across executions", async () => {
    const a = await seedIntent();
    const b = await seedIntent();
    await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route, provider_order_id)
       VALUES ($1, 40, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, $3, 8453, 42161, 'route-a', 'ORDER-DUP') RETURNING id`,
      [a.protocolExecutionId, WALLET, a.sessionId],
    );
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route, provider_order_id)
         VALUES ($1, 41, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, $3, 8453, 42161, 'route-b', 'ORDER-DUP')`,
        [b.protocolExecutionId, WALLET, b.sessionId],
      ),
    );
  });

  it("in-flight guard: one pending logical row per (wallet, session, route); a different route is allowed", async () => {
    const a = await seedIntent();
    const b = await seedIntent();
    const c = await seedIntent();
    const wallet = `0x${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const session = `bridge-schema-${randomUUID()}`;
    const route = "eip155:8453:0xusdc->eip155:42161:0xusdc";
    await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route)
       VALUES ($1, 50, 'bridge_fill_expected', 'bridge', 'khalani', 42161, $2, $3, 8453, 42161, $4) RETURNING id`,
      [a.protocolExecutionId, wallet, session, route],
    );
    // second pending logical row, SAME wallet+session+route → rejected
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route)
         VALUES ($1, 51, 'bridge_fill_expected', 'bridge', 'relay', 42161, $2, $3, 8453, 42161, $4)`,
        [b.protocolExecutionId, wallet, session, route],
      ),
    );
    // a DIFFERENT route, same wallet+session → accepted
    const okDifferent = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, session_id, from_chain_id, to_chain_id, normalized_route)
       VALUES ($1, 52, 'bridge_fill_expected', 'bridge', 'khalani', 10, $2, $3, 8453, 10, 'eip155:8453:0xusdc->eip155:10:0xusdc') RETURNING id`,
      [c.protocolExecutionId, wallet, session],
    );
    expect(okDifferent).toHaveLength(1);
  });

  it("a valid 044 swap row still inserts unchanged (chain_family defaults to eip155)", async () => {
    const { protocolExecutionId } = await seedIntent();
    const rows = await query<{ chain_family: string }>(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, status)
       VALUES ($1, 60, 'swap', 'swap', 'kyberswap', 8453, $2, 'pending') RETURNING chain_family`,
      [protocolExecutionId, WALLET],
    );
    expect(rows[0]?.chain_family).toBe("eip155");
  });
});
