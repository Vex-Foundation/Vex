/**
 * Owner decision O7, pinned LITERALLY: `ActionKind` -> MCP tool annotations.
 *
 * One function, one table, no second derivation anywhere. Every exported tool -
 * internal and protocol alike - gets its hints from here, so a client's
 * read-only filter and its destructive-action prompt are answered by the same
 * classification the approval runtime and the audit trail already use.
 *
 * The two rules, and why each is drawn where it is:
 *
 *   `readOnlyHint = actionKind === "read"`. Only `read` promises no side effect
 *   outside the read path. `local_write` writes Vex-local state, `schedule`
 *   moves engine execution, `approval_prepare` writes a durable intent. None of
 *   those is read-only, even though none of them signs anything.
 *
 *   `destructiveHint = actionKind in {user_wallet_broadcast, destructive}`.
 *   These are the two classes whose effect cannot be taken back: a signed
 *   transaction on a public chain, and a delete with no expand-and-contract
 *   path. `external_post` mutates somebody else's system and is real, but it is
 *   not the irreversible-value class MCP's destructive prompt is about, and
 *   marking it would train users to click through the prompt that matters.
 *
 * NEVER derived from `mutating`. `mutating` is the in-app permission gate and
 * is coarser: it is true for `approval_prepare` and `local_write` too, so a
 * `mutating`-derived `destructiveHint` would fire a client's irreversible-action
 * warning on a tool that signs nothing and moves nothing.
 */

import type { ActionKind } from "../../tools/taxonomy.js";
import type { StudioToolAnnotations } from "./types.js";

/**
 * The action kinds whose effect is irreversible once it lands.
 *
 * Exported so the annotation lint can assert the set by name rather than
 * re-listing it, which is what stops a new `ActionKind` from being silently
 * classified as harmless.
 */
export const DESTRUCTIVE_ACTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "user_wallet_broadcast",
  "destructive",
]);

export function studioToolAnnotations(actionKind: ActionKind): StudioToolAnnotations {
  return {
    readOnlyHint: actionKind === "read",
    destructiveHint: DESTRUCTIVE_ACTION_KINDS.has(actionKind),
  };
}
