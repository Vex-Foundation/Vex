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
          'wallet_transfer'
        )`;
