/**
 * Migration 084 vocabulary - `agent_activity` admits an agent WALLET SEND,
 * against a REAL local Postgres with 044+045+...+084 applied (the
 * `_fixtures.ts` contract). These invariants genuinely live in SQL, so a mocked
 * client would prove nothing, and the migration RUNNING at all is half of what
 * this file establishes.
 *
 * Pins:
 *   - the `transfer` kind and the `wallet_transfer` role exist, on BOTH chain
 *     families - a send is the one lane with an eip155 and a Solana producer
 *     writing the same role;
 *   - the `transfer` arm of `agent_activity_kind_role_binding` carries exactly
 *     that one role;
 *   - NEGATIVE: no other role rides `transfer`, and `wallet_transfer` rides no
 *     other kind. A binding that leaked either way would let a send be filed as
 *     a trade, or a trade as a send;
 *   - NEGATIVE: a second leg is refused (053/082's allowlist was deliberately
 *     NOT restated by 084, and this asserts that omission was the right one);
 *   - the 045/049 staging invariants still apply to a transfer row: an EVM
 *     staged row needs its nonce, a Solana row must not have one, and a staged
 *     Solana row needs its blockhash evidence. Those three CHECKs are exactly
 *     why the wallet writer signs before it submits, so a transfer that could
 *     not satisfy them would mean the staged split does not actually work.
 *   - REGRESSION: every kind and role that existed before 084 is still
 *     writable. The three CHECKs are DROPped and re-ADDed whole, so a
 *     restatement that lost a member would make those rows unwritable - the
 *     failure mode the migration's own comment warns about.
 */
import { afterEach, describe, it, expect } from "vitest";

import { execute, query } from "../../../vex-agent/db/client.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../constants/solana-chain.js";
import { seedIntent, cleanupSeeded } from "./_fixtures.js";

afterEach(async () => {
  await cleanupSeeded();
});

async function expectReject(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow();
}

const WALLET = "0xWALLETSEND";
const BASE_CHAIN_ID = 8453;
// The repo-canonical synthetic id, NOT Solana's cluster id. The 049
// `agent_activity_kind_family_binding` CHECK is written against this value, so a
// literal here would both misfile transfers and make the prediction regression
// case below fail for the wrong reason.
const SOLANA_CHAIN_ID = SOLANA_SYNTHETIC_CHAIN_ID;

const INSERT_ACTIVITY = `INSERT INTO agent_activity
  (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address, chain_family)
  VALUES ($1, $2, $3, $4, 'wallet', $5, $6, $7)`;

