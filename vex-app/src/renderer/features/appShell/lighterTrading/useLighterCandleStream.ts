import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LighterTradingCandle,
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingLiveResolution,
} from "@shared/schemas/lighter-trading.js";
import {
  upsertChartCandles,
  type ChartCandleRow,
} from "./chart-adapter.js";

export type LighterCandleHistoryStatus = "idle" | "loading" | "exhausted";

export interface LighterCandleStreamState {
  readonly candles: readonly LighterTradingCandle[];
  readonly status: LighterTradingCandleConnectionStatus;
  readonly providerTimestamp: number | null;
  readonly receivedAt: number | null;
  /** Scroll-back backfill: one older REST page at a time, per identity. */
  readonly history: LighterCandleHistoryStatus;
  readonly loadOlder: () => void;
}

interface InternalStreamState {
  readonly identity: string;
  readonly candles: readonly LighterTradingCandle[];
  readonly status: LighterTradingCandleConnectionStatus;
  readonly providerTimestamp: number | null;
  readonly receivedAt: number | null;
}

/** One provider read; the same bound `readLighterTradingCandleHistory` enforces. */
const HISTORY_PAGE_COUNT = 500;

function restRows(
  candles: readonly LighterTradingCandle[],
): readonly ChartCandleRow[] {
  return candles.map((candle) => ({
    ...candle,
    source: candle.source ?? "rest_snapshot",
  }));
}

function sameRows(
  left: readonly LighterTradingCandle[],
  right: readonly LighterTradingCandle[],
): boolean {
  return left.length === right.length
    && left.every((candle, index) => candle === right[index]);
}

/**
 * Binds one renderer-owned subscription to the selected Lighter candle feed.
 * The preload validates every event; this hook additionally scopes events to
 * the exact subscription identity so late frames from a prior market cannot
 * mutate the active chart.
 */
