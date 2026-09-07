/**
 * `virtuals__agent_candles_list` - OHLCV for one Virtuals agent, from whichever
 * source actually has its history.
 *
 * WHY THIS HANDLER EXISTS AS ITS OWN MODULE. The same agent's price history
 * lives in three entirely different places depending on its lifecycle stage and
 * its chain, and picking the wrong one answers a real question with a 404. That
 * selection, and the coverage reporting that keeps a partial history from
 * reading as a complete one, is a responsibility with its own name, so it lives
 * beside the list reads rather than inside them.
 *
 * THE SOURCE MATRIX, EVERY CELL MEASURED (2026-09-04 and 2026-09-05; the table
 * with its evidence is in `src/tools/virtuals/Virtuals.md`):
 *
 *   | stage     | chain     | default source | also available     |
 *   |-----------|-----------|----------------|--------------------|
 *   | graduated | any       | geckoterminal  | -                  |
 *   | bonding   | solana    | geckoterminal  | tape               |
 *   | bonding   | base      | tape           | onchain            |
 *   | bonding   | robinhood | onchain        | -                  |
 *   | bonding   | ethereum  | none           | -                  |
 *
 * WHAT CHANGED, AND THE OWNER INSTRUCTION BEHIND IT. Until now a bonding agent
 * on base or robinhood answered `supported: false` with a 404 from the chart
 * provider, because an FPairV2 bonding curve is not an indexed AMM pool and no
 * OHLCV provider carries one. That is exactly the pre-graduation population a
 * trader cares about, so the two curve sources BUILD the candles instead: from
 * the provider's own trade tape where a tape exists, and from the pair's own
 * `Swap` logs where it does not. Both fold through the same bucketing, so a
 * bar means the same thing whichever source produced it.
 *
 * COVERAGE IS PART OF THE ANSWER, NOT A FOOTNOTE. Each source has a different
 * reason it can stop early - the tape has a hard provider ceiling and no cursor
 * at all, a log scan has a work budget, the chart provider has its own page -
 * so every reply carries a `coverage` block naming what was reached, what
 * stopped it, and the exact cursor that continues. A history that ends because
 * a budget ran out must never look like a history that ends because the curve
 * began.
 */

import {
  readGeckoTerminalCandles,
  GECKOTERMINAL_MAX_LIMIT,
  GECKOTERMINAL_TIMEFRAMES,
  geckoTerminalAggregatesFor,
  type GeckoTerminalAggregate,
  type GeckoTerminalTimeframe,
} from "@tools/virtuals/candles/geckoterminal.js";
import { buildTapeCandles } from "@tools/virtuals/candles/curve-tape.js";
import { buildChainCandles, curveChainConfig } from "@tools/virtuals/candles/curve-chain.js";
import type { CurveCandle } from "@tools/virtuals/candles/bucketing.js";
import type { VirtualsAgent, VirtualsChain } from "@tools/virtuals/types.js";
import type { ProtocolHandler } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { readNumber } from "../../runtime/list-params.js";
import { virtualsChainSlug, resolveVirtualsChain } from "../chain-param.js";
import { readOptionalEnum } from "../list-params.js";
import { failureDetail, loadAgent } from "./_shared.js";

/** Which history to read. `auto` picks by the matrix in the header. */
export const VIRTUALS_CANDLE_SOURCES = ["auto", "geckoterminal", "tape", "onchain"] as const;
type CandleSource = (typeof VIRTUALS_CANDLE_SOURCES)[number];

/** Default candles when the caller does not say. */
const DEFAULT_LIMIT = 100;

/** The stage that decides which pool, and which sources exist for it. */
interface Subject {
  readonly graduated: boolean;
  readonly chain: VirtualsChain;
  /** `lpAddress` once graduated, `preTokenPair` while bonding. */
  readonly poolAddress: string | null;
  /** The bonding token, which keys the tape and orients the pair. */
  readonly tokenAddress: string | null;
}

function subjectOf(agent: VirtualsAgent, chain: VirtualsChain): Subject {
  const graduated = agent.status === "AVAILABLE" && agent.lpAddress !== null;
  return {
    graduated,
    chain,
    poolAddress: graduated ? agent.lpAddress : agent.preTokenPair,
    tokenAddress: agent.preToken ?? agent.tokenAddress,
  };
}

