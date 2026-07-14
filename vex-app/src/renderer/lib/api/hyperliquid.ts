/** Main-push Hyperliquid renderer data access. No renderer polling or exchange calls. */

import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  HyperliquidPositionsDto,
  HyperliquidBookDto,
  HyperliquidCandlesDto,
  HyperliquidCandleInterval,
  HyperliquidMarketsDto,
  HyperliquidOpenOrdersDto,
  HyperliquidTwapHistoryDto,
  HyperliquidTradeHistoryDto,
  HyperliquidFundingHistoryDto,
  HyperliquidOrderHistoryDto,
  HyperliquidRiskProposalConfirmInput,
  HyperliquidRiskProposalDto,
  HyperliquidRiskProposalsDto,
  HyperliquidSessionRiskPolicyDto,
  HyperliquidSessionRiskPolicySetInput,
  HyperliquidWorkspaceModeDto,
} from "@shared/schemas/hyperliquid.js";
import type { Preferences } from "@shared/schemas/preferences.js";
import { hyperliquidKeys } from "./queryKeys.js";

export function useHyperliquidPositions(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidPositionsDto>> {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (sessionId === null) return;
    const off = window.vex.hyperliquid.onPositionsUpdate((update) => {
      if (update.sessionId !== sessionId) return;
      queryClient.setQueryData<Result<HyperliquidPositionsDto>>(
        hyperliquidKeys.positions(sessionId),
        { ok: true, data: update },
      );
    });
    return off;
  }, [queryClient, sessionId]);
  return useQuery({
    queryKey: hyperliquidKeys.positions(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.getPositions({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}

/** Candles are fetched through main's bounded cache; renderer never reaches HL directly. */
export function useHyperliquidCandles(
  sessionId: string | null,
  coin: string | null,
  interval: HyperliquidCandleInterval = "1h",
): UseQueryResult<Result<HyperliquidCandlesDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.candles(sessionId ?? "", coin ?? "", interval),
    queryFn: () => window.vex.hyperliquid.getCandles({ sessionId: sessionId ?? "", coin: coin ?? "", interval }),
    enabled: sessionId !== null && coin !== null,
    staleTime: 30_000,
    retry: 0,
  });
}

/** Full Core perp universe (leverage, mark, 24h, funding, OI, volume).
 * 5s cadence (user-ordered): every pickable asset's metrics stay near-live;
 * main's 5s cache dedupes across windows so this never multiplies venue load. */
export function useHyperliquidMarkets(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidMarketsDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.markets(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.getMarkets({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: 4_000,
    refetchInterval: 5_000,
    retry: 0,
  });
}

/** L2 book for one coin — polled only while a book pane is visible. */
export function useHyperliquidBook(
  sessionId: string | null,
  coin: string | null,
  visible: boolean,
): UseQueryResult<Result<HyperliquidBookDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.book(sessionId ?? "", coin ?? ""),
    queryFn: () =>
      window.vex.hyperliquid.getBook({ sessionId: sessionId ?? "", coin: coin ?? "" }),
    enabled: sessionId !== null && coin !== null && visible,
    staleTime: 2_000,
    refetchInterval: visible ? 2_500 : false,
    retry: 0,
  });
}

/**
 * Live market watch: registers a main-side WebSocket watch for (coin,
 * interval) and returns the latest coalesced mid for the coin. Candle ticks
 * are consumed imperatively by the chart via `onCandleUpdate` (a chart is an
 * imperative surface; re-rendering per tick would rebuild the canvas).
 * A failed watch degrades silently — the snapshot/poll baseline still runs.
 */
export function useHyperliquidLiveWatch(
  sessionId: string | null,
  coin: string | null,
  interval: HyperliquidCandleInterval,
): { readonly liveMid: string | null } {
  const [liveMid, setLiveMid] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId === null || coin === null) return;
    let watchId: string | null = null;
    let cancelled = false;
    void window.vex.hyperliquid
      .watchLive({ sessionId, coin, interval })
      .then((result) => {
        if (!result.ok) return;
        if (cancelled) {
          // Unmounted before the invoke resolved — release immediately.
          void window.vex.hyperliquid.unwatchLive({ sessionId, watchId: result.data.watchId });
          return;
        }
        watchId = result.data.watchId;
      });
    return () => {
      cancelled = true;
      if (watchId !== null) {
        void window.vex.hyperliquid.unwatchLive({ sessionId, watchId });
      }
    };
  }, [sessionId, coin, interval]);

  useEffect(() => {
    if (coin === null) return;
    setLiveMid(null);
    return window.vex.hyperliquid.onMidsUpdate((event) => {
      const entry = event.mids.find((mid) => mid.coin === coin);
      if (entry !== undefined) setLiveMid(entry.midPx);
    });
  }, [coin]);

  return { liveMid };
}

