/**
 * Portfolio TanStack Query hook (stage 3).
 *
 * Read-only multi-scope POSITION portfolio. `usePortfolio` takes the WHOLE
 * validated `PortfolioReadInput` discriminant rather than a `string | null`
 * session id: the B0 `project` scope has no session id, so the old parameter
 * could not express it and every project would have read - and cached as - the
 * global inventory aggregate. Callers holding a card scope go through
 * `portfolioReadInputFor` (`book/portfolio/portfolio-scope.ts`), which is the
 * one place that maps a scope to this input.
 *
 * Empty scopes resolve to the empty portfolio DTO, never an error.
 */

import {
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  PortfolioDto,
  PortfolioReadInput,
} from "@shared/schemas/portfolio.js";
import type {
  AgentScanCursor,
  AgentScanDto,
  AgentScanFilters,
} from "@shared/schemas/agent-scan-feed.js";
import type { PortfolioRefreshOutput } from "@shared/schemas/agent-scan-feed.js";
import type {
  TokenHistoryCursor,
  TokenHistoryDto,
} from "@shared/schemas/token-history.js";
import { useCallback, useEffect } from "react";
import { portfolioKeys } from "./queryKeys.js";

const STALE_MS = 15_000;
/**
 * Fallback poll only (Wave P). `EV.portfolio.activityResolved` is now the
 * PRIMARY freshness signal — the engine pushes the moment a pending row
 * terminalizes — so this interval exists for the states a push cannot cover
 * (a missed event, a row that changed while no window was open). Raised from
 * 45s once the push landed.
 */
const REFETCH_MS = 60_000;

function portfolioOptions(input: PortfolioReadInput) {
  return queryOptions({
    // The WHOLE input, so no two reads that cover different wallets can share a
    // cache row. See `portfolioKeys.read`.
    queryKey: portfolioKeys.read(input),
    queryFn: () => window.vex.portfolio.read(input),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
  });
}

export function usePortfolio(
  input: PortfolioReadInput,
): UseQueryResult<Result<PortfolioDto>> {
  return useQuery(portfolioOptions(input));
}

/**
 * WP-L2 — the welcome-screen per-wallet switcher. Reads the SAME `global`
 * scope, narrowed server-side to one inventory wallet (main validates
 * `walletAddress` against the configured inventory before querying — see
 * `portfolio-db.ts`). `null` disables the query (the "All wallets" default
 * needs no wallet-scoped read; `PositionBlock`'s own aggregate `usePortfolio`
 * already covers it).
 */
function walletPortfolioOptions(walletAddress: string | null) {
  return queryOptions({
    queryKey: portfolioKeys.readWallet(walletAddress ?? ""),
    queryFn: () =>
      window.vex.portfolio.read(
        walletAddress === null
          ? { scope: "global" }
          : { scope: "global", walletAddress },
      ),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
    enabled: walletAddress !== null,
  });
}

export function useWalletPortfolio(
  walletAddress: string | null,
): UseQueryResult<Result<PortfolioDto>> {
  return useQuery(walletPortfolioOptions(walletAddress));
}

/**
 * Token history (chronos-shell) — the click-through per-token history
 * screen. Global scope, exact `(chainId, tokenAddress)` identity only (no
 * symbol-only lookup — name/symbol are display metadata, never a query
 * input). `identity: null` disables the query (screen closed / no token
 * selected yet).
 */
export interface TokenHistoryIdentity {
  readonly chainId: number;
  readonly tokenAddress: string;
}

/**
 * Next page param for the token-history infinite query. Mirrors
 * `getTranscriptNextPageParam` (`messages.ts`): a failed `Result`, an
 * `"unavailable"` (timed-out) page, or an exhausted page all stop pagination
 * rather than throwing — the component surfaces the page's own status.
 */
export function getTokenHistoryNextPageParam(
  lastPage: Result<TokenHistoryDto>,
): TokenHistoryCursor | undefined {
  if (!lastPage.ok) return undefined;
  if (lastPage.data.status !== "available") return undefined;
  return lastPage.data.hasMore && lastPage.data.nextCursor !== null
    ? lastPage.data.nextCursor
    : undefined;
}

/**
 * AGENT SCAN — the global full-history activity feed
 * (`vex:portfolio:listAgentScan`). Same infinite-query contract as
 * `useTokenHistoryInfinite`: a failed `Result`, an `"unavailable"` (timed-out)
 * page, or an exhausted page all STOP pagination rather than throwing, so the
 * screen surfaces the page's own status instead of an error boundary.
 */
export function getAgentScanNextPageParam(
  lastPage: Result<AgentScanDto>,
): AgentScanCursor | undefined {
  if (!lastPage.ok) return undefined;
  if (lastPage.data.status !== "available") return undefined;
  return lastPage.data.hasMore && lastPage.data.nextCursor !== null
    ? lastPage.data.nextCursor
    : undefined;
}

