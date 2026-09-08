/**
 * Vex's integrator fee on Uniswap — the product-owner constants.
 *
 * Sibling of `src/tools/bridge-fee/constants.ts` and
 * every other venue's own `fee/constants.ts`. Uniswap gets its own module for
 * the same reason each of them does: the fee is NOT a venue parameter here.
 * V2 Router02 and V3 SwapRouter02 — the only routers this venue is pinned to —
 * expose no integrator-fee field at all (unlike KyberSwap's `feeReceiver` or
 * Jupiter's referral account), so the fee can only be Vex's OWN transfer leg,
 * and its constants belong next to that leg rather than inside a request shape.
 *
 * NEVER derived from model or caller params. A model-controllable fee is an
 * overcharge vector; a caller-supplied `feeBps`/`feeReceiver`/`feeAmount` is
 * rejected BY NAME (`handlers/swap/forbidden-params.ts`), never silently
 * dropped.
 */

import type { Address } from "viem";

import { VEX_TREASURY_EVM } from "../../../lib/vex-treasury.js";

/** Base is 10000, so 25 = 0.25% — the same rate every other Vex venue charges. */
export const UNISWAP_FEE_BPS = 25;

/**
 * Taken from the INPUT token, the same `currency_in` semantics KyberSwap,
 * Jupiter and the bridges use: the swap executes on `amountIn − fee` and the
 * user is debited exactly `amountIn` in total.
 */
export const UNISWAP_FEE_CHARGE_BY = "currency_in" as const;

/** Fee destination — Vex treasury (token buyback and burn). */
export const UNISWAP_FEE_RECEIVER_EVM: Address = VEX_TREASURY_EVM;

/**
 * The `agent_activity` `event_role` the fee leg is recorded under (migration
 * 066). `bridge_fee` is barred by the kind↔role binding (`kind = 'bridge'`
 * only) and `pools_fee` names a different venue, so this role is its own -
 * venue-neutral, so a later fee-parameterless swap venue reuses it.
 */
export const UNISWAP_FEE_ACTIVITY_EVENT_ROLE = "swap_fee" as const;
