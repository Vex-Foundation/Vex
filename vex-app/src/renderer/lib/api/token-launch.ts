/**
 * Token launch (C5-renderer) — the renderer half of the Trench Express launch
 * surface. TanStack Query hooks over the `vex:tokenLaunch:*` IPC contract.
 *
 * ── THE BOUNDARY LAW OF THIS FILE ─────────────────────────────────────────
 * The renderer holds no keys and never signs. It submits PARAMETERS ONLY and
 * receives an allow-listed DTO (contract C3): main — never this file — authors
 * the durable authorization record, binds the exact spend, and hands the engine
 * an opaque single-use id. Nothing here imports `src/tools/trench-express`
 * (`check:boundaries` rejects it), and no amount computed in this file is ever
 * sent back as an authorization input: `submit` carries a `previewId`, so the
 * figure main signs is the figure MAIN produced, not one the renderer echoed.
 *
 * ── ON THE STAND-IN TYPES BELOW ───────────────────────────────────────────
 * `@shared/schemas/token-launch.js` (Lane C) is not on disk yet. Per the plan's
 * §6 rule — "if a contract type is not yet on disk, define it locally and tell
 * the coordinator" — the shapes are declared here, kept VERBATIM to the settled
 * contract, and marked for deletion. When the shared schema lands: delete this
 * block, import the inferred types, and nothing else in this file changes.
 *
 * Two fields are OPTIONAL on purpose and it is not sloppiness. `vexFeeWei` /
 * `vexFeeCharged` (the §C7 25 bps disclosure) were still being reconciled
 * between lanes when this was written. The dialog discloses that fee ONLY when
 * the DTO carries the COMPUTED number; it never infers one from the rate. A fee
 * figure the renderer authored is precisely the fabrication rule 90 forbids —
 * so an absent field renders nothing rather than a plausible guess.
 *
 * ── ON THE BRIDGE ACCESSOR ────────────────────────────────────────────────
 * `window.vex.tokenLaunch` is wired by the coordinator (§4b owns
 * `preload/agent/index.ts` and the bridge types). Until that lands the member
 * does not exist on the typed bridge, so it is read through ONE contained,
 * documented boundary read. That is not a workaround bolted on to compile: a
 * missing bridge resolves to the `unavailable` rung of the states ladder, which
 * this surface is required to have anyway — the dialog says "this isn't
 * available right now" instead of showing an empty form that cannot deploy.
 */

import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import { tokenLaunchKeys } from "./queryKeys.js";

// ─────────────────────────────────────────────────────────────────────────
// STAND-IN CONTRACT TYPES — delete when `@shared/schemas/token-launch.js` lands
// ─────────────────────────────────────────────────────────────────────────

/** Field caps. Mirrored main-side; enforced here so the user sees the limit. */
export const LAUNCH_NAME_MAX = 64;
export const LAUNCH_SYMBOL_MAX = 16;
export const LAUNCH_DESCRIPTION_MAX = 512;
export const LAUNCH_LINK_MAX = 128;
export const LAUNCH_LINKS_MAX = 4;

/** The three origins stamped on a `token_launch_intents` row (contract C1). */
export type LaunchOrigin = "user" | "agent_requested_form" | "agent";

/** The parameters the renderer may send. No amount here is authorization. */
export interface TokenLaunchPreviewInput {
  readonly sessionId: string | null;
  readonly origin: LaunchOrigin;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly links: readonly string[];
  readonly imageId: string;
  /** Raw wei decimal string. `"0"` is the default and a real value. */
  readonly prebuyWei: string;
}

/**
 * The allow-listed preview DTO. EVERY amount is a raw wei DECIMAL STRING and
 * every component is SEPARATE — there is deliberately no merged "total" field,
 * and this type must never gain one. `msgValueWei` is the consent-bound figure;
 * `estimatedNetworkFeeWei` is an ESTIMATE and is never summed into it.
 */
