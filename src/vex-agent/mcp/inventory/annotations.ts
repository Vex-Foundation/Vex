/**
 * Owner decision O7, pinned LITERALLY: `ActionKind` -> MCP tool annotations,
 * plus the one declared override its 2026-09-07 amendment admits.
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
 *   `destructiveHint = actionKind in {user_wallet_broadcast, destructive}`, OR
 *   the manifest DECLARES `destructive: true`. These are the classes whose
 *   effect cannot be taken back: a signed transaction on a public chain, a
 *   delete with no expand-and-contract path, and - since the amendment - a
 *   venue execution whose manifest states its own irreversibility.
 *   `external_post` still does NOT imply the hint by itself: it mutates
 *   somebody else's system and is real, but a social post or an off-chain
 *   bookmark is not the irreversible-value class MCP's destructive prompt is
 *   about, and marking every one would train users to click through the prompt
 *   that matters.
 *
 * THE OVERRIDE IS A DECLARATION, NOT A SECOND DERIVATION, and that distinction
 * is what keeps this module the only annotation table. It is read from exactly
 * one field (`ProtocolToolManifest.destructive`), it can only ever ADD the
 * hint, and it is authored per tool next to the description that has to state
 * the same irreversibility in words. It exists because Lighter's
 * `external_post` executions submit signed exchange transactions that move
 * collateral, realise PnL, or destroy a resting order's queue position -
 * exactly the moment a client's irreversible-action prompt is worth showing.
 * See `tool-surface-spec/owner-decisions.md`, "O7 amendment (2026-09-07)".
 *
 * NEVER derived from `mutating`. `mutating` is the in-app permission gate and
 * is coarser: it is true for `approval_prepare` and `local_write` too, so a
 * `mutating`-derived `destructiveHint` would fire a client's irreversible-action
 * warning on a tool that signs nothing and moves nothing.
 */

import type { ActionKind } from "../../tools/taxonomy.js";
import type { ProtocolToolManifest } from "../../tools/protocols/types.js";
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

export function studioToolAnnotations(
  actionKind: ActionKind,
  /**
   * The manifest, for a PROTOCOL row. Omitted for an internal `ToolDef` and for
   * `vex_ToolDescribe`: neither has a manifest and neither may declare the
   * override, so an internal tool's irreversibility is carried by its
   * `actionKind`, the only classification its registry has.
   */
  manifest?: Pick<ProtocolToolManifest, "destructive">,
): StudioToolAnnotations {
  return {
    readOnlyHint: actionKind === "read",
    destructiveHint:
      DESTRUCTIVE_ACTION_KINDS.has(actionKind)
      || manifest?.destructive === true,
  };
}
