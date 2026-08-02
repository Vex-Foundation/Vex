/**
 * Vex's Trench Express integrator fee — the product-owner constants.
 *
 * Sibling of `src/tools/bridge-fee/constants.ts` (bridges),
 * `src/tools/kyberswap/constants.ts` (aggregator swaps) and
 * `jupiter-swaps/constants.ts` (Jupiter). Trench gets its own module because it
 * follows the BRIDGE mechanism, not the swap one: KyberSwap and Jupiter embed
 * the fee in a router/provider parameter, and the Trench Diamond exposes no
 * such parameter at all, so the fee can only be Vex's OWN transfer leg.
 */

import type { Address } from "viem";

import { VEX_TREASURY_EVM } from "../../../lib/vex-treasury.js";

// ── Vex integrator fee (Trench Express, RBC 4663) ───────────────────
//
// Product-owner-reviewed constants — NEVER derived from model/tool params. A
// model-controllable fee is an overcharge vector, so these are hard-coded next
// to the leg builder they configure and applied verbatim. Base is 10000, so
// 25 = 0.25%. Fees accrue to VEX_TREASURY_EVM (Vex-treasury: token buyback and
// burn). `fee-params-never-from-model.test.ts` fails automatically if a
// fee-shaped parameter ever reaches a Trench tool schema.

export const TRENCH_FEE_BPS = 25;

/**
 * The fee destination — a plain native value transfer target. The shared Vex
 * EVM treasury, deliberately: a venue-specific address would fragment the
 * buyback+burn accounting for no gain.
 */
export const TRENCH_FEE_RECEIVER_EVM: Address = VEX_TREASURY_EVM;

/**
 * WHICH LEG THE FEE IS TAKEN ON — owner decision 2026-08-02. READ THIS BEFORE
 * "FIXING" THE SELL CASE.
 *
 * The fee is ALWAYS charged on the ETH leg of the action:
 *
 *   BUY    — 25 bps of the ETH the user SPENDS. This is `currency_in`, exactly
 *            as every other Vex venue does it.
 *   SELL   — 25 bps of the ETH the user RECEIVES. This is a DELIBERATE,
 *            OWNER-APPROVED DEVIATION from the repo-wide `currency_in` rule.
 *   LAUNCH — 25 bps of the full `msg.value` (creation fee + prebuy).
 *
 * Why the sell deviates, so nobody "restores consistency" later:
 *
 *   1. `currency_in` on a Trench sell is the MEMECOIN. Charging it would make
 *      the Vex treasury accumulate a stream of possibly-taxing, possibly
 *      worthless bonding-curve tokens instead of a valuable, USD-priceable
 *      asset. That is not revenue; it is a liability with a gas cost.
 *   2. The fee-on-transfer / honeypot guard that protects the other venues
 *      (`src/tools/bridge-fee/fee-eligibility.ts`) does NOT cover chain 4663 —
 *      it is KyberSwap-slug scoped. So on Trench there is no mechanism that
 *      could even tell us a curve token is safe to skim.
 *   3. On this venue ONE LEG IS ALWAYS NATIVE ETH, in both directions. Taking
 *      the fee there is available on every trade, exactly computable, and
 *      honest to disclose.
 *
 * The disclosure carries this basis explicitly (`fee-disclosure.ts`), because a
 * fee charged on the output side must be stated as such rather than implied.
 */
export type TrenchFeeBasis = "buy_eth_in" | "sell_eth_out" | "launch_msg_value";

/**
 * The `agent_activity` `event_role` the Trench fee leg is recorded under.
 *
 * `bridge_fee` CANNOT be reused: `agent_activity_kind_role_binding` admits it
 * ONLY on the `kind = 'bridge'` arm, so a Trench fee row carrying it would be
 * rejected by the database. Migration 063 therefore adds `trench_fee` to
 * `agent_activity_event_role_valid` and to the `swap` AND `launch` arms of the
 * binding — a trade fee rides a `swap` execution, a launch fee rides a `launch`
 * one, and both are the SAME kind of leg.
 *
 * The fee gets its OWN row and must NOT also set the `AgentActivityVexFeeCharge`
 * fields: those exist for venues that take the fee INSIDE the transaction being
 * recorded, where it has no row of its own. Setting both would store the same
 * money twice (`db/repos/agent-activity/types.ts` states this explicitly).
 *
 * Like `bridge_fee`, this role is on `hashless-recovery.ts`'s
 * `LOCALLY_SIGNABLE_ACTIVITY_ROLES`: a fee leg that was planned but never
 * signed — because the trade reverted, or the process died between intent
 * creation and staging — is definitively not-attempted and must stay reapable
 * rather than pending forever.
 */
export const TRENCH_FEE_ACTIVITY_EVENT_ROLE = "trench_fee" as const;
