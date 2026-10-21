/**
 * Vex Cloud: the renderer half of the `vex:vexCloud:*` contract (sign-in and
 * account, and the phase 2 funding calls).
 *
 * THE BOUNDARY LAW OF THIS FILE. The renderer holds no key, no session and no
 * message to sign. It sends the wallets the user saw beside the consent and
 * reads back public account facts. Every type is the inferred type of the
 * shared schema main validates with; nothing is re-declared here.
 *
 * `account` is a query (it is a read the screen polls while open); `signIn`
 * and `signOut` are plain calls driven by the component's own state, because
 * a sign-in that re-ran itself in the background would sign without a click.
 * The same holds for every funding call that moves money: prepare and submit
 * are plain calls a button drives, never a query that could re-run itself.
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
  VexCloudAccountResult,
  VexCloudSignInInput,
  VexCloudSignInResult,
  VexCloudSignOutResult,
} from "@shared/schemas/vex-cloud.js";
import {
  withdrawalStatusWord,
  type VexCloudActivityResult,
  type VexCloudClaimCashbackResult,
  type VexCloudDepositProposal,
  type VexCloudDepositsResult,
  type VexCloudDepositWalletsResult,
  type VexCloudPrepareDepositInput,
  type VexCloudPrepareWithdrawalInput,
  type VexCloudSubmitDepositInput,
  type VexCloudSubmitDepositResult,
  type VexCloudSubmitWithdrawalInput,
  type VexCloudSubmitWithdrawalResult,
  type VexCloudUsageResult,
  type VexCloudWithdrawalProposal,
} from "@shared/schemas/vex-cloud-funding.js";
import type { AbortableInvocation } from "@shared/types/bridge/common.js";
import type { VexCloudBridge } from "@shared/types/bridge/shell/vex-cloud.js";
import { onboardingKeys, vexCloudKeys } from "./queryKeys.js";

/**
 * The preload domain, or `null` when the running preload predates it (the
 * `?? null` is not redundant: `window.vex` is whatever preload actually loaded).
 */
function vexCloudBridge(): VexCloudBridge | null {
  return window.vex.vexCloud ?? null;
}

const BRIDGE_UNAVAILABLE: Result<never> = {
  ok: false,
  error: {
    code: "internal.contract_violation",
    domain: "system",
    message: "Vex Cloud isn't available in this build yet.",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId: "renderer-local",
  },
};

/** How often an open Vex Cloud screen re-reads the balance (polling in v1, plan section 7). */
const ACCOUNT_POLL_MS = 30_000;

export function useVexCloudAccount(enabled: boolean = true): UseQueryResult<Result<VexCloudAccountResult>> {
  return useQuery(
    queryOptions({
      queryKey: vexCloudKeys.account(),
      queryFn: async () => {
        const bridge = vexCloudBridge();
        return bridge === null ? BRIDGE_UNAVAILABLE : bridge.account();
      },
      enabled,
      refetchInterval: ACCOUNT_POLL_MS,
      retry: false,
    }),
  );
}

/** Sign in with exactly the wallets shown beside the consent. Cancellable. */
export function signInToVexCloud(input: VexCloudSignInInput): AbortableInvocation<VexCloudSignInResult> {
  const bridge = vexCloudBridge();
  if (bridge === null) return { promise: Promise.resolve(BRIDGE_UNAVAILABLE), cancel: () => {} };
  return bridge.signIn(input);
}

export function signOutOfVexCloud(): Promise<Result<VexCloudSignOutResult>> {
  const bridge = vexCloudBridge();
  return bridge === null ? Promise.resolve(BRIDGE_UNAVAILABLE) : bridge.signOut();
}

/**
 * After a sign-in or sign-out: the account read and the provider setup state
 * (whose "configured" depends on the stored session) are both stale.
 */
export function useInvalidateVexCloudState(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: vexCloudKeys.all });
    void queryClient.invalidateQueries({ queryKey: onboardingKeys.envState() });
  };
}

// ── funding (phase 2) ────────────────────────────────────────────────────

/** How often an open withdrawal is re-read until it reaches a final word. */
const WITHDRAWAL_POLL_MS = 5_000;
/** How long the wallet balances on the Deposit tab stay fresh. */
const DEPOSIT_WALLETS_STALE_MS = 15_000;

function unavailableInvocation<T>(): AbortableInvocation<T> {
  return { promise: Promise.resolve(BRIDGE_UNAVAILABLE), cancel: () => {} };
}

