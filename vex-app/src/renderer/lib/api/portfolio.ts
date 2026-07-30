/**
 * Portfolio TanStack Query hook (stage 3).
 *
 * Read-only dual-scope POSITION portfolio. A `null` active session reads
 * the GLOBAL inventory portfolio; a non-null active session reads that
 * session's wallet-scope portfolio. The renderer derives the discriminated
 * input here — it never supplies a wallet address. Empty scopes resolve to
 * the empty portfolio DTO, never an error.
 *
 * Not rendered yet (stage 4 wires the panel).
 */

import {
  queryOptions,
  useInfiniteQuery,
  useQuery,
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
import type {
  TokenHistoryCursor,
  TokenHistoryDto,
} from "@shared/schemas/token-history.js";
import { portfolioKeys } from "./queryKeys.js";

const STALE_MS = 15_000;
const REFETCH_MS = 45_000;

function portfolioInput(activeSessionId: string | null): PortfolioReadInput {
  return activeSessionId === null
    ? { scope: "global" }
    : { scope: "session", sessionId: activeSessionId };
}

function portfolioOptions(activeSessionId: string | null) {
  const input = portfolioInput(activeSessionId);
  return queryOptions({
    queryKey: portfolioKeys.read(input.scope, activeSessionId),
    queryFn: () => window.vex.portfolio.read(input),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
  });
}

export function usePortfolio(
  activeSessionId: string | null,
): UseQueryResult<Result<PortfolioDto>> {
  return useQuery(portfolioOptions(activeSessionId));
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
