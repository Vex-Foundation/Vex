/**
 * The vocabulary every Morpho activity row is written in, and the two facts the
 * database will no longer catch if a writer gets them wrong.
 *
 * ── `chainFamily` IS EXPLICIT HERE, AND THAT IS THE WHOLE POINT ─────────────
 *
 * `createPendingActivityEvent` defaults `chain_family` to `'eip155'`, and before
 * migration 079 the `agent_activity_kind_family_binding` CHECK pinned every
 * `lend` row to `'solana'` - so a lend writer that FORGOT the family was
 * rejected by the database, loudly, on its first insert. 079 widened that
 * predicate to admit `kind = 'lend' AND chain_family = 'eip155'`, which is
 * exactly what makes Morpho possible and exactly what removes that safety net:
 * from now on both families satisfy the CHECK and only the writer knows which
 * one is true. Its own header records the risk in those words. So the value is
 * stated here, once, as a named constant, and a test asserts the value that
 * lands in the column rather than trusting the default to keep meaning this.
 *
 * ── `chain_id` COMES FROM THE CHAIN REGISTRY, NEVER FROM MODEL INPUT ────────
 *
 * 079 admits `lend` on ANY `eip155` chain id, deliberately (Morpho is deployed
 * on several and a per-deployment migration would be absurd). That widening puts
 * the whole burden on the writer: a chain id taken from a tool parameter would
 * let model input decide what a database row claims about where money moved.
 * `@tools/morpho/chains.js` owns the intersection of Morpho's chains and Vex's,
 * and `morphoActivityChainSlug` below is the only door to the slug that travels
 * with it.
 */

import { morphoChainSlug } from "@tools/morpho/chains.js";
import type {
  AgentActivityEventRole,
  BridgeChainFamily,
} from "@vex-agent/db/repos/agent-activity.js";

/** The protocol string stored on every row this module writes. */
export const MORPHO_ACTIVITY_PROTOCOL = "morpho";

/** The `kind` arm of migration 079. Morpho vault supply IS variable-rate lending. */
export const MORPHO_ACTIVITY_KIND = "lend" as const;

/**
 * The chain family stored on every row this module writes. See the header: the
 * database stopped catching an omission here when 079 landed.
 */
export const MORPHO_ACTIVITY_CHAIN_FAMILY: BridgeChainFamily = "eip155";

/**
 * The five roles a Morpho execution writes. Narrowed from the full role union so
 * a Morpho caller cannot accidentally file a `swap`, `bridge` or `yield` row
 * through this path - `agent_activity_kind_role_binding` would reject it, but
 * failing at the type boundary beats failing at the database.
 *
 * ── ONE ROLE FOR ALL FOUR BLUE MARKET OPERATIONS ────────────────────────────
 *
 * `lend_borrow_operate` covers supply_collateral, withdraw_collateral, borrow
 * and repay, and the operation itself is a DELTA IN `intent_params` rather than
 * a role of its own. That is the Jupiter precedent verbatim
 * (`../../solana-jupiter/borrow-operate-params.ts`): one role, many shapes, and
 * the durable audit-facing description of what a specific call did lives in a
 * versioned, normalized effects payload - see `./borrow-operate-params.ts`.
 * Migration 079 already admits this role on the `eip155` lend arm, so no
 * vocabulary change was needed for the borrow lane and none was made.
 */
export type MorphoActivityRole = Extract<
  AgentActivityEventRole,
  "allowance" | "allowance_reset" | "lend_deposit" | "lend_withdraw" | "lend_borrow_operate"
>;

/** The one role every Blue market operation is filed under. There is no second. */
export const MORPHO_BORROW_OPERATE_ROLE = "lend_borrow_operate" as const;

/**
 * The agent-facing slug for a chain id, resolved from Vex's own Morpho registry.
 * `undefined` for a chain Vex does not operate on, which the caller records as
 * no slug rather than inventing one - `chain_slug` is a label, and a wrong label
 * on a money row is worse than an absent one.
 */
export function morphoActivityChainSlug(chainId: number): string | undefined {
  return morphoChainSlug(chainId);
}
