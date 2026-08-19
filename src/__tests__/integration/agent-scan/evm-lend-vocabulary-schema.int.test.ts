/**
 * Migration 079 vocabulary - `agent_activity` admits an EVM (Morpho) lend
 * execution, against a REAL local Postgres with 044+045+...+079 applied (the
 * `_fixtures.ts` contract). These invariants genuinely live in SQL, so a
 * mocked client would prove nothing.
 *
 * Pins:
 *   - `agent_activity_kind_family_binding` widened: a `lend` row may now live
 *     on `chain_family='eip155'` with any eip155 chain id, for each of
 *     `lend_deposit` / `lend_withdraw` / `lend_borrow_operate`;
 *   - `agent_activity_kind_role_binding` `lend` arm widened: `allowance` and
 *     `allowance_reset` rows insert on an EVM lend execution;
 *   - NEGATIVE: `prediction` on `eip155` is STILL rejected (no EVM prediction
 *     producer exists; 079 widened `lend` only);
 *   - NEGATIVE: a `lend` row with a role outside the widened arm (`swap`,
 *     `swap_fee`, `yield_pt`, `predict_buy`) is still rejected;
 *   - the Solana lend path of 049 is unchanged, and the 045 EVM invariants
 *     (`evm_signed_leg_has_nonce`) plus the 049 non-bridge invariant still
 *     apply to an eip155 lend row.
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

const WALLET = "0xEVMLENDW";
const BASE_CHAIN_ID = 8453;
const SOLANA_CHAIN_ID = 20011000000;

const INSERT_ACTIVITY = `INSERT INTO agent_activity
  (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
  VALUES ($1, $2, $3, $4, 'morpho', $5, $6, $7)`;

describe("migration 079 - EVM lend vocabulary", () => {
  it("kind/family binding widens: a lend row inserts on eip155 for every lend role", async () => {
    const seeded = await seedIntent();
    for (const [index, role] of ["lend_deposit", "lend_withdraw", "lend_borrow_operate"].entries()) {
      const rows = await query(
        `${INSERT_ACTIVITY} RETURNING id`,
        [seeded.protocolExecutionId, index, role, "lend", BASE_CHAIN_ID, WALLET, "eip155"],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("kind/family binding widens for ANY eip155 chain id, not just Base", async () => {
    const seeded = await seedIntent();
    for (const [index, chainId] of [1, 42161, 137].entries()) {
      const rows = await query(
        `${INSERT_ACTIVITY} RETURNING id`,
        [seeded.protocolExecutionId, index, "lend_deposit", "lend", chainId, WALLET, "eip155"],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("kind<->role binding widens: allowance and allowance_reset insert on an EVM lend execution", async () => {
    const seeded = await seedIntent();
    for (const [index, role] of ["allowance", "allowance_reset"].entries()) {
      const rows = await query(
        `${INSERT_ACTIVITY} RETURNING id`,
        [seeded.protocolExecutionId, index, role, "lend", BASE_CHAIN_ID, WALLET, "eip155"],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("the widened role arm also holds on the Solana lend path (049 unchanged)", async () => {
    const seeded = await seedIntent();
    const rows = await query(
      `${INSERT_ACTIVITY} RETURNING id`,
      [seeded.protocolExecutionId, 0, "lend_deposit", "lend", SOLANA_CHAIN_ID, WALLET, "solana"],
    );
    expect(rows).toHaveLength(1);
  });

  it("NEGATIVE: prediction is STILL pinned to Solana - eip155 is rejected", async () => {
    const wrongFamily = await seedIntent();
    await expectReject(() =>
      execute(INSERT_ACTIVITY, [
        wrongFamily.protocolExecutionId, 0, "predict_buy", "prediction", BASE_CHAIN_ID, WALLET, "eip155",
      ]),
    );
    const wrongChainId = await seedIntent();
    await expectReject(() =>
      execute(INSERT_ACTIVITY, [
        wrongChainId.protocolExecutionId, 0, "predict_buy", "prediction", BASE_CHAIN_ID, WALLET, "solana",
      ]),
    );
  });

  it("NEGATIVE: a lend row with a role outside the widened arm is still rejected", async () => {
    for (const role of ["swap", "swap_fee", "yield_pt", "predict_buy", "bridge_deposit"]) {
      const seeded = await seedIntent();
      await expectReject(() =>
        execute(INSERT_ACTIVITY, [
          seeded.protocolExecutionId, 0, role, "lend", BASE_CHAIN_ID, WALLET, "eip155",
        ]),
      );
    }
  });

  it("NEGATIVE: an unknown chain_family is still rejected for a lend row", async () => {
    const seeded = await seedIntent();
    await expectReject(() =>
      execute(INSERT_ACTIVITY, [
        seeded.protocolExecutionId, 0, "lend_deposit", "lend", BASE_CHAIN_ID, WALLET, "cosmos",
      ]),
    );
  });

  it("045 evm_signed_leg_has_nonce still applies: a staged EVM lend row without a nonce is rejected", async () => {
    const noNonce = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity
           (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, tx_hash, submit_attempted_at)
         VALUES ($1, 0, 'lend_deposit', 'lend', 'morpho', $2, $3, 'eip155', '0xdeadbeef', NOW())`,
        [noNonce.protocolExecutionId, BASE_CHAIN_ID, WALLET],
      ),
    );
    const withNonce = await seedIntent();
    const rows = await query(
      `INSERT INTO agent_activity
         (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, tx_hash, submit_attempted_at, nonce)
       VALUES ($1, 0, 'lend_deposit', 'lend', 'morpho', $2, $3, 'eip155', '0xdeadbeef', NOW(), 7) RETURNING id`,
      [withNonce.protocolExecutionId, BASE_CHAIN_ID, WALLET],
    );
    expect(rows).toHaveLength(1);
  });

  it("049 non-bridge invariant still applies: an EVM lend row rejects bridge-only columns", async () => {
    const seeded = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity
           (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family, provider_order_id)
         VALUES ($1, 0, 'lend_deposit', 'lend', 'morpho', $2, $3, 'eip155', 'ORDER-X')`,
        [seeded.protocolExecutionId, BASE_CHAIN_ID, WALLET],
      ),
    );
  });
});
