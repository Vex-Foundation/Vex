/**
 * Why an ACTIVE-ONLY Pendle lookup came back empty — in words, and nothing else.
 *
 * The R5b matrix keeps `pt.buy`, `yt.buy`, `yt.sell`, `py.mint`, `lp.add`,
 * `pt.sell` and `py.redeem` on the frozen active-only resolver. On a matured
 * market those lookups therefore return nothing, and the answer used to be "No
 * active Pendle market for this PT" — which a context-free agent reasonably
 * reads as "this PT does not exist" and acts on by hunting for another address.
 * The truth is usually the opposite and far more useful: the market exists, it
 * matured on a specific date, and a different tool can act on it.
 *
 * THE LANE SEPARATION, ENFORCED BY THE SIGNATURE. This module reads the
 * READ-ONLY classification lane (`market-read.ts`, which sees both maturities)
 * and returns a `string`. It hands back no market, no expiry field and no
 * address, so the rule "the classification lane must never feed a quote output,
 * a prequote identity, or an execution parameter" is a property of the type
 * rather than a convention someone has to remember. A caller that wanted to
 * trade on this answer would have to parse English out of a refusal message.
 *
 * It also never throws. It is only ever called on a path that is ALREADY
 * failing, and a refusal that dies with a second exception strands the agent
 * worse than the bad sentence it replaced.
 */

import { resolveMarketForRead } from "./market-read.js";

/** The active-only actions that can hit a matured market and must refuse. */
export type PendleActiveOnlyAction =
  | "pt.buy"
  | "pt.sell"
  | "yt.buy"
  | "yt.sell"
  | "py.mint"
  | "py.redeem"
  | "lp.add";

export interface PendleRefusalContext {
  readonly action: PendleActiveOnlyAction;
  /** Which leg the caller supplied, for a message that names what they passed. */
  readonly leg: "PT" | "YT" | "market";
}

/**
 * What the agent should do instead, per action. Every matured position has a
 * legitimate next move — that is the whole point of naming maturity rather than
 * reporting absence.
 */
const MATURED_NEXT_STEP: Record<PendleActiveOnlyAction, string> = {
  "pt.buy": "Buying a matured PT is impossible - there is no yield left to buy. If you already hold this PT, redeem it with pendle__pt_redeem.",
  "pt.sell": "Selling into the AMM is impossible after expiry, but you have not lost the position: redeem the PT for its underlying with pendle__pt_redeem.",
  "yt.buy": "Buying YT after expiry is impossible — a matured YT accrues nothing and is worth zero.",
  "yt.sell": "A matured YT has already decayed to zero and there is no market to sell it into. Any remaining value in this market sits in the PT (pendle__pt_redeem) or the LP (pendle__lp_remove).",
  "py.mint": "Minting PT+YT after expiry is impossible. To exit an existing position use pendle__pt_redeem.",
  "py.redeem": "The PT+YT pair redemption is a PRE-EXPIRY action. After maturity the YT is worthless and the PT redeems on its own - use pendle__pt_redeem.",
  "lp.add": "Adding liquidity after expiry is impossible. To exit an existing LP position use pendle__lp_remove, which does work after expiry.",
};

/**
 * One agent-facing sentence explaining why an active-only lookup found nothing.
 *
 * `nowMs` is passed straight through to the classification lane so maturity is
 * never decided from a clock read inside a refusal path.
 */
export async function explainUnresolvedPendleMarket(
  chainId: number,
  chainSlug: string,
  address: string,
  context: PendleRefusalContext,
  nowMs: number = Date.now(),
): Promise<string> {
  let lookup;
  try {
    lookup = await resolveMarketForRead(chainId, address, nowMs);
  } catch {
    // The classifier is a courtesy, not a dependency. If it cannot answer, say
    // only what the active-only lookup already established.
    return `No ACTIVE Pendle market on ${chainSlug} has ${context.leg} ${address}, and Vex could not check whether a matured one does. Try pendle__market_get, which reads the full catalogue including matured markets.`;
  }

  if (lookup.status === "found" && lookup.matured) {
    const expiry = lookup.market.expiry ?? "an unreported date";
    return (
      `This Pendle market matured on ${expiry.slice(0, 10)} — ${MATURED_NEXT_STEP[context.action]} `
      + "Its market data is still readable with pendle__market_get and pendle__positions_get."
    );
  }

  if (lookup.status === "found") {
    // Present, ACTIVE, yet the money-path resolver missed it — so maturity is
    // NOT the cause and must not be claimed as one.
    return `${context.leg} ${address} belongs to a Pendle market on ${chainSlug} that is still active, but it is not usable for ${context.action} on this chain. Check the leg you passed: pendle__market_get reports the market's PT, YT and LP addresses.`;
  }

  if (lookup.status === "not_found") {
    return `No Pendle market on ${chainSlug} has ${context.leg} ${address} - the full catalogue was read, including matured markets. Check the chain first: the same address on another chain is a different asset. pendle__markets_discover lists what does exist.`;
  }

  return `Vex could not prove whether ${chainSlug} has a market with ${context.leg} ${address}: the catalogue walk hit its page budget before finishing, so absence is NOT established. Retry, or narrow the search with pendle__markets_discover before concluding the market does not exist.`;
}
