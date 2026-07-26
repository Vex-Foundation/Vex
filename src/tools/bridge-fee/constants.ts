/**
 * Vex bridge integrator fee — the product-owner constants.
 *
 * Sibling of `src/tools/kyberswap/constants.ts` (aggregator swaps) and
 * `src/tools/solana-ecosystem/jupiter/jupiter-swaps/constants.ts` (Jupiter
 * swaps). Bridges get their own module because the fee is VENUE-INDEPENDENT:
 * it is not a provider parameter at all, it is Vex's own transfer leg, so it
 * belongs next to the leg builders rather than inside Khalani's or Relay's
 * request shapes.
 */

import type { Address } from "viem";

import { VEX_TREASURY_EVM, VEX_TREASURY_SOLANA } from "../../lib/vex-treasury.js";

// ── Vex integrator fee (bridges) ────────────────────────────────────
//
// Product-owner-reviewed constants — NEVER derived from model/tool params. A
// model-controllable fee is an overcharge vector, so these are hard-coded next
// to the leg builders they configure and applied verbatim. Base is 10000, so
// 25 = 0.25%. Charged in the INPUT token as Vex's OWN transfer leg; the bridge
// venue is never asked for a referral cut and no on-chain approval is needed
// (it is our own transfer, not a pull). Fees accrue to VEX_TREASURY_EVM /
// VEX_TREASURY_SOLANA (Vex-treasury: token buyback and burn).
//
// WHY NOT the provider mechanism (settled by live measurement 2026-07-25, do
// not reopen): Khalani exposes `referrerFeeBps`, but `resolveRouteBestIndex`
// ranks routes on POST-fee `amountOut`, so ASKING for the fee is exactly what
// evicts Hyperstream — the only filler that honours it. Across 15 measured
// cells (Base→Arbitrum/Optimism/Polygon USDC × 5 sizes) Vex collected in 0/15
// and the user was strictly WORSE off in 6/15. Hyperstream's edge over the
// runner-up is 4.65 bps at $10 and 0.40 bps at $50, so no fixed constant
// collects. The field is also EVM-only (a base58 referrer is rejected with
// `Invalid EVM checksum address`), which forecloses Solana destinations.

export const BRIDGE_FEE_BPS = 25;

/** Basis-point base. Kept next to the rate so the two can never drift apart. */
export const BRIDGE_FEE_BPS_DENOMINATOR = 10_000n;

/**
 * The fee is taken from the INPUT token — the same `currency_in` semantics
 * KyberSwap and Jupiter already use, so `amount` stays the TOTAL the user is
 * debited across every venue.
 */
export const BRIDGE_FEE_CHARGE_BY = "currency_in" as const;

/** EVM fee destination — a plain `transfer` recipient (or a native value transfer target). */
export const BRIDGE_FEE_RECEIVER_EVM: Address = VEX_TREASURY_EVM;

/**
 * Solana fee destination — the treasury WALLET. The SPL leg pays its
 * associated token account, derived under the mint's real owner program; a
 * native-SOL leg pays this address directly.
 */
export const BRIDGE_FEE_RECEIVER_SOLANA: string = VEX_TREASURY_SOLANA;

/**
 * The `agent_activity` `event_role` the Vex fee leg is recorded under.
 *
 * Migration 050 added `bridge_fee` to the two closed vocabularies that govern
 * `event_role` (`agent_activity_event_role_valid` and, on the bridge arm,
 * `agent_activity_kind_role_binding`). Before it, this leg was recorded as
 * `allowance` — a reasoned fallback (`bridge_deposit` is DISQUALIFIED because
 * `sync/bridge-activity-repair-production-deps.ts` correlates the provider
 * order by selecting the sibling `event_role = 'bridge_deposit'` row, so a
 * second such row would hand the repair sweep the FEE hash as the deposit hash;
 * `bridge_fill_observed`/`bridge_refund` are destination-side externally-
 * observed evidence, which this leg is not) but an untrue one: a fee collection
 * is not an approval, and the agent reads this record back.
 *
 * What did NOT change with the role: the leg is still the FINAL Vex-signed
 * origin leg, still staged through the same CAS primitives, and still on
 * `hashless-recovery.ts`'s `LOCALLY_SIGNABLE_ACTIVITY_ROLES`, so a fee row that
 * was never signed stays reapable exactly as it was under `allowance`.
 *
 * `bridge_deposit` remains disqualified for the same reason as before — the
 * repair sweep's sibling selection must find the deposit and only the deposit.
 */
export const BRIDGE_FEE_ACTIVITY_EVENT_ROLE = "bridge_fee" as const;
