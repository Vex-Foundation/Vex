import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  LighterTradingAccount,
  LighterTradingEnvironment,
  LighterTradingMarketList,
  LighterTradingResolution,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";

const MARKET_LIST_STALE_MS = 30_000;
// The account panel changes less often than the tape; a slower cadence keeps
// the authenticated read light while positions/orders stay reasonably fresh.
const ACCOUNT_REFETCH_MS = 15_000;

export function useLighterTradingMarkets(
  environment: LighterTradingEnvironment,
  enabled: boolean,
): UseQueryResult<Result<LighterTradingMarketList>> {
  return useQuery({
    queryKey: ["lighterTrading", "markets", environment],
    queryFn: () => window.vex.lighterTrading.listMarkets({ environment }),
    enabled,
    staleTime: MARKET_LIST_STALE_MS,
    refetchInterval: enabled ? MARKET_LIST_STALE_MS : false,
    refetchIntervalInBackground: false,
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
    // Public book, trades and market stats are event-driven. REST is the
    // initial/reconnect snapshot only; periodic composite polling would both
    // lag the provider and consume the recent-trades rate-limit budget.
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
}

export function useLighterTradingAccount(
  environment: LighterTradingEnvironment,
  enabled: boolean,
): UseQueryResult<Result<LighterTradingAccount>> {
  return useQuery({
    queryKey: ["lighterTrading", "account", environment],
    queryFn: () => window.vex.lighterTrading.getAccount({ environment }),
    enabled,
    staleTime: 5_000,
    refetchInterval: enabled ? ACCOUNT_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}
