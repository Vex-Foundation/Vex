/**
 * Migration 049 vocabulary — `agent_activity` widened for lend/prediction,
 * against a REAL local Postgres with 044+045+...+049 applied (the
 * `_fixtures.ts` contract). These invariants genuinely live in SQL, so a
 * mocked client would prove nothing.
 *
 * Pins (W5 design §1/§8, REVISION 1 R1, REVISION 2 R2b):
 *   - kind widened to swap|bridge|lend|prediction; a bogus kind is rejected;
 *   - the two new kind<->role binding arms (lend, prediction); cross-kind
 *     roles are rejected in both directions;
 *   - the non-bridge invariant (R1): lend/prediction rows reject bridge-only
 *     columns, exactly like swap rows already do;
 *   - the kind/family binding (R1): lend/prediction rows MUST be
 *     chain_family='solana' AND chain_id=20011000000 — wrong family or wrong
 *     chain id is rejected;
 *   - the stage-evidence CHECK (R2b), scoped to LOCALLY STAGED rows only:
 *     a chain_family='solana' row with submit_attempted_at set is REJECTED
 *     if either recent_blockhash or last_valid_block_height is missing, and
 *     ACCEPTED once both are present; a PROVIDER-OBSERVED Solana row
 *     (evidence_source set, submit_attempted_at NULL — never locally
 *     staged) stays valid WITHOUT either evidence column (build-factory
 *     BATCH 4 header requirement, verbatim).
 *
 * 044/045 swap/bridge invariants are NOT retested here beyond the minimum
 * needed to prove the widened CHECKs did not regress them (agent-activity-*
 * and bridge-schema.int.test.ts own those suites).
 */
import { afterEach, describe, it, expect } from "vitest";
import { execute, query } from "../../../vex-agent/db/client.js";
import { seedIntent, cleanupSeeded } from "./_fixtures.js";

afterEach(async () => {
  await cleanupSeeded();
});

async function expectReject(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow();
}

const WALLET = "0xSOLW";
const SOLANA_CHAIN_ID = 20011000000;