describe("migration 084 - wallet transfer vocabulary", () => {
  it("admits a transfer row on BOTH chain families", async () => {
    for (const [chainId, family] of [[BASE_CHAIN_ID, "eip155"], [SOLANA_CHAIN_ID, "solana"]] as const) {
      const seeded = await seedIntent();
      const rows = await query(
        `${INSERT_ACTIVITY} RETURNING id`,
        [seeded.protocolExecutionId, 0, "wallet_transfer", "transfer", chainId, WALLET, family],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("carries the INPUT leg a send actually has", async () => {
    const seeded = await seedIntent();
    const rows = await query(
      `INSERT INTO agent_activity
         (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
          chain_family, token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw)
       VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', $2, $3, 'eip155',
               '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 'ETH', 18, '0.5', '500000000000000000')
       RETURNING id`,
      [seeded.protocolExecutionId, BASE_CHAIN_ID, WALLET],
    );
    expect(rows).toHaveLength(1);
  });

  it("NEGATIVE: no other role rides the transfer arm", async () => {
    for (const role of ["swap", "allowance", "swap_fee", "token_launch", "pools_claim", "bridge_deposit"]) {
      const seeded = await seedIntent();
      await expectReject(() =>
        execute(INSERT_ACTIVITY, [
          seeded.protocolExecutionId, 0, role, "transfer", BASE_CHAIN_ID, WALLET, "eip155",
        ]),
      );
    }
  });

  it("NEGATIVE: wallet_transfer rides no other kind", async () => {
    for (const kind of ["swap", "lend", "yield", "launch", "claim", "wrap"]) {
      const seeded = await seedIntent();
      await expectReject(() =>
        execute(INSERT_ACTIVITY, [
          seeded.protocolExecutionId, 0, "wallet_transfer", kind, BASE_CHAIN_ID, WALLET, "eip155",
        ]),
      );
    }
  });

  it("NEGATIVE: a transfer row may not carry a second leg", async () => {
    const seeded = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity
           (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
            chain_family, token_out2_address, token_out2_symbol, token_out2_decimals,
            amount_out2_human, amount_out2_raw)
         VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', $2, $3, 'eip155',
                 '0xabc', 'X', 18, '1', '1')`,
        [seeded.protocolExecutionId, BASE_CHAIN_ID, WALLET],
      ),
    );
  });

  it("045 evm_signed_leg_has_nonce still applies: a staged EVM transfer without a nonce is rejected", async () => {
    const seeded = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity
           (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
            chain_family, tx_hash, from_address, submit_attempted_at)
         VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', $2, $3, 'eip155', '0xdead', $3, NOW())`,
        [seeded.protocolExecutionId, BASE_CHAIN_ID, WALLET],
      ),
    );
  });

  it("a staged EVM transfer WITH its nonce is accepted - the writer stages exactly this shape", async () => {
    const seeded = await seedIntent();
    const rows = await query(
      `INSERT INTO agent_activity
         (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
          chain_family, tx_hash, from_address, nonce, submit_attempted_at)
       VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', $2, $3, 'eip155', '0xdead', $3, 7, NOW())
       RETURNING id`,
      [seeded.protocolExecutionId, BASE_CHAIN_ID, WALLET],
    );
    expect(rows).toHaveLength(1);
  });

  it("049 solana_staged_has_evidence still applies: a staged Solana transfer without a blockhash is rejected", async () => {
    const seeded = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity
           (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
            chain_family, tx_hash, from_address, submit_attempted_at)
         VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', $2, $3, 'solana', 'sig', $3, NOW())`,
        [seeded.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
  });

  it("a staged Solana transfer WITH its blockhash evidence and no nonce is accepted", async () => {
    const seeded = await seedIntent();
    const rows = await query(
      `INSERT INTO agent_activity
         (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
          chain_family, tx_hash, from_address, recent_blockhash, last_valid_block_height, submit_attempted_at)
       VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', $2, $3, 'solana', 'sig', $3, 'hash', 4242, NOW())
       RETURNING id`,
      [seeded.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
    );
    expect(rows).toHaveLength(1);
  });

  it("045 solana_no_nonce still applies: a Solana transfer carrying a nonce is rejected", async () => {
    const seeded = await seedIntent();
    await expectReject(() =>
      execute(
        `INSERT INTO agent_activity
           (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
            chain_family, tx_hash, from_address, recent_blockhash, last_valid_block_height,
            nonce, submit_attempted_at)
         VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', $2, $3, 'solana', 'sig', $3, 'hash', 1, 7, NOW())`,
        [seeded.protocolExecutionId, SOLANA_CHAIN_ID, WALLET],
      ),
    );
  });

  it("REGRESSION: every pre-084 kind/role pairing is still writable after the restatements", async () => {
    // Bridge rows carry route endpoints (045 `agent_activity_bridge_has_route`)
    // and the LOGICAL row additionally carries `normalized_route` (045
    // `agent_activity_normalized_route_logical_only`, a biconditional). Those
    // The logical fill row additionally requires a session (045
    // `agent_activity_logical_has_session`). Those columns are supplied here so
    // a row is rejected only if THIS migration's
    // three restatements dropped its kind/role pairing - the single thing this
    // test is for.
    const pairings: ReadonlyArray<{
      readonly kind: string;
      readonly role: string;
      readonly family: string;
      readonly chainId: number;
    }> = [
      { kind: "swap", role: "swap", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "swap", role: "allowance", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "swap", role: "swap_fee", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "swap", role: "trench_fee", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "bridge", role: "bridge_deposit", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "bridge", role: "bridge_fill_expected", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "bridge", role: "bridge_fee", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "lend", role: "lend_deposit", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "lend", role: "allowance_reset", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "prediction", role: "predict_buy", family: "solana", chainId: SOLANA_SYNTHETIC_CHAIN_ID },
      { kind: "wrap", role: "wrap", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "wrap", role: "unwrap", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "yield", role: "yield_pt", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "yield", role: "yield_claim", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "launch", role: "token_launch", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "launch", role: "pools_fee", family: "eip155", chainId: BASE_CHAIN_ID },
      { kind: "claim", role: "pools_claim", family: "eip155", chainId: BASE_CHAIN_ID },
    ];

    for (const { kind, role, family, chainId } of pairings) {
      const seeded = await seedIntent();
      const isBridge = kind === "bridge";
      const isLogicalFill = role === "bridge_fill_expected";
      const rows = await query(
        `INSERT INTO agent_activity
           (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, wallet_address,
            chain_family, session_id, from_chain_id, to_chain_id, normalized_route)
         VALUES ($1, 0, $2, $3, 'regression', $4, $5, $6, $7, $8, $9, $10::jsonb)
         RETURNING id`,
        [
          seeded.protocolExecutionId, role, kind, chainId, WALLET, family,
          // The logical fill row requires a session (045
          // `agent_activity_logical_has_session`).
          seeded.sessionId,
          isBridge ? chainId : null,
          isBridge ? chainId : null,
          isLogicalFill ? JSON.stringify({ from: "a", to: "b" }) : null,
        ],
      );
      expect(rows, `pre-084 pairing ${kind}/${role} became unwritable`).toHaveLength(1);
    }
  });
});