export interface TokenLaunchPreview {
  /** Opaque, bound to the anchored block and the fee read there. Single-use. */
  readonly previewId: string;
  readonly chainId: number;
  readonly anchorBlockNumber: string;
  readonly creationFeeWei: string;
  readonly prebuyWei: string;
  /** === creationFeeWei + prebuyWei, exactly. THE authorized figure. */
  readonly msgValueWei: string;
  /**
   * The network-fee estimate, kept as its three separate truths rather than one
   * opaque number: the gas UNITS we bound, the price we assumed, and their
   * product. The dialog displays the product and labels it an estimate; the
   * other two exist so a surprising figure can be explained instead of trusted.
   * None of them is ever summed into the authorized figure.
   */
  readonly estimatedGasLimit: string;
  readonly estimatedGasPriceWei: string;
  readonly estimatedNetworkFeeWei: string;
  readonly predictedTokenAddress: string | null;
  readonly imageId: string;
  readonly expiresAt: string;
  /** §C7 — present only once the fee leg is authored main-side. See header. */
  readonly vexFeeWei?: string;
  readonly vexFeeCharged?: boolean;
}

export interface TokenLaunchSubmitInput {
  readonly sessionId: string | null;
  /** The exact preview the user looked at. Main re-checks it for drift. */
  readonly previewId: string;
}

export interface TokenLaunchSubmitResult {
  readonly intentId: string;
  readonly status: "broadcast_pending" | "confirmed";
  readonly txHash: string | null;
  readonly tokenAddress: string | null;
}

export interface TokenLaunchCancelInput {
  readonly intentId: string;
}

export interface TokenLaunchCancelResult {
  readonly intentId: string;
}

export interface MyLaunchRow {
  readonly intentId: string;
  readonly name: string;
  readonly symbol: string;
  readonly chainId: number;
  readonly tokenAddress: string | null;
  readonly txHash: string | null;
  readonly status: string;
  readonly createdAt: string;
}

