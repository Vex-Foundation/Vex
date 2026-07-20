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
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  PortfolioDto,
  PortfolioReadInput,
} from "@shared/schemas/portfolio.js";
import type { MovesDto } from "@shared/schemas/portfolio-moves.js";
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
 * MOVES (move 0.3) — the session's executed-trade activity from
 * `proj_activity`, scoped server-side to the session's wallets. Drives the
 * BOOK Moves block. Read-only; an empty scope resolves to `[]`, never an
 * error. The session id is required (MOVES are session-scoped — there is no
 * global feed).
 */
function movesOptions(sessionId: string) {
  return queryOptions({
    queryKey: portfolioKeys.moves(sessionId),
    queryFn: () => window.vex.portfolio.listMoves({ sessionId }),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
    enabled: sessionId.length > 0,
  });
}

export function useMoves(
  sessionId: string,
): UseQueryResult<Result<MovesDto>> {
  return useQuery(movesOptions(sessionId));
}

/**
 * MOVES for ONE mission run — the summary card's trade receipts.
 *
 * The window filter is applied in SQL (see `moves-db.ts`), reusing the
 * engine's own run-attribution rule, so this list agrees with the ledger's
 * trade COUNT. Deliberately NOT a client-side filter of `useMoves`: that
 * would be a second copy of the attribution rule, free to drift from the one
 * that produced the count the card renders beside it.
 *
 * These rows are terminal history — a finished run's trades never change — so
 * unlike the live session feed this does not poll.
 */
function movesForRunOptions(sessionId: string, missionRunId: string) {
  return queryOptions({
    queryKey: portfolioKeys.movesForRun(sessionId, missionRunId),
    queryFn: () => window.vex.portfolio.listMoves({ sessionId, missionRunId }),
    staleTime: STALE_MS,
    enabled: sessionId.length > 0 && missionRunId.length > 0,
  });
}

export function useMovesForRun(
  sessionId: string,
  missionRunId: string,
): UseQueryResult<Result<MovesDto>> {
  return useQuery(movesForRunOptions(sessionId, missionRunId));
}
