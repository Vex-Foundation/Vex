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
 * ONE VENUE, TWO KINDS - and that is the ledger being right, not a compromise.
 *
 * A reward claim files as `yield` / `yield_claim`, while every vault and market
 * operation files as `lend`. The reason is that `kind` describes THE OPERATION,
 * not the protocol: sweeping an incentive campaign's accrued tokens is income,
 * and it is the same act whether the position that earned it sat in a Morpho
 * vault, a Pendle market, or anywhere else. `pendle.claim` already files exactly
 * this way, so filing a Morpho sweep as `lend_something` would make the ledger
 * answer "show me every claim" differently depending on which venue earned it.
 * One word, one meaning, across venues.
 *
 * It is also the shape the DATABASE already admits, with no migration and no new
 * vocabulary: `agent_activity_kind_family_binding` does not restrict `yield` on
 * `eip155`, and `agent_activity_yield_confirmed_legs` scopes `yield_claim` to
 * "an OUTPUT credit and NOTHING more" - which is precisely a claim, because a
 * claim spends nothing but gas. Minting a `lend_claim` role would have meant a
 * stored-data-contract change pushed permanently to AgentScan to describe an act
 * the vocabulary could already describe.
 *
 * The rewards themselves are NOT Morpho's own token and are not paid by Morpho:
 * they come from Merkl campaigns that a Morpho position happened to qualify for.
 * `protocol` stays `"morpho"` because that is the venue the agent acted through
 * and the namespace that owns the tool.
 */
export const MORPHO_CLAIM_ACTIVITY_KIND = "yield" as const;

/**
 * The one role a reward claim is filed under. Out-only by database contract, and
 * the reason this lane never records a `tokenIn`.
 */
export const MORPHO_CLAIM_ROLE = "yield_claim" as const;

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
 * ── ONE ROLE FOR THE FOUR BORROWER-SIDE MARKET OPERATIONS ───────────────────
 *
 * `lend_borrow_operate` covers supply_collateral, withdraw_collateral, borrow
 * and repay, and the operation itself is a DELTA IN `intent_params` rather than
 * a role of its own. The LENDER'S two (`supply`, `withdraw`) file under
 * `lend_deposit` / `lend_withdraw` instead - see `morphoMarketOperationRole`. That is the Jupiter precedent verbatim
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

/** The role the four BORROWER-side Blue market operations are filed under. */
export const MORPHO_BORROW_OPERATE_ROLE = "lend_borrow_operate" as const;

/**
 * The role a Blue market operation is filed under, chosen from the operation.
 *
 * ── WHY THE LENDER'S TWO DO NOT USE `lend_borrow_operate` ───────────────────
 *
 * Because they are not borrow operations. Supplying a market's loan asset to
 * earn its rate IS LENDING, the same act a vault deposit performs, and the role
 * answers "what did the agent do" rather than "which venue-internal shape did
 * the call have". Filing it under a borrow role would make "show me everything I
 * lent" return the wrong set forever, and minting a `lend_market_supply` role
 * would push a stored-data-contract change to AgentScan to describe an act the
 * vocabulary already describes. So the EXISTING `lend_deposit` / `lend_withdraw`
 * roles are reused, with no migration.
 *
 * WHAT KEEPS THE TWO LANES APART IN THE LEDGER is not the role: it is the row's
 * own `route_provenance` (the `morphoBorrow` block, which only this lane writes)
 * and its `intent_params`, which carry a versioned effects payload naming the
 * market id and the operation. `sync/executed-amount-fallback/venue-dispatch.ts`
 * routes on that provenance FIRST for exactly this reason, because a market
 * supply mints no share token and would decline forever under the vault's
 * net-delta rule.
 */
const ROLE_FOR_OPERATION: Readonly<Record<string, MorphoActivityRole>> = {
  supply: "lend_deposit",
  withdraw: "lend_withdraw",
};

export function morphoMarketOperationRole(operation: string): MorphoActivityRole {
  return ROLE_FOR_OPERATION[operation] ?? MORPHO_BORROW_OPERATE_ROLE;
}

/**
 * The agent-facing slug for a chain id, resolved from Vex's own Morpho registry.
 * `undefined` for a chain Vex does not operate on, which the caller records as
 * no slug rather than inventing one - `chain_slug` is a label, and a wrong label
 * on a money row is worse than an absent one.
 */
export function morphoActivityChainSlug(chainId: number): string | undefined {
  return morphoChainSlug(chainId);
}
