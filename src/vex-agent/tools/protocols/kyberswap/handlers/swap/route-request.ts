/**
 * The Kyber aggregator request/response shapes the quote and execute paths
 * share - the integrator fee line spread into BOTH `/routes` calls, and the
 * response types derived from the client itself.
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import {
  KYBERSWAP_FEE_BPS,
  KYBERSWAP_FEE_CHARGE_BY,
  KYBERSWAP_FEE_RECEIVER,
} from "@tools/kyberswap/constants.js";

/**
 * Vex integrator fee fields for GET /routes. Sourced ONLY from the
 * product-owner-reviewed venue constants (never from tool/model params) and
 * spread IDENTICALLY into the quote and the execute re-quote, so the route the
 * user was shown and the route that broadcasts carry the same fee line. Kyber
 * echoes these back inside `routeSummary.extraFee`, which POST /route/build
 * consumes verbatim - we never mutate the summary.
 */
export const VEX_INTEGRATOR_FEE_ROUTE_PARAMS = {
  feeAmount: String(KYBERSWAP_FEE_BPS),
  isInBps: true,
  chargeFeeBy: KYBERSWAP_FEE_CHARGE_BY,
  feeReceiver: KYBERSWAP_FEE_RECEIVER,
} as const;

export type KyberGetRouteResponse = Awaited<ReturnType<ReturnType<typeof getKyberAggregatorClient>["getRoute"]>>;
export type KyberBuildRouteResponse = Awaited<ReturnType<ReturnType<typeof getKyberAggregatorClient>["buildRoute"]>>;