/**
 * The source `auto` resolves to, or null when this agent has no history
 * anywhere. Every branch is a measured cell of the matrix in the header.
 */
function autoSource(subject: Subject): Exclude<CandleSource, "auto"> | null {
  if (subject.graduated) return subject.poolAddress === null ? null : "geckoterminal";
  // Solana's curve IS an indexed Meteora dynamic-bonding-curve pool, so the
  // chart provider answers there and gives a usd-denominated series; the two
  // EVM chains have no indexed curve and must be built.
  if (subject.chain === "SOLANA") return subject.poolAddress === null ? null : "geckoterminal";
  if (subject.chain === "BASE") return subject.tokenAddress === null ? null : "tape";
  if (subject.chain === "ROBINHOOD") {
    return subject.poolAddress === null || subject.tokenAddress === null ? null : "onchain";
  }
  return null;
}

/** Why an explicitly requested source cannot serve this agent, by name. */
function refuseSource(source: Exclude<CandleSource, "auto">, subject: Subject): string | null {
  if (source === "geckoterminal") {
    if (subject.poolAddress === null) {
      return "This agent has no pool address yet (neither a graduated lpAddress nor a bonding "
        + "preTokenPair), so there is nothing for the chart provider to index.";
    }
    if (!subject.graduated && subject.chain !== "SOLANA") {
      return `The chart provider does not index an EVM bonding-curve pair, and this agent is still `
        + `on its curve on ${virtualsChainSlug(subject.chain)}. A live base curve pair answered 404. `
        + "Ask for source onchain to read the pair's own swap logs, or source tape on base.";
    }
    return null;
  }
  if (source === "tape") {
    if (subject.graduated) {
      return "The provider's trade feed covers the bonding curve only and returns an empty tape for "
        + "every graduated agent measured, so it cannot chart this one. Leave source at auto to read "
        + "the graduated pool instead.";
    }
    if (subject.tokenAddress === null) {
      return "This agent has no bonding token address, so there is no key for the trade feed.";
    }
    if (subject.chain !== "BASE" && subject.chain !== "SOLANA") {
      return `The provider's trade feed has no chain id for ${virtualsChainSlug(subject.chain)}: its `
        + "own SDK numbers base and solana and nothing else, and a live robinhood bonding agent "
        + "returned an empty tape while its pair carried real swaps. Ask for source onchain there.";
    }
    return null;
  }
  if (subject.graduated) {
    return "Swap logs of an FPairV2 curve pair only exist while the agent is bonding; this agent has "
      + "graduated and now trades in an AMM pool. Leave source at auto to read that pool.";
  }
  if (curveChainConfig(subject.chain) === undefined) {
    return `Virtuals runs its EVM bonding curve on base and robinhood only, so there are no curve `
      + `swap logs to read on ${virtualsChainSlug(subject.chain)}.`;
  }
  if (subject.poolAddress === null || subject.tokenAddress === null) {
    return "This agent has no curve pair address yet, so there are no swap logs to read.";
  }
  return null;
}

/** The cursor that continues backwards, and the truncation story around it. */
function continuation(
  candles: readonly CurveCandle[] | readonly { timestampSeconds: number }[],
  truncated: boolean,
): Record<string, unknown> {
  const oldest = candles.length === 0 ? null : candles[0]!.timestampSeconds;
  if (oldest === null) return { hasMore: false, truncated };
  return {
    oldestTimestampSeconds: oldest,
    hasMore: truncated,
    truncated,
    nextBeforeTimestampSeconds: oldest,
    olderHistoryNote:
      `Older buckets are reachable: call again with beforeTimestampSeconds = ${oldest} and the same `
      + "timeframe, aggregate and source. Nothing between the pages is skipped: that value is the "
      + "start of the oldest bucket returned here, and the next page ends strictly before it.",
  };
}