export function useLighterCandleStream({
  enabled,
  environment,
  marketId,
  resolution,
  restCandles,
}: {
  readonly enabled: boolean;
  readonly environment: LighterTradingEnvironment;
  readonly marketId: number | null;
  readonly resolution: LighterTradingLiveResolution;
  readonly restCandles: readonly LighterTradingCandle[];
}): LighterCandleStreamState {
  const identity = `${environment}:${marketId ?? "none"}:${resolution}`;
  const [state, setState] = useState<InternalStreamState>(() => ({
    identity,
    candles: upsertChartCandles([], restRows(restCandles)),
    status: enabled && marketId !== null ? "connecting" : "stopped",
    providerTimestamp: null,
    receivedAt: null,
  }));

  useEffect(() => {
    setState((previous) => {
      if (previous.identity !== identity) {
        return {
          identity,
          candles: upsertChartCandles([], restRows(restCandles)),
          status: enabled && marketId !== null ? "connecting" : "stopped",
          providerTimestamp: null,
          receivedAt: null,
        };
      }
      const candles = upsertChartCandles(previous.candles, restRows(restCandles));
      if (sameRows(previous.candles, candles)) return previous;
      return {
        ...previous,
        candles,
      };
    });
  }, [enabled, identity, marketId, restCandles]);

  useEffect(() => {
    if (!enabled || marketId === null) return undefined;

    const subscriptionId = crypto.randomUUID();
    let active = true;
    const matches = (event: {
      readonly subscriptionId: string;
      readonly environment: LighterTradingEnvironment;
      readonly marketId: number;
      readonly resolution: LighterTradingLiveResolution;
    }): boolean => event.subscriptionId === subscriptionId
      && event.environment === environment
      && event.marketId === marketId
      && event.resolution === resolution;

    const applyCandles = (event: Parameters<
      typeof window.vex.lighterTrading.onCandleSnapshot
    >[0] extends (value: infer TValue) => void ? TValue : never): void => {
      if (!active || !matches(event)) return;
      setState((previous) => {
        if (
          previous.identity !== identity
          || (previous.providerTimestamp !== null
            && event.providerTimestamp < previous.providerTimestamp)
        ) return previous;
        const candles = upsertChartCandles(previous.candles, event.candles);
        // A stale/equal provider echo must not refresh the on-screen data age.
        if (sameRows(previous.candles, candles)) return previous;
        return {
          ...previous,
          candles,
          status: "live",
          providerTimestamp: event.providerTimestamp,
          receivedAt: event.receivedAt,
        };
      });
    };

    const offSnapshot = window.vex.lighterTrading.onCandleSnapshot(applyCandles);
    const offUpdate = window.vex.lighterTrading.onCandleUpdate((event) => {
      applyCandles(event);
    });
    const offStatus = window.vex.lighterTrading.onCandleStatus((event) => {
      if (!active || !matches(event)) return;
      setState((previous) => previous.identity !== identity ? previous : ({
        ...previous,
        status: event.status,
      }));
    });

    setState((previous) => previous.identity !== identity ? previous : ({
      ...previous,
      status: "connecting",
      providerTimestamp: null,
      receivedAt: null,
    }));

    const markUnavailable = (): void => {
      if (!active) return;
      setState((previous) => previous.identity !== identity ? previous : ({
        ...previous,
        status: "unavailable",
        providerTimestamp: null,
        receivedAt: null,
      }));
    };

    void window.vex.lighterTrading.startCandleSubscription({
      subscriptionId,
      environment,
      marketId,
      resolution,
    }).then((result) => {
      if (!active || result.ok) return;
      markUnavailable();
    }).catch(markUnavailable);

    return () => {
      active = false;
      offSnapshot();
      offUpdate();
      offStatus();
      void window.vex.lighterTrading
        .stopCandleSubscription({ subscriptionId })
        .catch(() => undefined);
    };
  }, [enabled, environment, identity, marketId, resolution]);

  // State resets in an effect, so an identity change otherwise exposes one
  // render of the prior market's candles and status. Project the new identity
  // synchronously while its subscription is being installed.
  const currentCandles = state.identity === identity
    ? state.candles
    : upsertChartCandles([], restRows(restCandles));

  // Older pages are requested from the chart's scroll position, so the request
  // reads the earliest bar through a ref instead of re-binding on every tick.
  const earliestRef = useRef<LighterTradingCandle | undefined>(currentCandles[0]);
  earliestRef.current = currentCandles[0];
  const inFlightRef = useRef<{ readonly cancel: () => void } | null>(null);
  // The earliest bar the last page was requested from. A successful page must
  // move this boundary; repeating it means the provider has no earlier rows.
  const lastRequestedRef = useRef<{ readonly identity: string; readonly timestamp: number } | null>(null);
  const [history, setHistory] = useState<{
    readonly identity: string;
    readonly status: LighterCandleHistoryStatus;
  }>({ identity, status: "idle" });
  const currentHistory = history.identity === identity ? history.status : "idle";

  useEffect(() => () => {
    inFlightRef.current?.cancel();
    inFlightRef.current = null;
  }, [identity]);

  const loadOlder = useCallback((): void => {
    const earliest = earliestRef.current;
    if (
      !enabled
      || marketId === null
      || earliest === undefined
      || inFlightRef.current !== null
      || currentHistory === "exhausted"
    ) return;
    const lastRequested = lastRequestedRef.current;
    if (lastRequested?.identity === identity && lastRequested.timestamp === earliest.timestamp) {
      setHistory({ identity, status: "exhausted" });
      return;
    }
    lastRequestedRef.current = { identity, timestamp: earliest.timestamp };
    const invocation = window.vex.lighterTrading.getCandleHistory({
      environment,
      marketId,
      resolution,
      endTimestamp: Math.max(0, earliest.timestamp - 1),
      count: HISTORY_PAGE_COUNT,
    });
    inFlightRef.current = invocation;
    setHistory({ identity, status: "loading" });
    const settle = (status: LighterCandleHistoryStatus): void => {
      if (inFlightRef.current !== invocation) return;
      inFlightRef.current = null;
      setHistory({ identity, status });
    };
    invocation.promise.then((result) => {
      if (inFlightRef.current !== invocation) return;
      if (!result.ok) { settle("idle"); return; }
      const older = result.data.candles.filter((candle) => candle.timestamp < earliest.timestamp);
      if (older.length === 0) { settle("exhausted"); return; }
      setState((previous) => previous.identity !== identity ? previous : ({
        ...previous,
        candles: upsertChartCandles(previous.candles, restRows(older)),
      }));
      settle("idle");
    }).catch(() => settle("idle"));
  }, [currentHistory, enabled, environment, identity, marketId, resolution]);
  const currentStatus = state.identity === identity
    ? state.status
    : enabled && marketId !== null ? "connecting" : "stopped";
  const currentProviderTimestamp = state.identity === identity ? state.providerTimestamp : null;
  const currentReceivedAt = state.identity === identity ? state.receivedAt : null;

  return useMemo(() => ({
    candles: currentCandles,
    status: currentStatus,
    providerTimestamp: currentProviderTimestamp,
    receivedAt: currentReceivedAt,
    history: currentHistory,
    loadOlder,
  }), [currentCandles, currentHistory, currentProviderTimestamp, currentReceivedAt, currentStatus, loadOlder]);
}