describe("migration 049 — lend/prediction vocabulary", () => {
  it("kind widens to accept 'lend' and 'prediction'; a bogus kind is still rejected", async () => {
    const lend = await seedIntent();
    const ok1 = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
       VALUES ($1, 0, 'lend_deposit', 'lend', 'jupiter', $2, $3, 'solana') RETURNING id`,
      [lend.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
    );
    expect(ok1).toHaveLength(1);

    const predict = await seedIntent();
    const ok2 = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
       VALUES ($1, 0, 'predict_buy', 'prediction', 'jupiter', $2, $3, 'solana') RETURNING id`,
      [predict.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
    );
    expect(ok2).toHaveLength(1);

    const bogus = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, 0, 'lend_deposit', 'staking', 'jupiter', $2, $3, 'solana')`,
        [bogus.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
  });

  it("event_role widens to the lend/prediction roles; a bogus role is rejected", async () => {
    const a = await seedIntent();
    for (const [i, role] of ["lend_deposit", "lend_withdraw", "lend_borrow_operate"].entries()) {
      const ok = await query(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, $2, $3, 'lend', 'jupiter', $4, $5, 'solana') RETURNING id`,
        [a.protocolExecutionId, i, role, SOLANA_CHAIN_ID, WALLET],
      );
      expect(ok).toHaveLength(1);
    }
    const b = await seedIntent();
    for (const [i, role] of ["predict_buy", "predict_sell", "predict_claim", "predict_close"].entries()) {
      const ok = await query(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, $2, $3, 'prediction', 'jupiter', $4, $5, 'solana') RETURNING id`,
        [b.protocolExecutionId, i, role, SOLANA_CHAIN_ID, WALLET],
      );
      expect(ok).toHaveLength(1);
    }
    const bogus = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, 0, 'lend_repay', 'lend', 'jupiter', $2, $3, 'solana')`,
        [bogus.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
  });

  it("kind<->role binding: a lend row rejects a prediction role and vice versa", async () => {
    const a = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, 0, 'predict_buy', 'lend', 'jupiter', $2, $3, 'solana')`,
        [a.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
    const b = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, 0, 'lend_deposit', 'prediction', 'jupiter', $2, $3, 'solana')`,
        [b.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
    const c = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, 0, 'swap', 'lend', 'jupiter', $2, $3, 'solana')`,
        [c.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
  });

  it("non-bridge invariant (R1): a lend/prediction row rejects bridge-only columns", async () => {
    const a = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, from_chain_id)
         VALUES ($1, 0, 'lend_deposit', 'lend', 'jupiter', $2, $3, 'solana', $2)`,
        [a.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
    const b = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, provider_order_id)
         VALUES ($1, 0, 'predict_buy', 'prediction', 'jupiter', $2, $3, 'solana', 'ORDER-X')`,
        [b.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
  });

  it("kind/family binding (R1): prediction rows must be chain_family='solana' AND chain_id=20011000000", async () => {
    // Migration 079 widened this binding so that `lend` may ALSO live on
    // `eip155` (Morpho). `prediction` stays Solana-pinned and is therefore
    // what still proves the family half of the binding here; the widened
    // lend half is owned by evm-lend-vocabulary-schema.int.test.ts.
    const wrongFamily = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, 0, 'predict_buy', 'prediction', 'jupiter', $2, $3, 'eip155')`,
        [wrongFamily.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
    const wrongChainId = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
         VALUES ($1, 0, 'predict_buy', 'prediction', 'jupiter', 8453, $2, 'solana')`,
        [wrongChainId.protocolExecutionId, WALLET],
      ),
    );
    const ok = await seedIntent();
    const inserted = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
       VALUES ($1, 0, 'lend_withdraw', 'lend', 'jupiter', $2, $3, 'solana') RETURNING id`,
      [ok.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
    );
    expect(inserted).toHaveLength(1);
  });

  it("stage-evidence CHECK (R2b): a locally-staged Solana row missing either evidence column is rejected", async () => {
    const missingBoth = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, tx_hash, submit_attempted_at)
         VALUES ($1, 0, 'swap', 'swap', 'jupiter', $2, $3, 'solana', '5xSig1', NOW())`,
        [missingBoth.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
    const missingHeight = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, tx_hash, submit_attempted_at, recent_blockhash)
         VALUES ($1, 0, 'swap', 'swap', 'jupiter', $2, $3, 'solana', '5xSig2', NOW(), 'BhAsH')`,
        [missingHeight.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
    const missingHash = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, tx_hash, submit_attempted_at, last_valid_block_height)
         VALUES ($1, 0, 'swap', 'swap', 'jupiter', $2, $3, 'solana', '5xSig3', NOW(), 500)`,
        [missingHash.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
    const complete = await seedIntent();
    const ok = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, tx_hash, submit_attempted_at, recent_blockhash, last_valid_block_height)
       VALUES ($1, 0, 'swap', 'swap', 'jupiter', $2, $3, 'solana', '5xSig4', NOW(), 'BhAsH', 500) RETURNING id`,
      [complete.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
    );
    expect(ok).toHaveLength(1);
  });

  it("stage-evidence CHECK (R2b): a provider-observed Solana row stays valid WITHOUT either evidence column", async () => {
    const observed = await seedIntent();
    const ok = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, from_chain_id, to_chain_id, tx_hash, evidence_source, status, confirmed_at)
       VALUES ($1, 0, 'bridge_fill_observed', 'bridge', 'khalani', $2, $3, 'solana', $2, 8453, '5xObservedSig', 'khalani_order_status', 'confirmed', NOW()) RETURNING id, recent_blockhash, last_valid_block_height`,
      [observed.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]?.recent_blockhash).toBeNull();
    expect(ok[0]?.last_valid_block_height).toBeNull();
  });

  it("a valid 045 Solana bridge row still inserts unchanged (no evidence columns required pre-staging)", async () => {
    const { protocolExecutionId } = await seedIntent();
    const rows = await query(
      `INSERT INTO agent_activity (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, from_chain_id, to_chain_id, session_id, normalized_route)
       VALUES ($1, 0, 'bridge_fill_expected', 'bridge', 'khalani', $2, $3, 'solana', $2, 8453, 'sess-049-check', 'solana:sol->eip155:8453:usdc') RETURNING id`,
      [protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
    );
    expect(rows).toHaveLength(1);
  });
});
