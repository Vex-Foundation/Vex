/**
 * How a market-scoped Pendle READ tool reports that it did not find the market.
 *
 * There are TWO answers here and collapsing them is the defect this module
 * exists to prevent. `resolveMarketForRead` reads the catalogue to exhaustion
 * when it can, and says so; when its page budget runs out first, the address's
 * absence is UNPROVEN. "Pendle has no such market" is a fact an agent may act on
 * - it may conclude the address is wrong, or on another chain. "I could not
 * finish looking" is not, and rules/90 is explicit that a reader which cannot
 * prove what happened must decline rather than guess.
 *
 * Shared by every tool that starts from a market address, so the two states can
 * never drift into different wording - or, worse, into one.
 */

import type { PendleReadMarketLookup } from "../market-read.js";

export type PendleMarketAbsence = Exclude<PendleReadMarketLookup, { status: "found" }>["status"];

export interface PendleMarketAbsenceAnswer {
  summary: string;
  resolution: PendleMarketAbsence;
  /** TRUE only when the catalogue was read to exhaustion without a match. */
  absenceProven: boolean;
  chain: string;
  queried: Record<string, string>;
  asOf: string;
  nextStep: string;
}

export function marketAbsenceAnswer(
  status: PendleMarketAbsence,
  chain: string,
  address: string,
  addressParam: string,
  asOf: string,
): PendleMarketAbsenceAnswer {
  const proven = status === "not_found";
  return {
    summary: proven
      ? `No Pendle market on ${chain} has ${addressParam} ${address}. Pendle's full catalogue for that chain was read, including matured markets.`
      : `Vex could not prove whether ${chain} has a market with ${addressParam} ${address}: the catalogue walk hit its page budget before finishing. Absence is NOT established - do not conclude the market does not exist.`,
    resolution: status,
    absenceProven: proven,
    chain,
    queried: { [addressParam]: address },
    asOf,
    nextStep: proven
      ? "Check the chain first - the same address on another chain is a different asset. pendle__markets_discover lists what does exist, and includeMatured:true covers expired markets."
      : "Retry, or narrow with pendle__markets_discover (which pages explicitly and reports hasMore) before drawing any conclusion.",
  };
}
