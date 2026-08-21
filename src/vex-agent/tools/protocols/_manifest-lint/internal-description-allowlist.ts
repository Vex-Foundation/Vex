/**
 * TODAY'S INTERNAL-DESCRIPTION DEBT - every violation the registered internal
 * tools currently carry under the ActionKind-specific rules.
 *
 * Same contract as `allowlist.ts`, deliberately a SEPARATE table so the two
 * debts are measured (and paid down) independently:
 *   - the suite is green while every live violation is listed here;
 *   - a NEW violation is not listed, so it fails immediately;
 *   - a wave DELETES the entries it fixes - entries are never added by a wave;
 *   - a stale entry (listed, no longer violated) also fails, so the table
 *     cannot rot into a permanent exemption;
 *   - SUBJECT REWRITE, the one operation that is neither an add nor a delete:
 *     a rename wave MAY rewrite an entry's `subject` to the renamed tool's new
 *     canonical name in the same change that renames it, provided the rewrite
 *     is provably 1:1 - the entry count does not change, no `rule` or `detail`
 *     changes, and no new violation appears. Without it the first internal
 *     rename strands every entry keyed on an old name.
 *
 * Descriptions are NOT rewritten in this batch. Landing the lane green with a
 * full table is what makes the debt MEASURED and frozen: the money-path gaps
 * below - `BridgeExecute` never naming the approval step that gates a broadcast,
 * `WalletSendConfirm` describing a fund-moving confirm in 84 characters -
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
  { subject: "BridgeExecute", rule: "internal-tool-description", detail: "approval", reason: `user_wallet_broadcast with no approval sentence; ${WAVE}` },

  // ── length (1) ──
  // 84 chars for a fund-moving confirm: too short to carry scope,
  // preconditions, and result shape.
  { subject: "WalletSendConfirm", rule: "internal-tool-description", detail: "length", reason: WAVE },

  // ── when-to-use (12) ──
  // No sentence answering "which question does this tool answer", so tool
  // selection is left to name similarity.
  { subject: "BridgeStatus", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "BridgeQuote", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "AgentScan", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "MissionStop", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "ChainRead", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "WalletBalances", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "WalletTrackToken", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "WalletSendPrepare", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "WalletSendConfirm", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "MemorySuggest", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "MemorySearch", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },
  { subject: "MemoryGet", rule: "internal-tool-description", detail: "when-to-use", reason: WAVE },

  // ── returns (23) ──
  // The result keys are left for the model to guess.
  { subject: "TokenFind", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "SwapQuote", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "SwapExecute", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "BridgeExecute", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "TokenCheck", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "BridgeStatus", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "BridgeQuote", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "TwitterAccount", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "AgentScan", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "MissionStop", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "LoopDefer", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "ChainRead", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "WalletBalances", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "WalletTrackToken", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "WalletSendConfirm", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "UnitsConvert", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "CompactApply", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "SessionMemoryResolve", rule: "internal-tool-description", detail: "returns", reason: WAVE },
  { subject: "PlanWrite", rule: "internal-tool-description", detail: "returns", reason: WAVE },
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
