/**
 * Virtuals Protocol handlers.
 *
 * The READ handlers below are direct TS client calls with no wallet and no
 * signing. The two TRADE handlers registered at the top of the map are the
 * namespace's money path and live in `./handlers/trade-*.ts`.
 *
 * No wallet, no signing, no mutations: these tools surface agent-token
 * intelligence (screen / detail / graduations / genesis calendar / curve tape /
 * candles) that the model uses to decide, then executes trades through the
 * venue tool named by each row's `tradingRoute` hint.
 *
 * WHAT CHANGED IN PR-C1, AND WHY THE SHAPE OF THESE HANDLERS CHANGED WITH IT.
 * The list reads used to filter CLIENT-SIDE over a bounded five-page scan,
 * because `filters[status]` was believed to be ignored server-side. It is not:
 * the STRING form is ignored, and the BARE NUMERIC form filters exactly
 * (`filters[status]=1` -> 55,764 UNDERGRAD rows of 56,915 on BASE). With the
 * numeric form plus the twenty-odd other measured filters, every screen the
 * tools expose now runs INSIDE the provider, so:
 *
 *   - there is no window scan, no `windowNote` and no five-page budget;
 *   - `totalMatched` is the provider's count of rows matching the FILTER, not
 *     the chain population, so an empty answer is a real statement about the
 *     screen rather than about a slice of it;
 *   - one page is one answer, and `hasMore`/`nextPage` walk the rest.
 *
 * The Virtuals API is undocumented, so every handler degrades cleanly on error
 * (returns a readable failure) rather than throwing through the namespace.
 */

import { getVirtualsClient } from "@tools/virtuals/client.js";
import { readVpApiTrades, VP_API_MAX_LIMIT } from "@tools/virtuals/trades/vp-api.js";
import {
  readGeckoTerminalCandles,
  GECKOTERMINAL_AGGREGATES,
  GECKOTERMINAL_MAX_LIMIT,
  GECKOTERMINAL_TIMEFRAMES,
  geckoTerminalAggregatesFor,
  type GeckoTerminalAggregate,
  type GeckoTerminalTimeframe,
} from "@tools/virtuals/candles/geckoterminal.js";
import type {
  VirtualsAgent,
  VirtualsGenesisSortField,
  VirtualsGenesisStatus,
  VirtualsPagination,
} from "@tools/virtuals/types.js";
import {
  VIRTUALS_GENESIS_SORT_FIELDS,
  VIRTUALS_GENESIS_STATUSES,
  VIRTUALS_SORT_DIRECTIONS,
} from "@tools/virtuals/types.js";
import { VexError } from "../../../../errors.js";
import logger from "@utils/logger.js";
import { describeFailureForAgent, describeFailureForLog } from "../runtime/errors.js";
import type { ProtocolHandler } from "../types.js";
import { num, ok, fail } from "../handler-helpers.js";
import { readNumber } from "../runtime/list-params.js";
import { virtualsChainSlug, resolveVirtualsChain } from "./chain-param.js";
import {
  MAX_PAGE_SIZE,
  VIRTUALS_LIST_NUMERIC_PARAMS,
  readChain,
  readOptionalEnum,
  readVirtualsListParams,
  readVirtualsWindow,
} from "./list-params.js";
import {
  projectGenesis,
  projectVirtualsDetail,
  projectVirtualsList,
} from "./projectors.js";
import { virtualsTradeQuote } from "./handlers/trade-quote.js";
import { virtualsTradeExecute } from "./handlers/trade-execute.js";

/** The three provider numbers a `hasMore` claim needs to mean anything. */
const PAGE_METADATA_KEYS = ["total", "page", "pageSize"] as const;

/**
 * The continuation block, derived from the PROVIDER's own pagination and
 * nothing else.
 *
 * `VirtualsPagination` lets each field be null INDEPENDENTLY, so a present
 * block is not sufficient evidence: `total`, `page` and `pageSize` must EACH be
 * finite before the comparison means anything. When one is missing the reply
 * OMITS `hasMore` and `nextPage` and says which number was absent instead.
 * Claiming "that was the last page" from metadata the provider never sent is
 * the one thing this must never do.
 */