/** The in-app EVM wallets with their live VEX balance; aborts the read when the query is dropped. */
export function useVexCloudDepositWallets(enabled: boolean): UseQueryResult<Result<VexCloudDepositWalletsResult>> {
  return useQuery(
    queryOptions({
      queryKey: vexCloudKeys.depositWallets(),
      queryFn: async ({ signal }) => {
        const bridge = vexCloudBridge();
        if (bridge === null) return BRIDGE_UNAVAILABLE;
        const invocation = bridge.depositWallets();
        signal.addEventListener("abort", invocation.cancel, { once: true });
        return invocation.promise;
      },
      enabled,
      staleTime: DEPOSIT_WALLETS_STALE_MS,
      retry: false,
    }),
  );
}

export function prepareVexCloudDeposit(input: VexCloudPrepareDepositInput): AbortableInvocation<VexCloudDepositProposal> {
  const bridge = vexCloudBridge();
  return bridge === null ? unavailableInvocation() : bridge.prepareDeposit(input);
}

export function submitVexCloudDeposit(input: VexCloudSubmitDepositInput): AbortableInvocation<VexCloudSubmitDepositResult> {
  const bridge = vexCloudBridge();
  return bridge === null ? unavailableInvocation() : bridge.submitDeposit(input);
}

export function prepareVexCloudWithdrawal(
  input: VexCloudPrepareWithdrawalInput,
): AbortableInvocation<VexCloudWithdrawalProposal> {
  const bridge = vexCloudBridge();
  return bridge === null ? unavailableInvocation() : bridge.prepareWithdrawal(input);
}

export function submitVexCloudWithdrawal(input: VexCloudSubmitWithdrawalInput): Promise<Result<VexCloudSubmitWithdrawalResult>> {
  const bridge = vexCloudBridge();
  return bridge === null ? Promise.resolve(BRIDGE_UNAVAILABLE) : bridge.submitWithdrawal(input);
}

export function claimVexCloudCashback(): Promise<Result<VexCloudClaimCashbackResult>> {
  const bridge = vexCloudBridge();
  return bridge === null ? Promise.resolve(BRIDGE_UNAVAILABLE) : bridge.claimCashback();
}

/** A withdrawal's status, polled until it reads Completed or Returned. */
export function useVexCloudWithdrawal(withdrawalId: string | null): UseQueryResult<Result<VexCloudSubmitWithdrawalResult>> {
  return useQuery(
    queryOptions({
      queryKey: vexCloudKeys.withdrawal(withdrawalId ?? ""),
      queryFn: async () => {
        const bridge = vexCloudBridge();
        if (bridge === null || withdrawalId === null) return BRIDGE_UNAVAILABLE;
        return bridge.withdrawal({ withdrawalId });
      },
      enabled: withdrawalId !== null,
      refetchInterval: (query) => {
        const data = query.state.data;
        if (data?.ok !== true) return WITHDRAWAL_POLL_MS;
        const word = withdrawalStatusWord(data.data.withdrawal.status);
        return word === "Completed" || word === "Returned" ? false : WITHDRAWAL_POLL_MS;
      },
      retry: false,
    }),
  );
}

type HistoryKind = "activity" | "usage" | "deposits";

/**
 * One history list, cursor-paginated. `hasNextPage` is true exactly when the
 * backend returned a `next_cursor`, so "Load more" never promises rows that
 * do not exist. A failed page stops the chain rather than skipping ahead.
 */
function useHistory<T extends { readonly nextCursor: string | null }>(
  kind: HistoryKind,
  read: (bridge: VexCloudBridge, cursor: string | null) => Promise<Result<T>>,
  enabled: boolean,
): UseInfiniteQueryResult<InfiniteData<Result<T>, string | null>> {
  return useInfiniteQuery({
    queryKey: vexCloudKeys.history(kind),
    queryFn: async ({ pageParam }): Promise<Result<T>> => {
      const bridge = vexCloudBridge();
      return bridge === null ? BRIDGE_UNAVAILABLE : read(bridge, pageParam);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => (lastPage.ok && lastPage.data.nextCursor !== null ? lastPage.data.nextCursor : undefined),
    enabled,
    retry: false,
  });
}

export function useVexCloudActivity(enabled: boolean): UseInfiniteQueryResult<InfiniteData<Result<VexCloudActivityResult>, string | null>> {
  return useHistory("activity", (bridge, cursor) => bridge.activity({ cursor }), enabled);
}

export function useVexCloudUsage(enabled: boolean): UseInfiniteQueryResult<InfiniteData<Result<VexCloudUsageResult>, string | null>> {
  return useHistory("usage", (bridge, cursor) => bridge.usage({ cursor }), enabled);
}

export function useVexCloudDeposits(enabled: boolean): UseInfiniteQueryResult<InfiniteData<Result<VexCloudDepositsResult>, string | null>> {
  return useHistory("deposits", (bridge, cursor) => bridge.deposits({ cursor }), enabled);
}

/** After a deposit, withdrawal or claim: the balance, the history and the wallet balances are stale. */
export function useInvalidateVexCloudFunding(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: vexCloudKeys.all });
  };
}
