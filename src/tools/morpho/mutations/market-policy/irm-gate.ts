/**
 * LAYER 0: is the market's interest rate model the chain's pinned one?
 *
 * The cheapest gate and the only one needing no network at all, so it runs
 * first.
 */

import type { Address } from "viem";

import { MORPHO_MARKET_POLICY_CONTRACTS } from "../../constants.js";
import { NOTHING_HAPPENED_HINT, policyViolation } from "./refusal.js";

/**
 * Assert the market's IRM is the chain's pinned AdaptiveCurveIRM.
 *
 * EXACT EQUALITY, no family match and no heuristic. The IRM decides what the
 * borrower pays; an IRM Vex does not recognise is one whose rate curve nobody
 * reviewed, and a market can name any contract at all here.
 */
export function assertPinnedIrm(chainId: number, irm: Address): string {
  const pinned = MORPHO_MARKET_POLICY_CONTRACTS[chainId];
  if (pinned === undefined) {
    policyViolation(
      `Refusing the market: Vex has no pinned Morpho market-policy contracts for chain ${chainId}, so neither its `
      + "interest rate model nor its oracle can be checked against anything.",
      NOTHING_HAPPENED_HINT,
    );
  }
  const actual = irm.toLowerCase();
  const expected = pinned.adaptiveCurveIrm.toLowerCase();
  if (actual !== expected) {
    policyViolation(
      `Refusing the market: FAILING PREDICATE "irm". Its interest rate model is ${actual}, and Vex borrows only `
      + `against the chain's pinned AdaptiveCurveIRM ${expected}. Morpho Blue is permissionless, so a market may `
      + "name any contract as its rate model, including one that can charge an arbitrary rate.",
      NOTHING_HAPPENED_HINT,
    );
  }
  return actual;
}