/**
 * Read-only account registers. Each pane mounts only while its tab is active,
 * so the hook fetches only for the visible register; main's 15s per-(register,
 * wallet) cache dedupes the 15s refetch. The renderer sends only the sessionId.
 */
export function useHyperliquidOpenOrders(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidOpenOrdersDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.openOrders(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.getOpenOrders({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}

export function useHyperliquidTwapHistory(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidTwapHistoryDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.twapHistory(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.getTwapHistory({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}

export function useHyperliquidTradeHistory(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidTradeHistoryDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.tradeHistory(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.getTradeHistory({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}

export function useHyperliquidFundingHistory(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidFundingHistoryDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.fundingHistory(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.getFundingHistory({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}

export function useHyperliquidOrderHistory(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidOrderHistoryDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.orderHistory(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.getOrderHistory({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: 0,
  });
}

/** Per-session workspace-mode reconciliation read (session-switch remount). */
export function useHyperliquidWorkspaceModeRead(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidWorkspaceModeDto>> {
  return useQuery({
    queryKey: hyperliquidKeys.workspaceMode(sessionId ?? ""),
    queryFn: () =>
      window.vex.hyperliquid.getWorkspaceMode({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: 0,
    retry: 0,
  });
}

export function useHyperliquidRiskProposals(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidRiskProposalsDto>> {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (sessionId === null) return;
    const off = window.vex.hyperliquid.onRiskProposalUpdate((proposal) => {
      if (proposal.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: hyperliquidKeys.riskProposals(sessionId),
      });
    });
    return off;
  }, [queryClient, sessionId]);
  return useQuery({
    queryKey: hyperliquidKeys.riskProposals(sessionId ?? ""),
    queryFn: () => window.vex.hyperliquid.listRiskProposals({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}

/** The session's ACTIVE risk policy + its origin (user / proposal / defaults). */
export function useHyperliquidSessionRiskPolicy(
  sessionId: string | null,
): UseQueryResult<Result<HyperliquidSessionRiskPolicyDto>> {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (sessionId === null) return;
    // Proposal confirmations and direct sets share one broadcast.
    return window.vex.hyperliquid.onRiskProposalUpdate((proposal) => {
      if (proposal.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: hyperliquidKeys.sessionRiskPolicy(sessionId),
      });
    });
  }, [queryClient, sessionId]);
  return useQuery({
    queryKey: hyperliquidKeys.sessionRiskPolicy(sessionId ?? ""),
    queryFn: () =>
      window.vex.hyperliquid.getSessionRiskPolicy({ sessionId: sessionId ?? "" }),
    enabled: sessionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}

/** Direct user write of the session risk caps (the workspace panel). The
 * handler returns the freshly ACTIVATED proposal-shaped row; the panel's
 * read model refetches through its own query. */
export function useSetHyperliquidSessionRiskPolicy(): UseMutationResult<
  Result<HyperliquidRiskProposalDto>,
  Error,
  HyperliquidSessionRiskPolicySetInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.hyperliquid.setSessionRiskPolicy(input),
    retry: false,
    onSuccess: (result, input) => {
      if (result.ok) {
        void queryClient.invalidateQueries({
          queryKey: hyperliquidKeys.sessionRiskPolicy(input.sessionId),
        });
      }
    },
  });
}

export function useHyperliquidPreferences(): UseQueryResult<Result<Preferences>> {
  return useQuery({
    queryKey: hyperliquidKeys.preferences(),
    queryFn: () => window.vex.settings.getPreferences(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}

export function useAcknowledgeHyperliquidRisk(): UseMutationResult<
  Result<Preferences>,
  Error,
  void
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => window.vex.hyperliquid.acknowledgeRisk(),
    retry: false,
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.setQueryData<Result<Preferences>>(
          hyperliquidKeys.preferences(),
          result,
        );
      }
    },
  });
}

export function useConfirmHyperliquidRiskProposal(): UseMutationResult<
  Result<HyperliquidRiskProposalDto>,
  Error,
  HyperliquidRiskProposalConfirmInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.hyperliquid.confirmRiskProposal(input),
    retry: false,
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({
          queryKey: hyperliquidKeys.riskProposals(result.data.sessionId),
        });
      }
    },
  });
}
