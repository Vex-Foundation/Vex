import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  LighterAccountSetupStatus,
  LighterTradingAccount,
  LighterTradingEnvironment,
  LighterTradingFills,
  LighterTradingMarketList,
  LighterOnboardingChecklist,
  LighterTradingResolution,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";

/**
 * CANCELLATION IS REAL HERE, and consuming the signal is what arms it.
 * TanStack only cancels a fetch whose query function touched its
 * `AbortSignal`; touching it turns "the reader closed the workspace or picked
 * another market" into main's own `ctx.signal`, which stops the queued Lighter
 * REST read instead of paying for an answer nobody will see.
 *
 * THE LISTENER HAS AN OWNER, and the owner is this call (rule 05). Two defects
 * the first version carried, both from attaching and never detaching:
 *
 *  - an ALREADY-ABORTED signal was never honoured. TanStack reuses one signal
 *    across a query's retries and hands an aborted one to a query function that
 *    starts after the reader has already navigated away; `addEventListener`
 *    fires nothing for an event that has passed, so the invocation ran to
 *    completion and main paid for a read nobody would see - the exact cost this
 *    helper exists to avoid. Cancel first, synchronously, the way VS Code's
 *    `CancellationToken.Cancelled` shortcut answers a token that is already
 *    cancelled instead of waiting for an event that will never fire.
 *  - the listener OUTLIVED the invocation. A settled invocation's `cancel` stayed
 *    on the signal until the signal itself was collected, so a later abort of
 *    the same signal reached back into finished work, and a long-lived query
 *    accumulated one dead listener per refetch.
 *
 * Exported for its colocated test, which is the only way to prove the listener
 * count returns to zero on BOTH outcomes.
 */
export function abortable<T>(
  invocation: { readonly promise: Promise<T>; readonly cancel: () => void },
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    invocation.cancel();
    return invocation.promise;
  }
  const onAbort = (): void => {
    invocation.cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // `finally` preserves both the value and the rejection reason: it detaches on
  // settlement without changing what the caller receives.
  return invocation.promise.finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

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
    queryFn: ({ signal }) =>
      abortable(window.vex.lighterTrading.listMarkets({ environment }), signal),
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
    queryFn: ({ signal }) => {
      if (marketId === null) throw new Error("A Lighter market is required.");
      return abortable(
        window.vex.lighterTrading.getSnapshot({ environment, marketId, resolution }),
        signal,
      );
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
  sessionId?: string | null,
): UseQueryResult<Result<LighterTradingAccount>> {
  return useQuery({
    queryKey: ["lighterTrading", "account", environment, sessionId === undefined ? "unscoped" : sessionId],
    queryFn: ({ signal }) => {
      if (sessionId === null) throw new Error("A Lighter session is required.");
      return abortable(window.vex.lighterTrading.getAccount({ environment, ...(sessionId === undefined ? {} : { sessionId }) }), signal);
    },
    enabled: enabled && sessionId !== null,
    placeholderData: () => undefined,
    staleTime: 5_000,
    refetchInterval: enabled && sessionId !== null ? ACCOUNT_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function useLighterTradingFills(
  environment: LighterTradingEnvironment,
  enabled: boolean,
  sessionId?: string | null,
): UseQueryResult<Result<LighterTradingFills>> {
  return useQuery({
    queryKey: ["lighterTrading", "fills", environment, sessionId === undefined ? "unscoped" : sessionId],
    queryFn: ({ signal }) => {
      if (sessionId === null) throw new Error("A Lighter session is required.");
      return abortable(window.vex.lighterTrading.listFills({ environment, limit: 50, ...(sessionId === undefined ? {} : { sessionId }) }), signal);
    },
    enabled: enabled && sessionId !== null,
    placeholderData: () => undefined,
    staleTime: 5_000,
    refetchInterval: enabled && sessionId !== null ? ACCOUNT_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}

// The ticket gate's checklist: three address-only reads, refreshed while the
// gate is up so a step the chat just completed shows as done within a poll.
const ONBOARDING_REFETCH_MS = 20_000;

export function useLighterOnboardingChecklist(
  sessionId: string | null,
  environment: LighterTradingEnvironment,
  enabled: boolean,
): UseQueryResult<Result<LighterOnboardingChecklist>> {
  const active = enabled && sessionId !== null;
  return useQuery({
    queryKey: ["lighterTrading", "onboarding", environment, sessionId],
    queryFn: ({ signal }) =>
      abortable(
        window.vex.lighterTrading.getOnboardingChecklist({ sessionId: sessionId ?? "", environment }),
        signal,
      ),
    enabled: active,
    staleTime: 5_000,
    refetchInterval: active ? ONBOARDING_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}

// The account-setup modal's own read (balance, minimum deposit, fee terms).
// The modal shows this once on open to size the amount field; once its chain
// is running, the chain's own poll loop pushes fresher reads into this exact
// query's cache (see `useLighterAccountSetup`), so this hook needs no
// interval of its own - a live-in-flight step is never reading stale data.
export function lighterAccountSetupStatusQueryKey(
  environment: LighterTradingEnvironment,
  sessionId: string | null,
) {
  return ["lighterTrading", "accountSetup", environment, sessionId] as const;
}

export function useLighterAccountSetupStatus(
  sessionId: string | null,
  environment: LighterTradingEnvironment,
  enabled: boolean,
): UseQueryResult<Result<LighterAccountSetupStatus>> {
  const active = enabled && sessionId !== null;
  return useQuery({
    queryKey: lighterAccountSetupStatusQueryKey(environment, sessionId),
    queryFn: ({ signal }) =>
      abortable(
        window.vex.lighterTrading.getAccountSetupStatus({ sessionId: sessionId ?? "", environment }),
        signal,
      ),
    enabled: active,
    staleTime: 5_000,
    refetchInterval: false,
  });
}

/** How long to coalesce a burst of stream frames before one refetch. */
const ACCOUNT_ACTIVITY_DEBOUNCE_MS = 400;

/**
 * Refreshes the account and fills reads when main's authenticated stream
 * reports activity for this environment, so a fill or cancel shows up in the
 * dock within a second instead of at the next poll.
 */
export function useLighterAccountActivityRefresh(
  environment: LighterTradingEnvironment,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.vex.lighterTrading.onAccountActivity((event) => {
      if (event.environment !== environment) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", environment] });
        void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "fills", environment] });
      }, ACCOUNT_ACTIVITY_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, environment, queryClient]);
}
