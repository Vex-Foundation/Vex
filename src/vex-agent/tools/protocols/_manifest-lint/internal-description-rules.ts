/**
 * G2(b) - description rules for INTERNAL `ToolDef`s, classified by ActionKind.
 *
 * `_manifest-lint.ts` already lints two lanes under the `tool-description`
 * rule: the 137 protocol manifests, and the action-alias + wallet JSON schemas
 * (14 of the 34 internal tools). The other 20 internal descriptions -
 * discovery, research, memory, mission, plan, units, compaction - were
 * unpinned entirely, though they are model-visible strings on the SAME
 * provider tools array as the linted ones.
 *
 * This lane runs over ALL 34 registered internal tools, the 14 included. The
 * overlap is deliberate and is the point: the tools carrying the strongest
 * obligations - `bridge`, `swap_execute`, `wallet_send_prepare`,
 * `wallet_send_confirm` - are inside those 14, and the older rule cannot state
 * their obligations because it has no ActionKind to read. A tool linted by
 * both rules reports under two different rule ids and allowlists each finding
 * separately, so neither lane can hide the other's.
 *
 * Why not just reuse `lintToolDescription` as-is: that rule derives "this tool
 * spends funds" from `mutating`, and on the internal lane that inference is
 * simply false. `wallet_track_token` and `long_memory_suggest` carry a
 * non-read actionKind with `mutating: false`; `mission_draft_update` is
 * `mutating: false` while its pressure classification is mutating. The action
 * taxonomy (`taxonomy.ts`) is the field that was deliberately introduced so
 * policy would stop re-deriving intent from that boolean, so the requirement
 * matrix keys on it:
 *
 *   user_wallet_broadcast  SPENDS + approval statement + RETURNS + when-to-use
 *   destructive            approval statement + RETURNS + when-to-use
 *   approval_prepare       approval statement + RETURNS + when-to-use
 *   external_post          RETURNS + when-to-use
 *   local_write, schedule  RETURNS + when-to-use, and NO spends requirement
 *   read                   RETURNS + when-to-use
 *
 * Length applies to every kind. A description below the floor cannot carry the
 * scope, preconditions, and result shape an agent needs to choose correctly.
 *
 * Every message names the FIX, because it is read in a test failure by a
 * session with no conversation context.
 */

import type { ActionKind } from "../../taxonomy.js";
import type { ManifestLintIssue } from "./rules.js";
import { lintToolDescription } from "./rules.js";

/** An internal tool reduced to what these rules read. */
export interface InternalDescriptionSubject {
  readonly name: string;
  readonly description: string;
  readonly actionKind: ActionKind;
}

const APPROVAL_ANCHOR = /approv|confirm|authoriz|sign off|user must|requires the user/i;

/** Kinds whose description must say that real funds move. */
const SPENDS_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["user_wallet_broadcast"]);

/** Kinds whose description must name the human approval step that gates them. */
const APPROVAL_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "user_wallet_broadcast",
  "approval_prepare",
  "destructive",
]);

/**
 * Lint one internal tool description.
 *
 * Reuses the shared `lintToolDescription` mechanics (length floor, when-to-use
 * anchor, RETURNS anchor, SPENDS anchor) and re-stamps them under the
 * `internal-tool-description` rule id so this lane carries its own allowlist,
 * then adds the approval requirement the shared rule has no ActionKind to
 * decide from.
 */
export function lintInternalToolDescription(
  subject: InternalDescriptionSubject,
): ManifestLintIssue[] {
  const requiresSpends = SPENDS_KINDS.has(subject.actionKind);
  const issues: ManifestLintIssue[] = lintToolDescription(
    subject.name,
    subject.description,
    requiresSpends,
  ).map((issue) => ({ ...issue, rule: "internal-tool-description" as const }));

  if (APPROVAL_KINDS.has(subject.actionKind) && !APPROVAL_ANCHOR.test(subject.description)) {
    issues.push({
      subject: subject.name,
      rule: "internal-tool-description",
      detail: "approval",
      message:
        `actionKind \`${subject.actionKind}\` means a human decision gates this call - the description `
        + "must say so, or the model will present the action to the user as already done.",
    });
  }
  return issues;
}
