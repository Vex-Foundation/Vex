/**
 * TODAY'S INTERNAL-DESCRIPTION DEBT - every violation the 34 registered
 * internal tools currently carry under the ActionKind-specific rules.
 *
 * Same contract as `allowlist.ts`, deliberately a SEPARATE table so the two
 * debts are measured (and paid down) independently:
 *   - the suite is green while every live violation is listed here;
 *   - a NEW violation is not listed, so it fails immediately;
 *   - a wave DELETES the entries it fixes - entries are never added by a wave;
 *   - a stale entry (listed, no longer violated) also fails, so the table
 *     cannot rot into a permanent exemption.
 *
 * Descriptions are NOT rewritten in this batch. Landing the lane green with a
 * full table is what makes the debt MEASURED and frozen: the money-path gaps
 * below - `bridge` never naming the approval step that gates a broadcast,
 * `wallet_send_confirm` describing a fund-moving confirm in 84 characters -
 * are recorded here as the rewrite wave's worklist, and nothing may join them.
 *
 * The length of this table is the internal lane's description debt. It is only
 * allowed to shrink.
 */

import type { ManifestLintIssue } from "./rules.js";
import { allowlistKey, type ManifestLintAllowlistEntry } from "./allowlist.js";

const WAVE = "pre-style-guide description; deleted by the internal-description rewrite wave";

export const INTERNAL_DESCRIPTION_ALLOWLIST: readonly ManifestLintAllowlistEntry[] = [
  // ── approval (1) ──
  // A user_wallet_broadcast whose description never names the human decision
  // that gates it, so the model can present the broadcast as already done.
  // This is the money-path gap the ActionKind lane exists to surface, and the
  // first entry the rewrite wave should delete.
  { subject: "bridge", rule: "internal-tool-description", detail: "approval", reason: `user_wallet_broadcast with no approval sentence; ${WAVE}` },

  // ── length (1) ──
  // 84 chars for a fund-moving confirm: too short to carry scope,
  // preconditions, and result shape.
  { subject: "wallet_send_confirm", rule: "internal-tool-description", detail: "length", reason: WAVE },

  // ── when-to-use (14) ──
  // No sentence answering "which question does this tool answer", so tool
  // selection is left to name similarity.
  { subject: "discover_tools", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "execute_tool", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "bridge_status", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "bridge_quote", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "agent_scan", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "mission_stop", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "chain_read", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "wallet_balances", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "wallet_track_token", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "wallet_send_prepare", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "wallet_send_confirm", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "long_memory_suggest", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "long_memory_search", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "long_memory_get", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },

  // ── returns (24) ──
  // The result keys are left for the model to guess.
  { subject: "execute_tool", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "token_find", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "swap_quote", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "swap_execute", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "swap_quote_uniswap", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "swap_execute_uniswap", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "bridge", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "token_check", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "bridge_status", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "bridge_quote", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "bridge_quote_relay", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "bridge_execute_relay", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "twitter_account", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "agent_scan", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "mission_stop", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "loop_defer", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "chain_read", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "wallet_balances", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "wallet_track_token", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "wallet_send_confirm", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "units_convert", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "compact_apply", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "session_memory_resolve_item", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "plan_write", rule: "internal-tool-description", detail: "returns", reason: WAVE },
];

/** Drop the issues this tree has explicitly accepted as internal-lane debt. */
export function withoutInternalAllowlisted(
  issues: readonly ManifestLintIssue[],
): ManifestLintIssue[] {
  const allowed = new Set(INTERNAL_DESCRIPTION_ALLOWLIST.map(allowlistKey));
  return issues.filter((issue) => !allowed.has(allowlistKey(issue)));
}

/** Internal-lane allowlist entries no longer matched by a live violation. */
export function staleInternalAllowlistKeys(issues: readonly ManifestLintIssue[]): string[] {
  const live = new Set(issues.map(allowlistKey));
  return INTERNAL_DESCRIPTION_ALLOWLIST.map(allowlistKey).filter((key) => !live.has(key));
}
