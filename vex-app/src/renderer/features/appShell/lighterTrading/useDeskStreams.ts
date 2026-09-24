import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  LighterTradingCandle,
  LighterTradingEnvironment,
  LighterTradingMarket,
  LighterTradingLiveResolution,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { useLighterTradingSnapshot } from "../../../lib/api/lighter-trading.js";
import { marketSectionFor } from "./market-classification.js";
import { useLighterCandleStream } from "./useLighterCandleStream.js";
import { useLighterPublicMarketStream } from "./useLighterPublicMarketStream.js";

const EMPTY_CANDLES: readonly LighterTradingCandle[] = [];
const EMPTY_BOOK: LighterTradingSnapshot["book"] = { asks: [], bids: [] };

export interface DeskStreamsInput {
  environment: LighterTradingEnvironment;
  market: LighterTradingMarket | null;
  resolution: LighterTradingLiveResolution;
}

/**
 * The desk's market data: the REST snapshot plus the candle and public
 * market streams layered on it. Streams run only here; the desk hook passes
 * the results down to the chart, book and ticket.
 */
export function useDeskStreams({ environment, market, resolution }: DeskStreamsInput) {
  const queryClient = useQueryClient();
  const [reloadKey, setReloadKey] = useState(0);
  const snapshotQuery = useLighterTradingSnapshot(
    environment,
    market?.marketId ?? null,
    resolution,
    market !== null && marketSectionFor(environment, market) !== "stocks",
  );
  const snapshot = snapshotQuery.data?.ok === true ? snapshotQuery.data.data : null;
  const candleStream = useLighterCandleStream({
    enabled: market !== null,
    environment,
    marketId: market?.marketId ?? null,
    resolution,
    restCandles: snapshot?.candles ?? EMPTY_CANDLES,
    reloadKey,
  });
  const publicMarketStream = useLighterPublicMarketStream({
    enabled: market !== null,
    environment,
    marketId: market?.marketId ?? null,
    marketType: market?.marketType ?? null,
    restSnapshot: snapshot,
    reloadKey,
  });

  // A live stream that drops back to delayed or worse re-reads the snapshot
  // so the desk shows the last confirmed state instead of a stale tick.
  const previousPublicStatus = useRef(publicMarketStream.status);
  useEffect(() => {
    const previous = previousPublicStatus.current;
    previousPublicStatus.current = publicMarketStream.status;
    if (
      previous === "live"
      && (publicMarketStream.status === "reconnecting"
        || publicMarketStream.status === "delayed"
        || publicMarketStream.status === "unavailable")
    ) {
      void snapshotQuery.refetch();
    }
  }, [publicMarketStream.status, snapshotQuery.refetch]);

  const book = publicMarketStream.book ?? snapshot?.book ?? EMPTY_BOOK;
  const lastPrice = publicMarketStream.stats?.lastTradePrice
    ?? snapshot?.detail.lastTradePrice
    ?? null;
  const dataFresh = (snapshot !== null || publicMarketStream.bookReceivedAt !== null)
    && publicMarketStream.bookStatus !== "delayed"
    && publicMarketStream.bookStatus !== "unavailable";

  // The header's reload. After about two minutes without a connection the
  // public stream gives up and never rearms on its own, so the desk stayed
  // "Unavailable" after the network came back. Rebuild both streams and
  // re-read every Lighter view the desk shows.
  const reload = useCallback((): void => {
    setReloadKey((key) => key + 1);
    void queryClient.invalidateQueries({ queryKey: ["lighterTrading"] });
  }, [queryClient]);

  return { snapshotQuery, snapshot, candleStream, publicMarketStream, book, lastPrice, dataFresh, reload };
}

export type DeskStreams = ReturnType<typeof useDeskStreams>;
