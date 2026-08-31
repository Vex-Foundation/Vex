/**
 * Global wallet inventory hook — the config-backed list of available wallets
 * (≤3 EVM + ≤3 Solana), surfaced for BOTH the onboarding multi-wallet UI
 * (puzzle 5 phase 5D) and the per-session selection picker (phase 5C).
 *
 * Neutral module on purpose: the inventory is a global concept, not a
 * session-scope one, so onboarding components can consume it without
 * coupling to `session-wallets.ts` (Codex 5D wiring review). `listAvailable`
 * reads config inventory via `listWallets()` — no DB, no setup-complete
 * gate — so it works mid-onboarding too.
 */

import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { AvailableWalletsDto } from "@shared/schemas/wallets.js";
import { walletsKeys } from "./queryKeys.js";

const STALE_MS = 10_000;

export function availableWalletsOptions(enabled: boolean = true) {
  return queryOptions({
    queryKey: walletsKeys.available(),
    queryFn: () => window.vex.wallets.listAvailable({}),
    staleTime: STALE_MS,
    enabled,
  });
}

/**
 * Inventory wallets available to pick from (session create) or extend
 * (onboarding).
 *
 * `enabled` gates the read for a caller that must not TOUCH the global
 * inventory at all - a project-scoped surface, whose identities are the
 * project's own selection, not this global list. `false` keeps the hook call
 * unconditional (stable hook order) while the query never runs: no
 * `wallets.listAvailable` IPC, and no row written into the shared global cache
 * key that every other consumer reads. The caller then degrades exactly as it
 * does for an inventory that has not resolved yet. Same shape as
 * `useProviderModels` in `provider.ts`, the other query here with no domain
 * input of its own to gate on.
 */
export function useAvailableWallets(
  enabled: boolean = true,
): UseQueryResult<Result<AvailableWalletsDto>> {
  return useQuery(availableWalletsOptions(enabled));
}
