/**
 * `virtuals.trade.quote` - read-only, and the whole approval preview.
 *
 * It reads the CHAIN, never the API row: the Virtuals API is discovery, and the
 * money authority is `BondingV5.tokenInfo`, `FFactoryV2`'s taxes, the pair's own
 * anti-sniper clock and `FRouterV3.getAmountsOut` - all at one pinned block.
 *
 * WHAT IT SEALS. The answer's `quoteAuthority` channel carries the execution
 * snapshot: the contracts and their implementations, the side, the amounts, the
 * fee, the taxes, the accepted anti-sniper bound, the enforced floor and the
 * expiry. The execute claims exactly one such row, re-reads the chain, and holds
 * its own derivation to the sealed one. The floor is derived HERE, once, and the
 * execute writes that number into the calldata; it never re-derives one from a
 * fresher curve read.
 *
 * WHAT IT REFUSES rather than answers around: a chain with no curve (typed
 * hand-off naming the tool that can), a graduated agent (hand-off naming the AMM
 * venue and the pool), an unreadable tax or anti-sniper clock, and an ACTIVE
 * anti-sniper window on the traded side unless the caller stated a bound they
 * accept.
 */

import { getAddress } from "viem";

import {
  getVirtualsCurvePublicClient,
  readCurveQuote,
  readCurveState,
  type CurveState,
} from "@tools/virtuals/curve/index.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { PREQUOTE_MAX_AGE_MS } from "@vex-agent/tools/protocols/prequote/registry.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { summarizeProtocolError } from "../../runtime/errors.js";
import { buildTradePreview, buildVirtualsQuoteSnapshot } from "./trade/binding.js";
import { parseTradeAmount, readTradeParams, type TradeParams } from "./trade/params.js";
import { buyTaxedInFor, priceCurveTrade } from "./trade/pricing.js";
import { QUOTE_TOOL_ID, TRADE_PUBLIC_NAME } from "./trade/tool-ids.js";

/** The AMM tool that trades a graduated agent, per chain. */
const GRADUATED_VENUE: Readonly<Record<number, string>> = {
  8453: "kyberswap__swap_quote / kyberswap__swap_execute",
  4663: "uniswap__swap_quote / uniswap__swap_execute",
};

