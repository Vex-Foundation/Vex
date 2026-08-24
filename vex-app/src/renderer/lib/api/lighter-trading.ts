import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  LighterTradingEnvironment,
  LighterTradingMarketList,
  LighterTradingResolution,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";

const MARKET_LIST_STALE_MS = 30_000;
// One active workspace performs a single composite snapshot read. Ten seconds
// keeps ordinary UI use comfortably inside Lighter's public REST budget while
// still making staleness explicit in the ticket.
const SNAPSHOT_REFETCH_MS = 10_000;

export function useLighterTradingMarkets(
  environment: LighterTradingEnvironment,
  enabled: boolean,
): UseQueryResult<Result<LighterTradingMarketList>> {
  return useQuery({
    queryKey: ["lighterTrading", "markets", environment],
    queryFn: () => window.vex.lighterTrading.listMarkets({ environment }),
    enabled,
    staleTime: MARKET_LIST_STALE_MS,
  });
}

export function useLighterTradingSnapshot(
  environment: LighterTradingEnvironment,
  marketId: number | null,
  resolution: LighterTradingResolution,
  enabled: boolean,
): UseQueryResult<Result<LighterTradingSnapshot>> {
  return useQuery({
    queryKey: ["lighterTrading", "snapshot", environment, marketId, resolution],
    queryFn: () => {
      if (marketId === null) throw new Error("A Lighter market is required.");
      return window.vex.lighterTrading.getSnapshot({
        environment,
        marketId,
        resolution,
      });
    },
    enabled: enabled && marketId !== null,
    staleTime: 2_000,
    refetchInterval: enabled && marketId !== null ? SNAPSHOT_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}
