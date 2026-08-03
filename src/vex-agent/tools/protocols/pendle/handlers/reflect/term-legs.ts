/**
 * Shared leg vocabulary for the three Pendle term-mobility handlers
 * (`pendle.pt.rollover`, `pendle.lp.transfer`, `pendle.lp.toPt`): the
 * `agent_activity` role each tool's row carries, and the two per-leg reads
 * every one of them performs on a Convert response.
 */

import type { Address } from "viem";

import type { PendleMarket } from "@tools/pendle/types.js";

import { percentString } from "../../money-format.js";
import { trustedNumber } from "../../trusted-fields.js";
import type { PendleActivityRole } from "../signed-broadcast.js";

/**
 * The activity role each tool's row carries (migration 053). A rollover moves a
 * PT (`yield_pt`); an LP transfer and an LP→PT conversion both spend an LP
 * (`yield_lp`). All three are ONE-IN-ONE-OUT, so the Option-C second-leg columns
 * stay NULL and migration 053's dual invariants do not apply.
 */
export const ROLLOVER_ROLE: PendleActivityRole = "yield_pt";
export const LP_ROLE: PendleActivityRole = "yield_lp";

/** The market's implied APY as a percent string, or null when unreported. */
export function impliedApyPercent(market: PendleMarket): string | null {
  return percentString(trustedNumber(market.details.impliedApy, 100));
}

/**
 * The route output for a KNOWN token — never `outputs[0]`.
 *
 * The provider's `outputs` order is its OWN canonical order and does not echo
 * the request (measured 2026-07-28, `calldata/price-floor.ts`), so reading a leg
 * positionally is how a raw amount ends up attributed to the wrong token.
 */
export function outputAmountFor(
  outputs: readonly { token: string; amount: string }[],
  token: Address,
): string {
  return outputs.find((o) => o.token.toLowerCase() === token.toLowerCase())?.amount ?? "0";
}
