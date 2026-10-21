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
import type { Result, VexError } from "@shared/ipc/result.js";
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
  type VexCloudWithdrawalStatusResult,
} from "@shared/schemas/vex-cloud-funding.js";
import type {
  VexCloudAlert,
  VexCloudAutoTopUpGetResult,
  VexCloudAutoTopUpProposal,
  VexCloudPrepareAutoTopUpInput,
  VexCloudSubmitAutoTopUpInput,
  VexCloudSubmitAutoTopUpResult,
} from "@shared/schemas/vex-cloud-auto-top-up.js";
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
    message: "Vex Inference isn't available in this build yet.",
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
export function useVexCloudWithdrawal(withdrawalId: string | null): UseQueryResult<Result<VexCloudWithdrawalStatusResult>> {
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
 * A history page main refused or could not read, THROWN rather than stored as
 * a page: a failed page appended to the list would end the chain (no next
 * cursor) and the foot would read "Showing all N" over a list that is not
 * complete. Thrown, the query keeps every page that loaded, `hasNextPage`
 * still comes from the last SUCCESSFUL page, and fetching the next page again
 * retries the very cursor that failed.
 */
export class HistoryPageError extends Error {
  constructor(readonly error: VexError) {
    super(error.message);
    this.name = "HistoryPageError";
  }
}

export type HistoryQuery<T> = UseInfiniteQueryResult<InfiniteData<T, string | null>, HistoryPageError>;

/**
 * One history list, cursor-paginated. `hasNextPage` is true exactly when the
 * last page that loaded returned a `nextCursor`, so "Load more" never
 * promises rows that do not exist, and a failed page never reads as the end.
 */
function useHistory<T extends { readonly nextCursor: string | null }>(
  kind: HistoryKind,
  read: (bridge: VexCloudBridge, cursor: string | null) => Promise<Result<T>>,
  enabled: boolean,
): HistoryQuery<T> {
  return useInfiniteQuery<T, HistoryPageError, InfiniteData<T, string | null>, ReturnType<typeof vexCloudKeys.history>, string | null>({
    queryKey: vexCloudKeys.history(kind),
    queryFn: async ({ pageParam }): Promise<T> => {
      const bridge = vexCloudBridge();
      const result = bridge === null ? BRIDGE_UNAVAILABLE : await read(bridge, pageParam);
      if (!result.ok) throw new HistoryPageError(result.error);
      return result.data;
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    retry: false,
  });
}

export function useVexCloudActivity(enabled: boolean): HistoryQuery<VexCloudActivityResult> {
  return useHistory("activity", (bridge, cursor) => bridge.activity({ cursor }), enabled);
}

export function useVexCloudUsage(enabled: boolean): HistoryQuery<VexCloudUsageResult> {
  return useHistory("usage", (bridge, cursor) => bridge.usage({ cursor }), enabled);
}

export function useVexCloudDeposits(enabled: boolean): HistoryQuery<VexCloudDepositsResult> {
  return useHistory("deposits", (bridge, cursor) => bridge.deposits({ cursor }), enabled);
}

/** After a deposit, withdrawal or claim: the balance, the history and the wallet balances are stale. */
export function useInvalidateVexCloudFunding(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: vexCloudKeys.all });
  };
}

// ── low-balance alert and auto top-up ────────────────────────────────────

/** The alert percent and the last balance observation. A read; the setter is a plain call. */
export function useVexCloudAlert(enabled: boolean): UseQueryResult<Result<VexCloudAlert>> {
  return useQuery(
    queryOptions({
      queryKey: vexCloudKeys.alert(),
      queryFn: async () => {
        const bridge = vexCloudBridge();
        return bridge === null ? BRIDGE_UNAVAILABLE : bridge.alertGet();
      },
      enabled,
      refetchInterval: ACCOUNT_POLL_MS,
      retry: false,
    }),
  );
}

export function setVexCloudAlertPercent(alertPercent: number): Promise<Result<VexCloudAlert>> {
  const bridge = vexCloudBridge();
  return bridge === null ? Promise.resolve(BRIDGE_UNAVAILABLE) : bridge.alertSet({ alertPercent });
}

/** The live auto top-up rule; aborts the read when the query is dropped. */
export function useVexCloudAutoTopUp(enabled: boolean): UseQueryResult<Result<VexCloudAutoTopUpGetResult>> {
  return useQuery(
    queryOptions({
      queryKey: vexCloudKeys.autoTopUp(),
      queryFn: async ({ signal }) => {
        const bridge = vexCloudBridge();
        if (bridge === null) return BRIDGE_UNAVAILABLE;
        const invocation = bridge.autoTopUpGet();
        signal.addEventListener("abort", invocation.cancel, { once: true });
        return invocation.promise;
      },
      enabled,
      refetchInterval: ACCOUNT_POLL_MS,
      retry: false,
    }),
  );
}

/** Mint a rule-change proposal. A plain call a button drives, never a query. */
export function prepareVexCloudAutoTopUp(input: VexCloudPrepareAutoTopUpInput): AbortableInvocation<VexCloudAutoTopUpProposal> {
  const bridge = vexCloudBridge();
  return bridge === null ? unavailableInvocation() : bridge.prepareAutoTopUp(input);
}

/** Apply the approved rule change. A plain call the card's approve key drives. */
export function submitVexCloudAutoTopUp(input: VexCloudSubmitAutoTopUpInput): Promise<Result<VexCloudSubmitAutoTopUpResult>> {
  const bridge = vexCloudBridge();
  return bridge === null ? Promise.resolve(BRIDGE_UNAVAILABLE) : bridge.submitAutoTopUp(input);
}
