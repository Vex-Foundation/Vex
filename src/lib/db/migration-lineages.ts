/**
 * Historical migrations whose numbers overlap the main and Lighter histories.
 *
 * A file belongs here when its own numeric prefix is shared with a sibling
 * from the OTHER lineage: applying that sibling advances `schema_version`'s
 * numeric cursor past this file's version without this file ever running, so
 * an install with no filename ledger (`schema_migration_files` never existed,
 * or was dropped) would otherwise treat it as already-covered legacy history
 * and skip it forever. An ALTER-only file joins the group of the table it
 * modifies rather than getting its own entry, matching every other multi-file
 * group here; `109_migration_079_084_collision_repair.sql` is idempotent
 * (`CREATE TABLE IF NOT EXISTS`) and joins the three groups for the tables the
 * original 079-084 collision could have left missing.
 */
export const HISTORICAL_MIGRATION_GROUPS = [
  {
    table: "lighter_nonce_state",
    files: ["079_lighter_nonce_state.sql", "109_migration_079_084_collision_repair.sql"],
  },
  {
    table: "lighter_order_previews",
    files: ["080_lighter_order_previews.sql", "109_migration_079_084_collision_repair.sql"],
  },
  {
    table: "lighter_order_execution_intents",
    files: [
      "081_lighter_order_execution_intents.sql",
      "082_lighter_order_submit_lifecycle.sql",
      "083_lighter_order_provider_outcomes.sql",
      "084_lighter_order_pre_submit_revalidation.sql",
      "109_migration_079_084_collision_repair.sql",
      "111_lighter_order_submit_message.sql",
    ],
  },
  {
    table: "lighter_order_lifecycle_intents",
    files: ["107_lighter_order_lifecycle_intents.sql"],
  },
  {
    table: "lighter_onboarding_intents",
    files: [
      "086_lighter_onboarding_intents.sql",
      "087_lighter_allowance_verified.sql",
      "088_lighter_live_deposit_uniqueness.sql",
      "093_lighter_deposit_evidence.sql",
      "094_lighter_deposit_preflight.sql",
      "095_lighter_deposit_fee_preflight.sql",
      "096_lighter_deposit_transaction_identity.sql",
      "097_lighter_key_registration_slots.sql",
      "098_lighter_key_registration_metadata.sql",
      "099_lighter_key_registration_approval.sql",
      "100_lighter_key_registration_transaction_identity.sql",
      "101_lighter_rhc_funding_preflight.sql",
    ],
  },
  { table: "lighter_evm_execution_leases", files: ["089_lighter_evm_execution_leases.sql"] },
  { table: "lighter_integration_settings", files: ["090_lighter_integration_settings.sql"] },
  {
    table: "lighter_onboarding_workflows",
    files: ["091_lighter_onboarding_workflows.sql", "092_lighter_workflow_deposit_backfill.sql"],
  },
  {
    table: "lighter_withdrawal_intents",
    files: [
      "102_lighter_core_withdrawals.sql",
      "103_lighter_withdrawal_lifecycle.sql",
      "105_lighter_rhc_withdrawals.sql",
      "108_lighter_rhc_gateway_implementation.sql",
      "110_lighter_withdrawal_predicted_execution_timestamp.sql",
    ],
  },
  {
    table: "lighter_withdrawal_claim_attempts",
    files: [
      "104_lighter_withdrawal_manual_claims.sql",
      "106_lighter_rhc_withdrawal_claims.sql",
      "108_lighter_rhc_gateway_implementation.sql",
    ],
  },
  {
    table: "projects",
    files: [
      "079_agent_activity_evm_lend.sql",
      "080_swap_prequotes_lend_kinds.sql",
      "081_swap_prequotes_borrow_kinds.sql",
      "082_pools_fun_launch.sql",
      "083_launch_image_onchain_variant.sql",
      "084_agent_activity_wallet_transfer.sql",
      "085_projects.sql",
      "086_studio_approvals.sql",
      "087_wallet_transaction_intents.sql",
      "088_wallet_tx_vex_fee.sql",
      "089_studio_installer_provenance.sql",
      "090_wallet_transaction_intents_activity_unique.sql",
      "091_evm_nonce_reservations.sql",
      "092_studio_pending_refusal_repair.sql",
      "093_wallet_transfer_unconfirmed_repair.sql",
      "094_pools_launch_attribution.sql",
      "095_swap_prequotes_claim.sql",
      "096_wallet_wrap_intents.sql",
      "097_project_soft_delete.sql",
      "098_project_file_provenance_origin.sql",
      "099_swap_prequotes_balance_eligibility.sql",
      "100_wallet_intent_wallet_indexes.sql",
      "101_portfolio_snapshot_groups.sql",
      "102_portfolio_snapshot_group_wallets.sql",
      "106_launch_image_public_asset.sql",
      "107_launchpad_family_roles.sql",
    ],
  },
] as const;
