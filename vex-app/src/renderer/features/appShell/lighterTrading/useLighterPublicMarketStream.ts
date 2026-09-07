import { useEffect, useMemo, useState } from "react";
import type {
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingMarketType,
  LighterTradingPublicStatsEvent,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";

type PublicBook = {
  readonly asks: ReadonlyArray<{ readonly price: string; readonly size: string }>;
  readonly bids: ReadonlyArray<{ readonly price: string; readonly size: string }>;
};

export interface LighterPublicMarketStreamState {
  readonly status: LighterTradingCandleConnectionStatus;
  readonly bookStatus: LighterTradingCandleConnectionStatus;
  readonly tradesStatus: LighterTradingCandleConnectionStatus;
  readonly statsStatus: LighterTradingCandleConnectionStatus;
  readonly book: PublicBook | null;
  readonly trades: LighterTradingSnapshot["trades"];
  readonly stats: LighterTradingPublicStatsEvent["stats"] | null;
  readonly bookReceivedAt: number | null;
  readonly tradesReceivedAt: number | null;
  readonly statsReceivedAt: number | null;
}

interface InternalState extends LighterPublicMarketStreamState {
  readonly identity: string;
  readonly bookNonce: string | null;
  readonly tradesNonce: string | null;
  readonly statsProviderTimestamp: number;
}

function compareDecimalIds(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}

export function mergePublicTrades(
  existing: LighterTradingSnapshot["trades"],
  incoming: LighterTradingSnapshot["trades"],
): LighterTradingSnapshot["trades"] {
  const byId = new Map(existing.map((trade) => [trade.tradeId, trade]));
  for (const trade of incoming) byId.set(trade.tradeId, trade);
  return [...byId.values()]
    .sort((left, right) => (
      right.timestamp - left.timestamp
      || compareDecimalIds(right.tradeId, left.tradeId)
    ))
    .slice(0, 40);
}

export function useLighterPublicMarketStream({
  enabled,
  environment,
  marketId,
  marketType,
  restSnapshot,
}: {
  readonly enabled: boolean;
  readonly environment: LighterTradingEnvironment;
  readonly marketId: number | null;
  readonly marketType: LighterTradingMarketType | null;
  readonly restSnapshot: LighterTradingSnapshot | null;
}): LighterPublicMarketStreamState {
  const identity = `${environment}:${marketType ?? "none"}:${marketId ?? "none"}`;
  const [state, setState] = useState<InternalState>(() => ({
    identity,
    status: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
    bookStatus: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
    tradesStatus: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
    statsStatus: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
    book: null,
    trades: restSnapshot?.trades ?? [],
    stats: null,
    bookReceivedAt: null,
    tradesReceivedAt: null,
    statsReceivedAt: null,
    bookNonce: null,
    tradesNonce: null,
    statsProviderTimestamp: 0,
  }));

  useEffect(() => {
    setState((previous) => {
      if (previous.identity !== identity) {
        return {
          identity,
          status: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
          bookStatus: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
          tradesStatus: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
          statsStatus: enabled && marketId !== null && marketType !== null ? "connecting" : "stopped",
          book: null,
          trades: restSnapshot?.trades ?? [],
          stats: null,
          bookReceivedAt: null,
          tradesReceivedAt: null,
          statsReceivedAt: null,
          bookNonce: null,
          tradesNonce: null,
          statsProviderTimestamp: 0,
        };
      }
      if (restSnapshot === null) return previous;
      return {
        ...previous,
        trades: mergePublicTrades(restSnapshot.trades, previous.trades),
      };
    });
  }, [enabled, identity, marketId, marketType, restSnapshot]);

  useEffect(() => {
    if (!enabled || marketId === null || marketType === null) return undefined;
    const subscriptionId = crypto.randomUUID();
    let active = true;
    const matches = (event: {
      readonly subscriptionId: string;
      readonly environment: LighterTradingEnvironment;
      readonly marketId: number;
      readonly marketType: LighterTradingMarketType;
    }): boolean => event.subscriptionId === subscriptionId
      && event.environment === environment
      && event.marketId === marketId
      && event.marketType === marketType;

    const offBook = window.vex.lighterTrading.onPublicBook((event) => {
      if (!active || !matches(event)) return;
      setState((previous) => (
        previous.identity !== identity
        || (previous.bookNonce !== null
          && compareDecimalIds(event.nonce, previous.bookNonce) <= 0)
      ) ? previous : ({
          ...previous,
          book: event.book,
          bookNonce: event.nonce,
          bookReceivedAt: event.receivedAt,
          bookStatus: "live",
        }));
    });
    const offTrades = window.vex.lighterTrading.onPublicTrades((event) => {
      if (!active || !matches(event)) return;
      setState((previous) => (
        previous.identity !== identity
        || (previous.tradesNonce !== null
          && compareDecimalIds(event.nonce, previous.tradesNonce) <= 0)
      ) ? previous : ({
          ...previous,
          trades: mergePublicTrades(previous.trades, event.trades),
          tradesNonce: event.nonce,
          tradesReceivedAt: event.receivedAt,
          tradesStatus: "live",
        }));
    });
    const offStats = window.vex.lighterTrading.onPublicStats((event) => {
      if (!active || !matches(event)) return;
      setState((previous) => (
        previous.identity !== identity
        || event.providerTimestamp <= previous.statsProviderTimestamp
      ) ? previous : ({
          ...previous,
          stats: event.stats,
          statsProviderTimestamp: event.providerTimestamp,
          statsReceivedAt: event.receivedAt,
          statsStatus: "live",
        }));
    });
    const offStatus = window.vex.lighterTrading.onPublicMarketStatus((event) => {
      if (!active || !matches(event)) return;
      setState((previous) => previous.identity !== identity ? previous : ({
        ...previous,
        status: event.status,
        bookStatus: event.bookStatus,
        tradesStatus: event.tradesStatus,
        statsStatus: event.statsStatus,
      }));
    });

    setState((previous) => previous.identity !== identity ? previous : ({
      ...previous,
      status: "connecting",
      bookStatus: "connecting",
      tradesStatus: "connecting",
      statsStatus: "connecting",
    }));

    const markUnavailable = (): void => {
      if (!active) return;
      setState((previous) => previous.identity !== identity ? previous : ({
        ...previous,
        status: "unavailable",
        bookStatus: "unavailable",
        tradesStatus: "unavailable",
        statsStatus: "unavailable",
      }));
    };

    void window.vex.lighterTrading.startPublicMarketSubscription({
      subscriptionId,
      environment,
      marketId,
      marketType,
    }).then((result) => {
      if (!active || result.ok) return;
      markUnavailable();
    }).catch(markUnavailable);

    return () => {
      active = false;
      offBook();
      offTrades();
      offStats();
      offStatus();
      void window.vex.lighterTrading
        .stopPublicMarketSubscription({ subscriptionId })
        .catch(() => undefined);
    };
  }, [enabled, environment, identity, marketId, marketType]);

  return useMemo(() => ({
    status: state.status,
    bookStatus: state.bookStatus,
    tradesStatus: state.tradesStatus,
    statsStatus: state.statsStatus,
    book: state.book,
    trades: state.trades,
    stats: state.stats,
    bookReceivedAt: state.bookReceivedAt,
    tradesReceivedAt: state.tradesReceivedAt,
    statsReceivedAt: state.statsReceivedAt,
  }), [
    state.book,
    state.bookStatus,
    state.bookReceivedAt,
    state.stats,
    state.statsStatus,
    state.statsReceivedAt,
    state.status,
    state.trades,
    state.tradesStatus,
    state.tradesReceivedAt,
  ]);
}