export interface MyLaunchesInput {
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * `status` is the honesty discriminant that keeps `unavailable` distinct from
 * `empty` (the TokenHistory precedent). A degraded read must NEVER render as
 * "you have never launched a token" — that is a factual claim we cannot make.
 */
export interface MyLaunchesResult {
  readonly status: "available" | "unavailable";
  readonly launches: readonly MyLaunchRow[];
  readonly nextCursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Bridge access
// ─────────────────────────────────────────────────────────────────────────

interface TokenLaunchBridge {
  preview(input: TokenLaunchPreviewInput): Promise<Result<TokenLaunchPreview>>;
  submit(input: TokenLaunchSubmitInput): Promise<Result<TokenLaunchSubmitResult>>;
  cancel(input: TokenLaunchCancelInput): Promise<Result<TokenLaunchCancelResult>>;
  myLaunches(input: MyLaunchesInput): Promise<Result<MyLaunchesResult>>;
}

/**
 * The one contained boundary read (see the file header). `window.vex` is typed
 * without a `tokenLaunch` member until the coordinator wires the preload
 * domain, so the optional member is read through a single narrowing rather than
 * scattering casts through the hooks. Returns `null` — never throws — so an
 * unwired bridge becomes the `unavailable` state instead of a crashed dialog.
 */
function tokenLaunchBridge(): TokenLaunchBridge | null {
  const bridge = window.vex as unknown as {
    readonly tokenLaunch?: TokenLaunchBridge;
  };
  return bridge.tokenLaunch ?? null;
}

/** True once the launch IPC domain is mounted. Drives the `unavailable` rung. */
export function isTokenLaunchAvailable(): boolean {
  return tokenLaunchBridge() !== null;
}

/**
 * The synthetic result for an unmounted bridge. `internal.contract_violation`
 * is the honest existing code: the preload domain this file is written against
 * is not present, which is a broken contract on our side and never the user's
 * doing. It is deliberately NOT a `tokenLaunch.*` code — that namespace is
 * registered by the lane that owns the main handlers, and minting a code here
 * that `result-surface.test.ts` does not pin would be inventing surface.
 *
 * In practice the UI reaches the `unavailable` rung through
 * `isTokenLaunchAvailable()` before this value is ever rendered; it exists so
 * the hooks always resolve to a `Result` instead of throwing.
 */
const BRIDGE_UNAVAILABLE: Result<never> = {
  ok: false,
  error: {
    code: "internal.contract_violation",
    domain: "system",
    message: "Launching isn't available in this build yet.",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId: "renderer-local",
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────

/**
 * The preview is the ARMING step: Deploy stays disabled until it resolves,
 * because the number the click authorizes has to be on screen at the click.
 *
 * `staleTime: 0` and no refetch-on-focus are both deliberate. A preview is
 * anchored to a block and expires; silently swapping it under a user who is
 * mid-read would change the authorized figure without a fresh look, which is
 * the exact drift the re-review state exists to prevent. Re-arming is always an
 * explicit act.
 */
export function useLaunchPreview(
  input: TokenLaunchPreviewInput | null,
): UseQueryResult<Result<TokenLaunchPreview>> {
  return useQuery(
    queryOptions({
      queryKey: tokenLaunchKeys.preview(input),
      queryFn: async () => {
        const bridge = tokenLaunchBridge();
        if (bridge === null || input === null) return BRIDGE_UNAVAILABLE;
        return bridge.preview(input);
      },
      enabled: input !== null && isTokenLaunchAvailable(),
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: false,
    }),
  );
}

/**
 * Deploy. This mutation is the spend-consent (owner decision D3), so it carries
 * NO amounts — only the `previewId` of the figures the user was shown. There is
 * deliberately no retry: a resubmit could double-spend, and an ambiguous
 * broadcast is main's to reconcile, never the renderer's to guess at.
 */
export function useSubmitLaunch(): UseMutationResult<
  Result<TokenLaunchSubmitResult>,
  Error,
  TokenLaunchSubmitInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input: TokenLaunchSubmitInput) => {
      const bridge = tokenLaunchBridge();
      if (bridge === null) return BRIDGE_UNAVAILABLE;
      return bridge.submit(input);
    },
    onSuccess: (result) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: tokenLaunchKeys.myLaunches() });
    },
  });
}

/**
 * Closing the dialog on a draft cancels the intent (§C6: pre-consent states
 * only, `awaiting_user_form → cancelled`). For an `agent_requested_form` intent
 * this is what resumes the agent's turn with an honest "dismissed" result
 * instead of leaving it hanging — so a cancel is a real message, not a no-op.
 */
export function useCancelLaunch(): UseMutationResult<
  Result<TokenLaunchCancelResult>,
  Error,
  TokenLaunchCancelInput
> {
  return useMutation({
    retry: false,
    mutationFn: async (input: TokenLaunchCancelInput) => {
      const bridge = tokenLaunchBridge();
      if (bridge === null) return BRIDGE_UNAVAILABLE;
      return bridge.cancel(input);
    },
  });
}

const MY_LAUNCHES_PAGE_SIZE = 10;

/**
 * The user's own launches. Paginated through the shared "Load more" affordance.
 * `getNextPageParam` stops on a failed OR `unavailable` page so a degraded read
 * halts pagination rather than looping — and the already-rendered rows stay on
 * screen (the TokenHistory precedent: a later page failing never wipes a list).
 */
export function useMyLaunches(): UseInfiniteQueryResult<
  { pages: Array<Result<MyLaunchesResult>> },
  Error
> {
  return useInfiniteQuery({
    queryKey: tokenLaunchKeys.myLaunches(),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const bridge = tokenLaunchBridge();
      if (bridge === null) return BRIDGE_UNAVAILABLE;
      return bridge.myLaunches({ cursor: pageParam, limit: MY_LAUNCHES_PAGE_SIZE });
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage.ok || lastPage.data.status !== "available") return undefined;
      return lastPage.data.nextCursor ?? undefined;
    },
    enabled: isTokenLaunchAvailable(),
    retry: false,
  });
}