/**
 * `filters` MUST be referentially stable across renders (memoize it on the
 * user's selection): it is part of the query key, so a fresh object every
 * render would mint a fresh cache entry and refetch the whole feed.
 */
export function useAgentScanInfinite(
  filters: AgentScanFilters,
): UseInfiniteQueryResult<
  InfiniteData<Result<AgentScanDto>, AgentScanCursor | null>
> {
  return useInfiniteQuery({
    queryKey: portfolioKeys.agentScan(filters),
    queryFn: ({ pageParam }) =>
      window.vex.portfolio.listAgentScan({ cursor: pageParam, filters }),
    initialPageParam: null as AgentScanCursor | null,
    getNextPageParam: (lastPage) => getAgentScanNextPageParam(lastPage),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
  });
}

/**
 * Invalidate every portfolio query when a pending transaction terminalizes.
 *
 * The event carries IDS ONLY by design, so the correct reaction is to re-read
 * rather than to patch the cache: the DB stays the single source of truth and
 * the renderer never reconstructs money state from a push payload.
 *
 * Invalidating `portfolioKeys.all` covers the Agent Scan feed, the position
 * read, and the per-wallet read together — a terminalization moves all three,
 * and a narrower key would leave the balances stale next to a freshly
 * confirmed row.
 */
/**
 * The user-initiated refresh, as a hook.
 *
 * Lives here rather than in the button so that EVERY query-cache concern for
 * this domain sits in one module: the component stays presentational and
 * testable without a QueryClientProvider, and the invalidation key cannot drift
 * from the one `useActivityResolvedInvalidation` uses.
 *
 * `throttled` and `unavailable` are returned to the caller rather than thrown —
 * both are honest OUTCOMES the button renders as feedback.
 */
export function usePortfolioRefresh(): {
  readonly refresh: () => Promise<PortfolioRefreshOutput>;
} {
  const queryClient = useQueryClient();
  const refresh = useCallback(async (): Promise<PortfolioRefreshOutput> => {
    const result = await window.vex.portfolio.refresh();
    if (!result.ok) return { status: "unavailable" };
    if (result.data.status === "refreshed") {
      // Re-read rather than patch: main just rewrote the projection, and the DB
      // is the source of truth for every figure the card shows.
      await queryClient.invalidateQueries({ queryKey: portfolioKeys.all });
    }
    return result.data;
  }, [queryClient]);
  return { refresh };
}

export function useActivityResolvedInvalidation(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    // Degrade to poll-only rather than throw when the push bridge is absent.
    // This is an OPTIMISATION channel, not a security or correctness boundary:
    // `REFETCH_MS` above is the documented fallback and keeps the feed correct
    // on its own, so an older preload (or a harness that stubs only part of the
    // bridge) must render a working screen, not a blank one.
    const subscribe = window.vex?.portfolio?.onActivityResolved;
    if (typeof subscribe !== "function") return;
    return subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: portfolioKeys.all });
    });
  }, [queryClient]);
}

/**
 * OD-7 — the PENDING half of the same signal.
 *
 * `useActivityResolvedInvalidation` above only fires when a row terminalizes, so
 * everything that happened to a pending row before that — "it is in the mempool,
 * checked 3 s ago", a reason that changed, a stall clearing — reached the screen
 * no sooner than the 60 s poll. That is what made a pending launch look frozen
 * while the lane was in fact checking it every 5 seconds.
 *
 * Same degradation posture as its sibling: an absent bridge falls back to the
 * poll rather than throwing. This is an optimisation channel, not a correctness
 * boundary — the feed is already correct without it, just slower.
 */
export function useActivityProgressInvalidation(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const subscribe = window.vex?.portfolio?.onActivityProgress;
    if (typeof subscribe !== "function") return;
    return subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: portfolioKeys.all });
    });
  }, [queryClient]);
}

export function useTokenHistoryInfinite(
  identity: TokenHistoryIdentity | null,
): UseInfiniteQueryResult<
  InfiniteData<Result<TokenHistoryDto>, TokenHistoryCursor | null>
> {
  const chainId = identity?.chainId ?? 0;
  const tokenAddress = identity?.tokenAddress ?? "";
  return useInfiniteQuery({
    queryKey: portfolioKeys.tokenHistory(chainId, tokenAddress),
    queryFn: ({ pageParam }) =>
      window.vex.portfolio.listTokenHistory({ chainId, tokenAddress, cursor: pageParam }),
    initialPageParam: null as TokenHistoryCursor | null,
    getNextPageParam: (lastPage) => getTokenHistoryNextPageParam(lastPage),
    staleTime: STALE_MS,
    enabled: identity !== null,
  });
}
