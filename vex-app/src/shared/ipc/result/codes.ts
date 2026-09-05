import type { VexDomain, VexErrorCode } from "./types.js";

/**
 * Runtime mirror of the `VexErrorCode` union for boundary validation. Keep
 * this array in sync with the type union above when adding a code. The
 * `satisfies` clause catches typos in this array; the type-level
 * exhaustiveness assertion at the bottom of this file catches the OTHER
 * direction (missing entries when the union grows). Either way the build
 * fails before a code can slip through.
 */
export const VEX_ERROR_CODES = [
  "validation.invalid_input",
  "validation.invalid_sender",
  "wallet.signer_mismatch",
  "validation.archive_incomplete",
  "validation.archive_manifest_malformed",
  "permissions.denied",
  "wallet.insufficient_funds",
  "wallet.user_rejected",
  "wallet.policy_blocked",
  "wallet.export_throttled",
  "wallet.keystore_locked",
  "wallet.keystore_corrupt",
  "wallet.keystore_missing",
  "wallet.password_invalid",
  "wallet.vault_corrupt",
  "wallet.vault_unavailable",
  "wallet.vault_incompatible",
  "wallet.vault_not_configured",
  "wallet.cap_reached",
  "wallet.address_exists",
  "wallet.not_found",
  "secrets.unlock_throttled",
  "services.docker_unavailable",
  "services.port_in_use",
  "services.healthcheck_failed",
  "services.compose_failed",
  "data.search_unavailable",
  "data.migration_failed",
  "update.check_failed",
  "update.download_failed",
  "update.apply_failed",
  "onboarding.step_failed",
  "onboarding.env_persist_failed",
  "embedding.dim_locked",
  "embedding.db_unavailable",
  "embedding.defaults_unavailable",
  "provider.invalid_api_key",
  "provider.insufficient_credits",
  "provider.model_unsupported",
  "provider.unavailable",
  "provider.test_failed",
  "provider.endpoint_unavailable",
  "provider.api_key_required",
  "support.persist_failed",
  "wallets.invalid_selection",
  "approvals.expired",
  "approvals.already_resolved",
  "approvals.run_terminated",
  "approvals.dispatch_failed",
  "approvals.policy_drift_blocked",
  "compaction.not_found",
  "compaction.invalid_state",
  "images.too_large",
  "images.unsupported_format",
  "images.not_found",
  "images.in_use",
  "images.store_unavailable",
  "shellBackdrop.too_large",
  "shellBackdrop.too_small",
  "shellBackdrop.unsupported_format",
  "shellBackdrop.undecodable",
  "shellBackdrop.store_unavailable",
  "tokenLaunch.preview_stale",
  "tokenLaunch.value_ceiling_exceeded",
  "tokenLaunch.launch_count_exceeded",
  "tokenLaunch.ceiling_not_set",
  "projects.root_changed",
  "projects.root_unavailable",
  "projects.slug_taken",
  "projects.not_found",
  "projects.scope_conflict",
  "projects.wallet_drift",
  "projects.backing_session_integrity",
  "projects.deleting",
  "projects.slug_cleanup_pending",
  "projects.root_unverifiable",
  "projects.root_permission_denied",
  "projects.root_out_of_space",
  "projects.root_path_invalid",
  "projects.name_reserved",
  "internal.contract_violation",
  "internal.cancelled",
  "internal.unexpected",
] as const satisfies readonly VexErrorCode[];

/** Runtime mirror of `VexDomain`. Same maintenance note as `VEX_ERROR_CODES`. */
export const VEX_DOMAINS = [
  "wallet",
  "agents",
  "chat",
  "services",
  "data",
  "settings",
  "updater",
  "telemetry",
  "support",
  "permissions",
  "system",
  "docker",
  "database",
  "onboarding",
  "embedding",
  "capabilities",
  "messages",
  "runtime",
  "mission",
  "approvals",
  "wallets",
  "models",
  "usage",
  "compaction",
  "memory",
  "portfolio",
  "market",
  "studio",
  "images",
  "shellBackdrop",
  "tokenLaunch",
  "poolsLaunch",
  "sessions",
  "projects",
  "preload",
  "internal",
] as const satisfies readonly VexDomain[];

// ── Type-level exhaustiveness checks ────────────────────────────────────────
// If a future contributor adds a new code/domain to the union above but
// forgets to mirror it into the runtime array, these assignments fail to
// compile because the `Exclude<...>` type is no longer `never`.

type _MissingCodes = Exclude<VexErrorCode, (typeof VEX_ERROR_CODES)[number]>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _vexErrorCodesAreExhaustive: [_MissingCodes] extends [never] ? true : false = true;

type _MissingDomains = Exclude<VexDomain, (typeof VEX_DOMAINS)[number]>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _vexDomainsAreExhaustive: [_MissingDomains] extends [never] ? true : false = true;
