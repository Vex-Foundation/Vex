/**
 * Renderer adapter for the Lighter trading setup.
 *
 * These hooks own loading, retry and invalidation for the operation; the
 * Settings components own rendering and the person's intent. Nothing here
 * decides policy: the capital share is a preference and the leverage change is
 * a main-process signing path, and both are enforced on the other side of the
 * bridge.
 *
 * INVALIDATION IS THE POINT of the mutations below. A leverage change alters
 * live provider state, so the limits, the overview and the trading account read
 * are all stale the moment it settles; leaving any of them cached would show a
 * person a number Lighter no longer agrees with.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import type {
  ApplyLighterLeverageResult,
  ConfirmLighterLeverageInput,
  LighterLeverageOverview,
  LighterLeverageProposal,
  LighterTradingLimits,
  PrepareLighterLeverageInput,
  ReconcileLighterLeverageInput,
  SetLighterTradingLimitsInput,
} from "@shared/schemas/lighter-trading-limits.js";

interface WalletScope {
  readonly environment: LighterIntegrationEnvironment;
  readonly walletAddress: string;
}

export const lighterTradingLimitsKey = (scope: WalletScope) =>
  ["settings", "lighterTradingLimits", scope.environment, scope.walletAddress.toLowerCase()] as const;

export const lighterLeverageOverviewKey = (scope: WalletScope) =>
  ["settings", "lighterLeverageOverview", scope.environment, scope.walletAddress.toLowerCase()] as const;

export function useLighterTradingLimits(
  scope: WalletScope,
): UseQueryResult<Result<LighterTradingLimits>> {
  return useQuery({
    queryKey: lighterTradingLimitsKey(scope),
    queryFn: () => window.vex.settings.getLighterTradingLimits(scope),
  });
}

export function useSetLighterTradingLimits(): UseMutationResult<
  Result<LighterTradingLimits>,
  Error,
  SetLighterTradingLimitsInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.settings.setLighterTradingLimits(input),
    // Invalidated on every settlement, not only on success: a revision conflict
    // means the stored value is NOT what this editor holds, so the held value
    // must be refetched before the person tries again.
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: lighterTradingLimitsKey(input) });
    },
  });
}

export function useLighterLeverageOverview(
  scope: WalletScope,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<Result<LighterLeverageOverview>> {
  return useQuery({
    queryKey: lighterLeverageOverviewKey(scope),
    queryFn: () => window.vex.settings.getLighterLeverageOverview(scope),
    enabled: options.enabled ?? true,
  });
}

/**
 * PREPARE. Deliberately NOT a query: it has a side effect (main persists an
 * immutable proposal with its own expiry), so it must never be refetched,
 * retried or served from cache.
 */
export function usePrepareLighterLeverage(): UseMutationResult<
  Result<LighterLeverageProposal>,
  Error,
  PrepareLighterLeverageInput
> {
  return useMutation({
    mutationFn: (input) => window.vex.settings.prepareLighterLeverage(input),
  });
}

/**
 * CONFIRM. `retry: false` is a safety property, not a preference: this is a
 * signing path, and an automatic second attempt is exactly what must never
 * happen. An unresolved outcome is recovered through Reconcile.
 */
export function useConfirmLighterLeverage(
  scope: WalletScope,
): UseMutationResult<Result<ApplyLighterLeverageResult>, Error, ConfirmLighterLeverageInput> {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (input) => window.vex.settings.confirmLighterLeverage(input).promise,
    onSettled: () => invalidateAfterLeverageChange(queryClient, scope),
  });
}

export function useReconcileLighterLeverage(
  scope: WalletScope,
): UseMutationResult<Result<ApplyLighterLeverageResult>, Error, ReconcileLighterLeverageInput> {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (input) => window.vex.settings.reconcileLighterLeverage(input),
    onSettled: () => invalidateAfterLeverageChange(queryClient, scope),
  });
}

function invalidateAfterLeverageChange(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: WalletScope,
): void {
  void queryClient.invalidateQueries({ queryKey: lighterLeverageOverviewKey(scope) });
  void queryClient.invalidateQueries({ queryKey: lighterTradingLimitsKey(scope) });
  // The trading panel reads the same account: its margin figures move with the
  // initial margin fraction, so a stale cache there would contradict this card.
  void queryClient.invalidateQueries({ queryKey: ["lighterTrading", "account", scope.environment] });
}
