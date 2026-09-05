/**
 * THE LEND LANE, and the only place either of its two values is written.
 *
 * `lend_deposit` and `lend_withdraw` name TWO different operations: a curated
 * Morpho VAULT deposit/redeem, and a Blue MARKET supply/withdraw of the loan
 * asset. Supplying a loan asset IS lending, so the two reuse one kind rather
 * than minting a venue-shape-specific one that would fragment the agent's own
 * history - and `lane` is then the only thing between "put money in a curated
 * vault" and "lend into a Blue market".
 *
 * It is therefore not decoration, and it must have ONE owner. The lane travels
 * on the match input into `computePrequoteMatchHash` (`identity/hash.ts` reads
 * it to pick the material), it is what the execute registration is keyed on
 * (`prequote/registry.ts`), and it is what `vex_ToolDescribe.quoteGate` publishes
 * through the recorders' gate targets (`record/gate-targets.ts`). Written as a
 * literal in each of those, a lane could move on one side and stay put on the
 * others: the description would advertise an authorization the gate refuses, or
 * the recorder would persist an identity under a lane nothing looks for, on a
 * call that moves money.
 *
 * So every one of those sites reads THESE constants, and
 * `recorder-owned-gate-targets.test.ts` substitutes this module to prove it:
 * under the substitution both the identity the recorder persists and the
 * authorization ToolDescribe publishes move together. A literal restored
 * anywhere makes one of the two halves stand still, and the test goes red.
 *
 * Pure constants. No IO, no imports.
 */

/** The curated-vault lane: `morpho.vault.*` and what `morpho.vault.quote` writes. */
export const MORPHO_VAULT_LANE = "vault" as const;

/** The Blue market lane: `morpho.market.*` and what `morpho.market.quote` writes. */
export const MORPHO_MARKET_LANE = "market" as const;

/** The lane a shared lend kind must name. */
export type MorphoLendLane = typeof MORPHO_VAULT_LANE | typeof MORPHO_MARKET_LANE;
