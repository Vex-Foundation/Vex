/**
 * Retrieval metadata for the Morpho MARKET lane - the six operations that move
 * money on a Blue market, plus the preview that prices them. Four are the
 * BORROWER'S side (collateral and debt) and two are the LENDER'S (supplying the
 * loan asset into the market and taking it back out).
 *
 * The manifests at `morpho/manifests/market-{quote,supply-collateral,
 * withdraw-collateral,borrow,repay,supply,withdraw}.ts` reference these entries
 * by `toolId`.
 *
 * ── THE COLLISION THIS FILE MANAGES ─────────────────────────────────────────
 *
 * Every other Morpho execute lane is about a VAULT: one asset in, shares out, a
 * curator picking the markets. This lane is about a POSITION on ONE market: two
 * tokens, a debt, a liquidation price. The vocabularies are genuinely disjoint
 * and the passages below keep them that way - nothing here says vault, curator or
 * shares, and nothing in `execute-writes.ts` says collateral, borrow, debt,
 * repay, health factor or liquidation. The two LENDER tools below sit closest to
 * that boundary because a vault deposit answers a similar English sentence, and
 * they hold the line with the word the user is actually choosing: DIRECTLY, into
 * THIS market, with no curator and no fee.
 *
 * The sharper collision is INTERNAL, between these seven. Six of them are
 * imperative and committing while `morpho.market.quote` is conditional, exactly
 * as `quote-reads.ts` separates itself from `execute-writes.ts`: the quote owns
 * "would", "preview", "simulate", "check before", "how close to liquidation
 * would this leave me", and none of the six executes uses a conditional
 * construction. The six are then separated from each other by DIRECTION and by
 * WHICH TOKEN moves, which is their only real difference: collateral in,
 * collateral out, debt taken on, debt paid down, loan asset lent in, loan asset
 * taken back out.
 *
 * ── WHAT IS DELIBERATELY NOT PROMISED ───────────────────────────────────────
 *
 * NO LEVERAGE VOCABULARY ANYWHERE. Not "leverage", not "loop", not "long", not
 * "short", not "multiply my exposure". Vex cannot perform a leveraged position:
 * the atomic supply-and-borrow bundle requires a standing GeneralAdapter1
 * authorization the owner's ruling forbids, so a loop would be N separate
 * transactions each independently gated, with the position sitting in an
 * intermediate state between them. Retrieving these tools for a leverage request
 * would train the agent to promise a product Vex does not have. A user who asks
 * to loop should be told what Vex can actually do, one operation at a time,
 * which is what the doctrine says.
 *
 * The chain list is not spelled into the passages. It has one home in the
 * structured `chains` field, for the reason batch 1 measured.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { MORPHO_CHAINS_FOR_DISCOVERY } from "../../morpho/discovery-text.js";

export const MORPHO_BORROW_EXECUTE_DISCOVERY = {
  "morpho.market.quote": {
    embeddingText: embeddingText(
      `Price one Morpho Blue market operation before anyone commits: what supplying collateral, borrowing, paying ` +
      `debt down, pulling collateral back out, lending into the market or taking what was lent back out would do. ` +
      `Use when the question is conditional and names an amount: what would this do to my health factor, how close ` +
      `to liquidation would it leave me, can this market fund it, what would I have to permit first. ` +
      `Answers with the health factor before and after, the free liquidity, and the decoded transaction. ` +
      `Signs nothing. ` +
      `Example queries: what would borrowing this do to my health factor, preview supplying collateral here.`,
    ),
    aliases: [
      "preview a morpho market operation",
      "what would borrowing do to my health factor",
      "how close to liquidation would this leave me",
      "check before i borrow",
      "price a collateral supply",
      "simulate repaying my debt",
      "can this market fund my loan",
      "dry run a borrow",
      "price lending into this market",
    ],
    exampleIntents: [
      "what would borrowing 500 usdc do to my health factor",
      "preview supplying cbbtc as collateral on this market",
      "how much can i safely borrow against this collateral",
      "simulate paying off my morpho loan",
      "would withdrawing this collateral put me at risk",
      "what would i earn lending 1000 usdc into this market",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.market.supplyCollateral": {
    embeddingText: embeddingText(
      `Move the wallet's own token onto a Morpho Blue market as COLLATERAL, for real and on chain. ` +
      `Use when the user tells Vex to go ahead and back the position: post this as collateral, add more collateral, ` +
      `top up my collateral. ` +
      `Collateral earns nothing and is not a deposit; it supports a loan and holds the position away from ` +
      `liquidation. ` +
      `Sends two transactions behind one confirmation: permission for exactly this amount, then the supply. ` +
      `Example queries: post this as collateral, add collateral to my morpho position, top up before i borrow.`,
    ),
    aliases: [
      "supply collateral on morpho",
      "post collateral",
      "add more collateral",
      "top up my collateral",
      "back my position with this token",
      "secure my loan with collateral",
      "put up collateral now",
      "increase my collateral buffer",
    ],
    exampleIntents: [
      "supply 0.5 cbbtc as collateral on this market",
      "post more collateral so i stop being close to liquidation",
      "add collateral to my morpho position now",
      "top up the collateral before i borrow",
      "go ahead and put up the collateral",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.market.borrow": {
    embeddingText: embeddingText(
      `Take a loan against collateral already posted on a Morpho Blue market, for real and on chain. ` +
      `Use when the user tells Vex to go ahead and draw the funds: borrow this much, take out the loan, ` +
      `draw against my collateral, get cash without selling. ` +
      `The borrowed token lands in the signing wallet and the position starts owing interest immediately. ` +
      `Refused if it would leave the position too close to liquidation, or if the market cannot fund it. ` +
      `Example queries: borrow usdc against my collateral, take out the loan now, draw funds without selling.`,
    ),
    aliases: [
      "borrow against my collateral",
      "take out a loan on morpho",
      "draw stablecoins against my position",
      "get cash without selling my holdings",
      "borrow from this market now",
      "open a loan on this market",
      "go ahead with the borrow",
      "take the debt on",
    ],
    exampleIntents: [
      "borrow 500 usdc against my cbbtc collateral",
      "take out a loan on this morpho market now",
      "draw funds against my position without selling",
      "go ahead and borrow the stablecoins",
      "open the loan on this market",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.market.repay": {
    embeddingText: embeddingText(
      `Pay debt down on a Morpho Blue market, for real and on chain, partly or all the way to zero. ` +
      `Use when the user tells Vex to settle up: repay this much, pay off my loan, clear the debt, ` +
      `close the position out, get my health factor back up. ` +
      `Clearing it entirely has its own switch, because naming an amount always leaves accruing dust behind and ` +
      `keeps the collateral locked. ` +
      `Example queries: repay my morpho loan, pay off the debt completely, clear what i owe on this market.`,
    ),
    aliases: [
      "repay my morpho debt",
      "pay off the loan",
      "clear what i owe",
      "settle the debt completely",
      "pay down my borrow",
      "close out my loan position",
      "get my health factor back up",
      "return the borrowed funds",
    ],
    exampleIntents: [
      "repay 200 usdc of my morpho loan",
      "pay off my debt on this market completely",
      "clear the whole loan and close the position",
      "pay down enough to get out of danger",
      "settle what i owe on this morpho market",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.market.withdrawCollateral": {
    embeddingText: embeddingText(
      `Withdraw collateral back off a Morpho Blue market into the wallet, for real and on chain. ` +
      `Use when the user tells Vex to take the backing out: withdraw my collateral, get my token back, ` +
      `free up what is locked, unwind the position now the debt is settled. ` +
      `Taking collateral out moves the position CLOSER to liquidation whenever debt remains, and is refused if it ` +
      `would leave too little support behind. ` +
      `Example queries: withdraw my collateral from this market, get my cbbtc back, free up the locked token.`,
    ),
    aliases: [
      "withdraw collateral from morpho",
      "take my collateral back",
      "get my locked token out",
      "free up my collateral",
      "unwind the position",
      "remove collateral from this market",
      "pull the backing out",
      "reclaim my collateral now",
    ],
    exampleIntents: [
      "withdraw my cbbtc collateral from this market",
      "take the collateral back now that i repaid",
      "free up the token locked in this morpho position",
      "remove some collateral from the market",
      "reclaim what i posted as collateral",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
  // ── THE LENDER'S SIDE ─────────────────────────────────────────────────────
  //
  // The hardest collision in this file, and it is not with the borrow tools: it
  // is with `execute-writes.ts`, whose vault deposit answers almost the same
  // English sentence ("earn on my usdc"). The two are kept apart by the word the
  // user actually chooses between: DIRECTLY / this market / no curator / no fee
  // here, versus curator / vault / spread across markets there. Nothing below
  // says vault, curator or shares, and nothing below says collateral, health
  // factor or liquidation either, because a lender has none of those.
  "morpho.market.supply": {
    embeddingText: embeddingText(
      `Lend the wallet's own asset straight into ONE Morpho Blue market to earn its rate, for real and on chain, ` +
      `with no manager in between and no fee taken out. ` +
      `Use when the user tells Vex to put money to work in a specific market they picked: lend into this market, ` +
      `supply usdc here directly, earn on this market myself. ` +
      `Earns the full rate borrowers pay, and in exchange the money sits in that one market and nobody moves it if ` +
      `that market goes bad. ` +
      `Example queries: lend usdc into this market directly, supply here and skip the fee.`,
    ),
    aliases: [
      "lend into this morpho market directly",
      "supply usdc to this market myself",
      "earn the full rate with no curator fee",
      "put my stablecoins into this specific market",
      "become a lender on this market",
      "skip the curator and lend directly",
      "supply the loan asset here",
      "earn interest on this market directly",
    ],
    exampleIntents: [
      "lend 1000 usdc into the cbbtc usdc market directly",
      "supply to this market instead of paying a management fee",
      "i picked this market myself, put my usdc in it",
      "go ahead and lend into this market now",
      "earn the borrow rate on this market directly",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.market.withdraw": {
    embeddingText: embeddingText(
      `Take assets that were lent into ONE Morpho Blue market back out into the wallet, for real and on chain, ` +
      `with the interest they earned. ` +
      `Use when the user tells Vex to pull the lent money back: withdraw what i lent here, take my usdc back out ` +
      `of this market, stop lending into it. ` +
      `Limited by what the wallet actually lent and by how much of the market is not currently borrowed, so a busy ` +
      `market can return less than the whole position until someone repays. ` +
      `Example queries: withdraw what i lent to this market, take my usdc back out with the interest.`,
    ),
    aliases: [
      "withdraw what i lent to this market",
      "take my lent usdc back out",
      "stop lending into this market",
      "pull my money out of this market",
      "redeem what i supplied here with interest",
      "exit my lender position on this market",
      "get the loan asset i supplied back",
      "take out part of what i lent",
    ],
    exampleIntents: [
      "withdraw the usdc i lent into this market",
      "take my lender position out of this market now",
      "pull out half of what i supplied here",
      "stop lending into this market and take the interest",
      "get back what i lent plus what it earned",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 7;
if (Object.keys(MORPHO_BORROW_EXECUTE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `MORPHO_BORROW_EXECUTE_DISCOVERY has ${Object.keys(MORPHO_BORROW_EXECUTE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