function continuation(
  pagination: VirtualsPagination | null,
  subject: string,
): Record<string, unknown> {
  const missing = PAGE_METADATA_KEYS.filter((key) => {
    const value = pagination?.[key];
    return typeof value !== "number" || !Number.isFinite(value);
  });
  if (missing.length > 0 || pagination === null) {
    return {
      truncated: false,
      continuationNote:
        `The provider returned no ${missing.map((key) => `\`${key}\``).join(" and no ")} for this page, `
        + `so whether more ${subject} exist beyond it is UNKNOWN - this is NOT a statement that the `
        + "list ended here. Request the next `page` to find out: an empty reply is the end.",
    };
  }
  const hasMore = pagination.page! * pagination.pageSize! < pagination.total!;
  return {
    totalMatched: pagination.total,
    pageCount: pagination.pageCount,
    hasMore,
    // `truncated` and `hasMore` are the same fact under the two names the
    // output envelope uses; both are stated so neither reader has to infer it.
    truncated: hasMore,
    ...(hasMore
      ? {
          nextPage: pagination.page! + 1,
          truncationNote:
            `This page holds ${pagination.pageSize} of ${pagination.total} matching ${subject}. `
            + `Nothing was dropped silently: call again with page ${pagination.page! + 1} and the same `
            + "filters for the next page, or narrow the filters to make the whole answer fit.",
        }
      : {}),
  };
}

/**
 * Model-facing failure detail - the REAL cause, scrubbed and BOUNDED.
 *
 * Owner decree (2026-08-02, rules/04): a tool error surfaced to the agent
 * carries the ACTUAL cause, never a bare "unexpected error". The canonical
 * summarizer removes secrets, HTML and JSON bodies, URLs, auth headers and long
 * hex blobs, and hard-caps the result. It does NOT neutralise instruction-shaped
 * prose - the mitigation for THAT is the Safety Contract, which teaches the
 * model that tool output is data, never instruction.
 */
function failureDetail(toolId: string, err: unknown): string {
  logger.warn("virtuals.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  return describeFailureForAgent(err);
}

/** Resolve one agent by id, or return the refusal sentence for the caller. */
async function loadAgent(
  params: Record<string, unknown>,
): Promise<{ ok: true; agent: VirtualsAgent; id: string } | { ok: false; reason: string }> {
  const idNumber = num(params, "id");
  if (idNumber === undefined) {
    return {
      ok: false,
      reason: "Missing required: id (the numeric Virtuals agent id virtuals__agents_discover returns).",
    };
  }
  const id = String(idNumber);
  const agent = await getVirtualsClient().getVirtual({ id });
  if (!agent) return { ok: false, reason: `No Virtuals agent found for id ${id}.` };
  return { ok: true, agent, id };
}

// ── Handler map ─────────────────────────────────────────────────────

export const VIRTUALS_HANDLERS: Record<string, ProtocolHandler> = {
  // The two MUTATING members of the namespace (PR-C2). They own their own
  // modules under `./handlers/` because a money path with a prequote binding, a
  // staged broadcast and a fee leg has nothing structurally in common with the
  // read handlers below.
  "virtuals.trade.quote": virtualsTradeQuote,
  "virtuals.trade.execute": virtualsTradeExecute,
  "virtuals.list": async (p) => {
    const read = readVirtualsListParams(p);
    if (!read.ok) return fail(read.reason);
    const {
      chain, statusFilter, sortKeyword, sort, sortDirection,
      pageSize, page, filters, includePriceSeries, applied,
    } = read.value;
    const chainSlug = virtualsChainSlug(chain);

    try {
      const result = await getVirtualsClient().listVirtuals({
        chain,
        filters: {
          ...filters,
          // `recentGraduation` is a population as well as an order: sorting by
          // graduation time over rows that never graduated puts nulls first and
          // answers a different question than the one that was asked.
          ...(sortKeyword === "recentGraduation" && filters.hasGraduated === undefined
            ? { hasGraduated: true }
            : {}),
        },
        sort,
        sortDirection,
        page,
        pageSize,
        sparkline: includePriceSeries,
        range24h: includePriceSeries,
      });
      const projected = projectVirtualsList(result.agents);
      return ok({
        // Echoed as the canonical slug the manifest advertises, not the
        // provider's UPPERCASE value - the reply must spell the chain the way
        // the next call has to spell it.
        chain: chainSlug,
        status: statusFilter,
        sortBy: sortKeyword,
        sortDirection,
        page,
        pageSize,
        count: projected.length,
        ...continuation(result.pagination ?? null, "agents"),
        filtersApplied: applied,
        agents: projected,
      });
    } catch (err) {
      return fail(`Virtuals list unavailable (${failureDetail("virtuals__agents_discover", err)})`);
    }
  },

  "virtuals.get": async (p) => {
    try {
      const loaded = await loadAgent(p);
      if (!loaded.ok) return fail(loaded.reason);
      return ok({ agent: projectVirtualsDetail(loaded.agent) });
    } catch (err) {
      return fail(`Virtuals detail unavailable (${failureDetail("virtuals__agent_get", err)})`);
    }
  },

  "virtuals.graduations": async (p) => {
    const chainRead = readChain(p);
    if (!chainRead.ok) return fail(chainRead.reason);
    const windowRead = readVirtualsWindow(p);
    if (!windowRead.ok) return fail(windowRead.reason);
    const chain = chainRead.value;
    const chainSlug = virtualsChainSlug(chain);
    const { pageSize, page } = windowRead.value;

    try {
      // Server-side now: `lpCreatedAt IS NOT NULL` is the provider's own
      // definition of graduated (952 rows on BASE against 956 with status 2),
      // and sorting on it descending is the "what just graduated" order.
      const result = await getVirtualsClient().listVirtuals({
        chain,
        filters: { hasGraduated: true, status: "graduated" },
        sort: "lpCreatedAt",
        sortDirection: "desc",
        page,
        pageSize,
      });
      const projected = projectVirtualsList(result.agents);
      return ok({
        chain: chainSlug,
        page,
        pageSize,
        count: projected.length,
        ...continuation(result.pagination ?? null, "graduations"),
        filtersApplied: { chain: chainSlug, status: "graduated", sortBy: "lpCreatedAt", sortDirection: "desc" },
        agents: projected,
      });
    } catch (err) {
      return fail(`Virtuals graduations unavailable (${failureDetail("virtuals__graduations_list", err)})`);
    }
  },

  "virtuals.geneses": async (p) => {
    const windowRead = readVirtualsWindow(p);
    if (!windowRead.ok) return fail(windowRead.reason);
    const statusRead = readOptionalEnum<VirtualsGenesisStatus>(p, "status", VIRTUALS_GENESIS_STATUSES);
    if (!statusRead.ok) return fail(statusRead.reason);
    const sortRead = readOptionalEnum<VirtualsGenesisSortField>(p, "sortBy", VIRTUALS_GENESIS_SORT_FIELDS);
    if (!sortRead.ok) return fail(sortRead.reason);
    const directionRead = readOptionalEnum(p, "sortDirection", VIRTUALS_SORT_DIRECTIONS);
    if (!directionRead.ok) return fail(directionRead.reason);
    const { pageSize, page } = windowRead.value;

    let chain: ReturnType<typeof resolveVirtualsChain> = null;
    if (p.chain !== undefined && p.chain !== null && p.chain !== "") {
      const chainRead = readChain(p);
      if (!chainRead.ok) return fail(chainRead.reason);
      chain = chainRead.value;
    }

    try {
      const client = getVirtualsClient();
      const [result, parameters] = await Promise.all([
        client.listGeneses({
          page,
          pageSize,
          ...(statusRead.value !== undefined ? { status: statusRead.value } : {}),
          ...(chain !== null ? { chain } : {}),
          sort: sortRead.value ?? "id",
          sortDirection: directionRead.value ?? "desc",
        }),
        // The reserve tiers a genesis can target. One extra cached call, and
        // without it the participation numbers on a row have no scale to sit
        // against.
        client.getGenesisParameters().catch(() => ({ reserveAmountTiers: [] as number[] })),
      ]);
      const applied: Record<string, unknown> = {
        sortBy: sortRead.value ?? "id",
        sortDirection: directionRead.value ?? "desc",
      };
      if (statusRead.value !== undefined) applied.status = statusRead.value;
      if (chain !== null) applied.chain = virtualsChainSlug(chain);
      return ok({
        page,
        pageSize,
        count: result.geneses.length,
        ...continuation(result.pagination ?? null, "genesis events"),
        reserveAmountTiers: parameters.reserveAmountTiers,
        reserveTiersNote: parameters.reserveAmountTiers.length === 0
          ? "The provider did not state the reserve tiers on this call."
          : "The VIRTUAL reserve targets a genesis sale can be configured for, from the provider's own "
            + "/api/geneses/parameters.",
        filtersApplied: applied,
        geneses: result.geneses.map(projectGenesis),
      });
    } catch (err) {
      return fail(`Virtuals geneses unavailable (${failureDetail("virtuals__genesis_launches_list", err)})`);
    }
  },

  "virtuals.trades": async (p) => {
    const limitRead = readNumber(p, "limit", {
      limit: { domain: "nonNegative", integer: true, min: 1, max: VP_API_MAX_LIMIT },
    });
    if (!limitRead.ok) return fail(limitRead.reason);
    const sideRead = readOptionalEnum(p, "side", ["both", "buys", "sells"] as const);
    if (!sideRead.ok) return fail(sideRead.reason);
    const limit = limitRead.value ?? 30;

    try {
      const loaded = await loadAgent(p);
      if (!loaded.ok) return fail(loaded.reason);
      const { agent, id } = loaded;
      const chain = resolveVirtualsChain(agent.chain ?? "");
      if (chain === null) {
        return fail(`Virtuals agent ${id} reports chain "${agent.chain}", which is not a chain this tool knows.`);
      }
      // The tape is keyed by the BONDING token: `preToken` while on the curve
      // (where `tokenAddress` is null), the same address in both columns after.
      const tokenAddress = agent.preToken ?? agent.tokenAddress;
      if (tokenAddress === null) {
        return fail(`Virtuals agent ${id} has neither a preToken nor a tokenAddress, so it has no trade tape yet.`);
      }
      const graduated = agent.status === "AVAILABLE" && agent.lpAddress !== null;
      const result = await readVpApiTrades({ chain, tokenAddress, limit, side: sideRead.value ?? "both" });
      if (!result.supported) {
        return ok({
          agentId: agent.id,
          chain: virtualsChainSlug(chain),
          supported: false,
          reason: result.reason,
          trades: [],
        });
      }
      return ok({
        agentId: agent.id,
        symbol: agent.symbol,
        chain: virtualsChainSlug(chain),
        market: "curve",
        tokenAddress,
        vpApiChainId: result.chainId,
        side: sideRead.value ?? "both",
        limit,
        count: result.trades.length,
        graduated,
        // A graduated agent's empty tape is a MEASURED property of this feed,
        // not an absence of trading, and saying so is the difference between a
        // useful answer and a misleading one.
        note: graduated
          ? "This agent has GRADUATED. The Virtuals curve tape only covers bonding-curve trades and "
            + "returns an empty list for every graduated agent measured, so an empty result here says "
            + "nothing about current trading - read the AMM pool with virtuals__agent_candles_list or "
            + "the DexScreener tools instead."
          : "Bonding-curve trades, newest first, straight from the provider's own tape. Amounts are "
            + "whole-token decimal strings (not wei) and price is VIRTUAL per agent token.",
        trades: result.trades,
      });
    } catch (err) {
      return fail(`Virtuals trades unavailable (${failureDetail("virtuals__agent_trades_list", err)})`);
    }
  },

  "virtuals.candles": async (p) => {
    const timeframeRead = readOptionalEnum<GeckoTerminalTimeframe>(p, "timeframe", GECKOTERMINAL_TIMEFRAMES);
    if (!timeframeRead.ok) return fail(timeframeRead.reason);
    const aggregateRead = readNumber(p, "aggregate", {
      aggregate: { domain: "nonNegative", integer: true, min: 1, max: 12 },
    });
    if (!aggregateRead.ok) return fail(aggregateRead.reason);
    const timeframe = timeframeRead.value ?? "hour";
    const aggregate = (aggregateRead.value ?? 1) as GeckoTerminalAggregate;
    // `aggregate` is legal PER TIMEFRAME, so the check needs both: a global
    // set would accept `day` + 4, which the provider answers with a 400.
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
    const limit = limitRead.value ?? 100;

    try {
      const loaded = await loadAgent(p);
      if (!loaded.ok) return fail(loaded.reason);
      const { agent, id } = loaded;
      const chain = resolveVirtualsChain(agent.chain ?? "");
      if (chain === null) {
        return fail(`Virtuals agent ${id} reports chain "${agent.chain}", which is not a chain this tool knows.`);
      }
      const graduated = agent.status === "AVAILABLE" && agent.lpAddress !== null;
      // Graduated agents chart from their AMM pool; a bonding agent has only
      // its curve pair, which GeckoTerminal indexes on Solana (Meteora DBC)
      // and does not index on an EVM chain.
      const poolAddress = graduated ? agent.lpAddress : agent.preTokenPair;
      if (poolAddress === null) {
        return ok({
          agentId: agent.id,
          chain: virtualsChainSlug(chain),
          supported: false,
          reason: `Virtuals agent ${id} has no pool address yet (neither lpAddress nor preTokenPair), so `
            + "there is nothing for a candle provider to index.",
          candles: [],
        });
      }

      const result = await readGeckoTerminalCandles({
        chain,
        poolAddress,
        timeframe,
        aggregate,
        limit,
        ...(beforeRead.value !== null ? { beforeTimestampSeconds: beforeRead.value } : {}),
        currency: currencyRead.value ?? "usd",
      });
      if (!result.found) {
        return ok({
          agentId: agent.id,
          chain: virtualsChainSlug(chain),
          market: graduated ? "dex" : "curve",
          poolAddress,
          supported: false,
          reason: result.reason,
          candles: [],
        });
      }
      return ok({
        agentId: agent.id,
        symbol: agent.symbol,
        chain: virtualsChainSlug(chain),
        market: graduated ? "dex" : "curve",
        source: "geckoterminal",
        network: result.network,
        poolAddress: result.poolAddress,
        timeframe,
        aggregate,
        currency: currencyRead.value ?? "usd",
        limit,
        count: result.candles.length,
        // Walking further back is a provider capability, so the reply names the
        // exact parameter that does it rather than leaving the history looking
        // like all there is.
        ...(result.candles.length > 0
          ? {
              oldestTimestampSeconds: result.candles[0]!.timestampSeconds,
              olderHistoryNote:
                `Older buckets are reachable: call again with beforeTimestampSeconds = `
                + `${result.candles[0]!.timestampSeconds} and the same timeframe and aggregate.`,
            }
          : {}),
        note: "Open/high/low/close and volume are decimal strings from GeckoTerminal, oldest bucket "
          + "first. They are display-grade market data, never a quote: price a trade with the venue "
          + "tool that would execute it.",
        candles: result.candles,
      });
    } catch (err) {
      return fail(`Virtuals candles unavailable (${failureDetail("virtuals__agent_candles_list", err)})`);
    }
  },
};

/** Re-exported so the manifest and the tests read the bound from one place. */
export { MAX_PAGE_SIZE, VIRTUALS_LIST_NUMERIC_PARAMS };
