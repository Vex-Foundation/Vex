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
 * The length of this table is the internal lane's description debt. It is only
 * allowed to shrink, and it is now EMPTY - see the note on the array below.
 */

import type { ManifestLintIssue } from "./rules.js";
import { allowlistKey, type ManifestLintAllowlistEntry } from "./allowlist.js";


export const INTERNAL_DESCRIPTION_ALLOWLIST: readonly ManifestLintAllowlistEntry[] = [
  // EMPTY. The internal-description rewrite wave paid this lane off in full:
  // every one of the 33 entries was deleted by fixing the description it
  // excused, including the two money-path gaps the table was created to make
  // visible - `BridgeExecute` never naming the approval that gates a broadcast,
  // and `WalletSendConfirm` describing a fund-moving confirm in 84 characters.
  //
  // A new violation now fails immediately, which is the point. Adding a row is
  // not an available move: the table is only allowed to shrink, and it has
  // reached zero.
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