export const virtualsCandlesHandler: ProtocolHandler = async (p) => {
  const timeframeRead = readOptionalEnum<GeckoTerminalTimeframe>(p, "timeframe", GECKOTERMINAL_TIMEFRAMES);
  if (!timeframeRead.ok) return fail(timeframeRead.reason);
  const aggregateRead = readNumber(p, "aggregate", {
    // 15 is the largest legal aggregate on ANY timeframe (minute 1/5/15). A
    // bound of 12 here refused `minute` + 15 before the per-timeframe check
    // could accept it, which a live run caught.
    aggregate: { domain: "nonNegative", integer: true, min: 1, max: 15 },
  });
  if (!aggregateRead.ok) return fail(aggregateRead.reason);
  const timeframe = timeframeRead.value ?? "hour";
  const aggregate = (aggregateRead.value ?? 1) as GeckoTerminalAggregate;
  // `aggregate` is legal PER TIMEFRAME, so the check needs both: a global set
  // would accept `day` + 4, which the chart provider answers with a 400. The
  // curve sources accept the same sets deliberately, so one parameter contract
  // holds whichever source answers.
  const legalAggregates = geckoTerminalAggregatesFor(timeframe);
  if (!legalAggregates.includes(aggregate)) {
    return fail(
      `aggregate ${aggregate} is not legal for timeframe "${timeframe}". The provider allows `
      + `${legalAggregates.join(", ")} there (its own words on a rejection: "Invalid aggregate. `
      + `Allowed values: ${legalAggregates.join(", ")}"). The legal sets differ per timeframe: `
      + "minute 1, 5, 15; hour 1, 4, 12; day 1.",
    );
  }
  const limitRead = readNumber(p, "limit", {
    limit: { domain: "nonNegative", integer: true, min: 1, max: GECKOTERMINAL_MAX_LIMIT },
  });
  if (!limitRead.ok) return fail(limitRead.reason);
  const beforeRead = readNumber(p, "beforeTimestampSeconds", {
    beforeTimestampSeconds: { domain: "nonNegative", integer: true, min: 1 },
  });
  if (!beforeRead.ok) return fail(beforeRead.reason);
  const currencyRead = readOptionalEnum(p, "currency", ["usd", "token"] as const);
  if (!currencyRead.ok) return fail(currencyRead.reason);
  const sourceRead = readOptionalEnum<CandleSource>(p, "source", VIRTUALS_CANDLE_SOURCES);
  if (!sourceRead.ok) return fail(sourceRead.reason);
  const limit = limitRead.value ?? DEFAULT_LIMIT;
  const requestedSource = sourceRead.value ?? "auto";
  const before = beforeRead.value;

  try {
    const loaded = await loadAgent(p);
    if (!loaded.ok) return fail(loaded.reason);
    const { agent, id } = loaded;
    const chain = resolveVirtualsChain(agent.chain ?? "");
    if (chain === null) {
      return fail(`Virtuals agent ${id} reports chain "${agent.chain}", which is not a chain this tool knows.`);
    }
    const subject = subjectOf(agent, chain);
    const chainSlug = virtualsChainSlug(chain);
    const market = subject.graduated ? "dex" : "curve";
    const head = {
      agentId: agent.id,
      symbol: agent.symbol,
      chain: chainSlug,
      market,
      timeframe,
      aggregate,
      limit,
      requestedSource,
    };

    const resolved = requestedSource === "auto" ? autoSource(subject) : requestedSource;
    if (resolved === null) {
      return ok({
        ...head,
        supported: false,
        candles: [],
        reason:
          `Virtuals agent ${id} has no price history anywhere this tool can reach on ${chainSlug}. `
          + "A graduated agent charts from its AMM pool, a bonding agent from its curve; this one has "
          + "neither a pool address nor a bonding token, or sits on a chain where Virtuals runs no "
          + "curve of its own. This is a statement about the sources, not a claim that the agent has "
          + "never traded.",
      });
    }
    if (requestedSource !== "auto") {
      const refusal = refuseSource(resolved, subject);
      if (refusal !== null) {
        return ok({ ...head, supported: false, candles: [], reason: refusal });
      }
    }

    // The two curve sources price in VIRTUAL, exactly, from the pair's own two
    // token amounts. There is no per-bucket VIRTUAL/USD rate on that path, so a
    // usd request is refused by name rather than answered in a different unit
    // than the caller asked for.
    if (currencyRead.value !== null && currencyRead.value !== undefined && resolved !== "geckoterminal") {
      return fail(
        `currency "${currencyRead.value}" applies only to the chart provider, which denominates a `
        + `series in usd or in the pool's quote token. The ${resolved} source builds bars from the `
        + "curve pair's own two token amounts, so its price is VIRTUAL per agent token and nothing "
        + "else; there is no per-bucket VIRTUAL/usd rate on that path to convert with. Drop currency, "
        + "or ask for a graduated agent's pool.",
      );
    }

    if (resolved === "geckoterminal") {
      const currency = currencyRead.value ?? "usd";
      const result = await readGeckoTerminalCandles({
        chain,
        poolAddress: subject.poolAddress!,
        timeframe,
        aggregate,
        limit,
        ...(before === null || before === undefined ? {} : { beforeTimestampSeconds: before }),
        currency,
      });
      if (!result.found) {
        return ok({
          ...head,
          source: "geckoterminal",
          poolAddress: subject.poolAddress,
          supported: false,
          reason: result.reason,
          candles: [],
        });
      }
      return ok({
        ...head,
        source: "geckoterminal",
        network: result.network,
        poolAddress: result.poolAddress,
        currency,
        denomination: currency === "usd" ? "usd" : "pool quote token",
        count: result.candles.length,
        ...continuation(result.candles, result.candles.length >= limit),
        note: "Open/high/low/close and volume are decimal strings from the chart provider, oldest "
          + "bucket first. They are display-grade market data, never a quote: price a trade with the "
          + "venue tool that would execute it.",
        candles: result.candles,
      });
    }

    if (resolved === "tape") {
      const built = await buildTapeCandles({
        chain,
        tokenAddress: subject.tokenAddress!,
        timeframe,
        aggregate,
        limit,
        ...(before === null || before === undefined ? {} : { beforeTimestampSeconds: before }),
      });
      if (!built.available) {
        return ok({ ...head, source: "virtuals_tape", supported: false, reason: built.reason, candles: [] });
      }
      return ok({
        ...head,
        source: "virtuals_tape",
        tokenAddress: subject.tokenAddress,
        vpApiChainId: built.vpApiChainId,
        denomination: "VIRTUAL per agent token",
        count: built.candles.length,
        coverage: built.coverage,
        ...continuation(built.candles, built.coverage.truncated),
        note: "Bars built here from the provider's own bonding-curve trade feed, oldest bucket first, "
          + "priced in VIRTUAL per agent token. The feed's amounts arrive already rounded at the "
          + "sixteenth significant digit because the provider computes them in floating point; ask "
          + "for source onchain when exactness matters. Buckets with no trades are absent, never "
          + "zero-filled. Display-grade market data, never a quote.",
        candles: built.candles,
      });
    }

    const built = await buildChainCandles({
      chain,
      pairAddress: subject.poolAddress!,
      agentTokenAddress: subject.tokenAddress!,
      timeframe,
      aggregate,
      limit,
      ...(before === null || before === undefined ? {} : { beforeTimestampSeconds: before }),
    });
    if (!built.available) {
      return ok({ ...head, source: "curve_swap_logs", supported: false, reason: built.reason, candles: [] });
    }
    return ok({
      ...head,
      source: "curve_swap_logs",
      poolAddress: subject.poolAddress,
      tokenAddress: subject.tokenAddress,
      denomination: "VIRTUAL per agent token",
      count: built.candles.length,
      coverage: built.coverage,
      ...continuation(built.candles, built.coverage.truncated),
      note: "Bars built here from the curve pair's own Swap logs, oldest bucket first, priced in "
        + "VIRTUAL per agent token as the exact ratio of the two token amounts each swap moved. This "
        + "is the most precise source and the only one that exists for a bonding agent on robinhood. "
        + "Buckets with no trades are absent, never zero-filled. Display-grade market data, never a "
        + "quote.",
      candles: built.candles,
    });
  } catch (err) {
    return fail(`Virtuals candles unavailable (${failureDetail("virtuals__agent_candles_list", err)})`);
  }
};
