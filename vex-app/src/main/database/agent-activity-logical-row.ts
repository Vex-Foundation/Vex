/**
 * The canonical positive allow-list for one user-facing `agent_activity` row.
 *
 * Both Agent Scan and Token History read the same ledger. They must therefore
 * agree on which rows are actions and which rows are execution plumbing. A
 * negative list is unsafe here: every new approval/fee/housekeeping role would
 * become visible by default until every reader learned to exclude it. This
 * positive list fails closed instead — a new role stays internal until its
 * user-facing meaning is deliberately added here.
 *
 * The SQL is intentionally written for the `aa` alias used by both readers.
 * Database kind<->role CHECKs reject a role filed under the wrong kind, so the
 * role is the narrowest stable discriminator for this projection.
 *
 * MIGRATION 102 adds four members and deliberately withholds a fifth. Each of
 * `creator_fee_claim`, `holder_reward_claim`, `reward_distribution` and
 * `launch_cancel` is a user ACTION with its own transaction: two claims the
 * wallet is paid by, the permissionless distribute the wallet signs and is paid
 * nothing for, and the creator's cancel of a launch that had not gone live.
 * `vex_fee` is NOT here, for the reason the owner's 2026-08-05 revision gave
 * about every other fee role: it is the fee LEG of one of those actions, folded
 * onto its parent by the projection in `agent-scan-db-query.ts`, and rendering
 * it beside the action it is 25 bps of presents one charge as two.
 *
 * The predicate carries no SQL comments on purpose - it is interpolated into
 * two different statements, and the reasoning belongs to the module, not to the
 * bytes sent to Postgres.
 */
export const AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE = `aa.event_role IN (
          'swap',
          'bridge_fill_expected',
          'lend_deposit', 'lend_withdraw', 'lend_borrow_operate',
          'predict_buy', 'predict_sell', 'predict_claim', 'predict_close',
          'wrap', 'unwrap',
          'yield_pt', 'yield_yt', 'yield_py',
          'yield_lp', 'yield_sy', 'yield_claim',
          'token_launch',
          'pools_claim',
          'creator_fee_claim', 'holder_reward_claim', 'reward_distribution',
          'launch_cancel',
          'wallet_transfer',
          'tx_approve', 'tx_contract_call', 'tx_native_transfer', 'tx_spl_instruction_set'
        )`;