export async function virtualsTradeQuote(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const read = readTradeParams(p, QUOTE_TOOL_ID);
  if (!read.ok) {
    // A hand-off is an ANSWER, not a failure: the caller asked a reasonable
    // question about a chain Virtuals really runs on, and the useful reply names
    // the tool that does the job.
    if (read.handoff) {
      return ok({
        supported: false,
        chain: read.handoff.chain,
        reason: read.handoff.reason,
        useInstead: read.handoff.useInstead,
      });
    }
    return fail(read.reason);
  }
  const partial = read.params;

  // Address-only wallet resolution - NEVER decrypts a key. A quote answers no
  // wallet at all when none is selected, and says so rather than implying the
  // balance and allowance below were read for somebody.
  let wallet: string;
  try {
    wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch {
    return fail(
      "No EVM wallet is selected for this session, so Vex cannot read the balance or the allowance this trade needs. "
      + "Select a wallet and quote again.",
    );
  }

  const client = getVirtualsCurvePublicClient(partial.deployment);
  let state: Awaited<ReturnType<typeof readCurveState>>;
  try {
    state = await readCurveState({
      client,
      deployment: partial.deployment,
      token: partial.token,
      side: partial.side,
      wallet: getAddress(wallet),
    });
  } catch (err) {
    return fail(`Virtuals curve state unavailable (${summarizeProtocolError(err).message}).`);
  }
  if (!state.ok) {
    if (state.code === "graduated") {
      return ok({
        supported: false,
        chain: partial.deployment.key,
        token: partial.token,
        reason: state.reason,
        useInstead: GRADUATED_VENUE[partial.deployment.chainId] ?? null,
        pool: state.graduatedPair ?? null,
        note:
          "A graduated agent trades on an AMM pool, and the curve tools would revert against it. Price it with the "
          + "AMM venue above, using the agent's token address and the pool named here.",
      });
    }
    return fail(state.reason);
  }

  // The amount is parsed only now: a SELL is denominated in the AGENT TOKEN,
  // whose decimals are the chain fact just read.
  const decimals = partial.side === "buy" ? partial.deployment.virtualDecimals : state.tokenDecimals;
  const parsed = parseTradeAmount(partial, decimals);
  if (!parsed.ok) return fail(parsed.reason);
  const params = parsed.params;

  const quoted = await quoteFor(client, params, state);
  if (quoted === null) {
    return fail(
      `FRouterV3 could not price this ${params.side} on ${params.deployment.name}: getAmountsOut reverted or returned nothing at block `
      + `${state.blockNumber}. Nothing was quoted.`,
    );
  }

  const priced = priceCurveTrade({ params, state, quotedOutRaw: quoted });
  if (!priced.ok) {
    return fail(priced.hint === undefined ? priced.reason : `${priced.reason} ${priced.hint}`);
  }

  const expiresAt = new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString();
  const snapshot = buildVirtualsQuoteSnapshot({ params, state, priced: priced.priced, expiresAt });
  const allowanceLegNeeded = state.allowanceRaw < priced.priced.curveAmountRaw;

  // THE WALLET HALF OF ELIGIBILITY. A quote the wallet cannot pay for is
  // recorded exactly like an unusable route: a superseding row that authorizes
  // nothing, so an older priced quote for the same trade stops being claimable
  // at the same instant. The answer still states the whole preview, because the
  // agent's next move is to fund the wallet, not to re-quote blindly.
  const spendable = state.spendBalanceRaw >= priced.priced.totalInRaw;

  const preview = buildTradePreview({
    params,
    state,
    priced: priced.priced,
    // THE PROPOSAL IDENTITY IS THE SNAPSHOT DIGEST, not the row id: it is known
    // here, it covers every bound field, and the execute can prove the row it
    // claimed is the one this answer described. A row id alone would name a
    // container; the digest names the contents.
    proposalId: snapshot.digest,
    expiresAt,
    allowanceLegNeeded,
  });

  logger.info("virtuals.trade.quote.answered", {
    chainId: params.deployment.chainId,
    side: params.side,
    spendable,
    antiSniperActive: priced.priced.antiSniper.windowActive,
  });

  const answer = ok({
    ...preview,
    executable: spendable,
    ...(spendable
      ? {}
      : {
          notExecutableReason:
            `This wallet holds ${preview.spend && typeof preview.spend === "object" ? (preview.spend as Record<string, unknown>).walletBalance : "less"} `
            + `${priced.priced.spendTokenSymbol} and this trade needs ${priced.priced.totalInRaw.toString()} raw units. `
            + `Fund the wallet and quote again; ${TRADE_PUBLIC_NAME} will refuse this proposal as it stands.`,
        }),
  });

  return {
    ...answer,
    quoteAuthority: {
      eligibilityKind: spendable ? "executable" : "insufficient_balance",
      // NO SNAPSHOT for a quote that authorizes nothing: the recorder writes a
      // superseding non-executable row, and an execute has nothing to claim.
      routeSnapshot: spendable ? { ...snapshot } : null,
    },
  };
}

/**
 * The router's answer for this side, at the quote's own block.
 *
 * A BUY is quoted for `taxedIn` - the committed amount minus Vex's fee minus the
 * curve's own two taxes - because that is what the router actually swaps
 * (`FRouterV3.buy` :225). Quoting the gross would advertise an output the trade
 * cannot deliver, and the floor derived from it would revert on chain.
 */
async function quoteFor(
  client: ReturnType<typeof getVirtualsCurvePublicClient>,
  params: TradeParams,
  state: CurveState,
): Promise<bigint | null> {
  const amountRaw = params.side === "buy" ? buyTaxedInFor(params, state) : params.amountInRaw;
  if (amountRaw <= 0n) return null;
  const quoted = await readCurveQuote({
    client,
    deployment: params.deployment,
    token: state.token,
    side: params.side,
    amountRaw,
    blockNumber: state.blockNumber,
  });
  return quoted === null || quoted <= 0n ? null : quoted;
}
