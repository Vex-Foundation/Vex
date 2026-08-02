/**
 * Token launch (C5-renderer) — the renderer half of the Trench Express launch
 * surface. TanStack Query hooks over the `vex:tokenLaunch:*` IPC contract.
 *
 * ── THE BOUNDARY LAW OF THIS FILE ─────────────────────────────────────────
 * The renderer holds no keys and never signs. It submits the FORM the user
 * filled plus the opaque `previewId` it was handed, and receives an allow-listed
 * DTO: MAIN — never this file — reads the creation fee, converts the typed
 * prebuy to wei, composes `msg.value`, and authors the durable authorization
 * record. Nothing here imports `src/tools/trench-express` (`check:boundaries`
 * rejects it), and no amount is ever COMPUTED on this side: a decimals slip in
 * the UI is a thousandfold spend error, so the conversion lives exactly once,
 * main-side.
 *
 * ── ONE CONTRACT, NOT TWO ─────────────────────────────────────────────────
 * Every request and reply type here is the inferred type of the shared zod
 * schema in `@shared/schemas/token-launch.js`, which is the same schema
 * `main/ipc/token-launch.ts` validates with. This file previously carried
 * hand-written stand-ins of that contract; they had already drifted from it
 * (`{sessionId, form}` vs a flattened parameter bag, a required vs optional Vex
 * fee, a cursor the main handler never returns), and a renderer that type-checks
 * against a contract main does not implement is a runtime failure with a green
 * build. There is deliberately no local re-declaration of a wire shape below.
 *
 * ── ON THE BRIDGE ACCESSOR ────────────────────────────────────────────────
 * `window.vex.tokenLaunch` is the preload domain in
 * `preload/agent/token-launch.ts`, typed by `TokenLaunchBridge`. There is no
 * cast: this file consumes the same interface the preload object `satisfies`.
 * The accessor still tolerates its ABSENCE at runtime, because a preload older
 * than this domain has no such member whatever the type says — that resolves to
 * the `unavailable` rung of the states ladder, which this surface is required to
 * have anyway.
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  TokenLaunchCancelInput,
  TokenLaunchCancelResult,
  TokenLaunchMyLaunchesInput,
  TokenLaunchMyLaunchesResult,
  TokenLaunchPreviewInput,
  TokenLaunchPreviewResult,
  TokenLaunchSubmitInput,
  TokenLaunchSubmitResult,
} from "@shared/schemas/token-launch.js";
import type { TokenLaunchBridge } from "@shared/types/bridge/agent/token-launch.js";
import { tokenLaunchKeys } from "./queryKeys.js";

export type {
  LaunchedTokenDto,
  TokenLaunchCancelInput,
  TokenLaunchCancelResult,
  TokenLaunchForm,
  TokenLaunchMyLaunchesResult,
  TokenLaunchPreviewInput,
  TokenLaunchPreviewResult,
  TokenLaunchSubmitInput,
  TokenLaunchSubmitResult,
} from "@shared/schemas/token-launch.js";

/**
 * Field caps, re-exported under the names this feature already uses so the
 * counters in the form and the schema main validates with can never disagree.
 */
export {
  TOKEN_LAUNCH_NAME_MAX as LAUNCH_NAME_MAX,
  TOKEN_LAUNCH_SYMBOL_MAX as LAUNCH_SYMBOL_MAX,
  TOKEN_LAUNCH_DESCRIPTION_MAX as LAUNCH_DESCRIPTION_MAX,
  TOKEN_LAUNCH_LINKS_MAX as LAUNCH_LINKS_MAX,
} from "@shared/schemas/token-launch.js";

/**
 * The per-link character cap. The shared schema states it inline
 * (`z.string().url().startsWith("https://").max(128)`) rather than as a named
 * export, so it is mirrored here for the field's `maxLength` and re-checked
 * main-side by that schema. A drift makes the form accept a link main refuses —
 * a refusal, never a spend.
 */
export const LAUNCH_LINK_MAX = 128;

/**
 * Which of the three C1 origins opened the dialog. A RENDERER-side concept, not
 * a wire field: it decides whether dismissing the dialog owes an agent an
 * answer. The IPC contract deliberately has no origin — main stamps it.
 */
export type LaunchOrigin = "user" | "agent_requested_form" | "agent";

// ─────────────────────────────────────────────────────────────────────────
// Bridge access
// ─────────────────────────────────────────────────────────────────────────

/**
 * The one contained boundary read (see the file header). The member is now part
 * of the typed bridge (`shared/types/bridge/agent/token-launch.ts`), so there is
 * no cast here any more — but the `?? null` is NOT redundant: `window.vex` is
 * built by whatever preload the running app actually loaded, and a build whose
 * preload predates this domain has no `tokenLaunch` at runtime however the type
 * reads. That case resolves to the `unavailable` rung — the dialog says "this
 * isn't available right now" — instead of a TypeError inside a hook.
 */
function tokenLaunchBridge(): TokenLaunchBridge | null {
  return window.vex.tokenLaunch ?? null;
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
): UseQueryResult<Result<TokenLaunchPreviewResult>> {
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
 * Deploy. This mutation is the spend-consent (owner decision D3). It carries the
 * form and the `previewId` of the figures the user was shown, and NO computed
 * amount: the prebuy travels as the plain decimal the user typed and main is the
 * only side that turns it into wei or into `msg.value`. There is
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

const MY_LAUNCHES_PAGE_SIZE = 25;

/**
 * The user's own launches. ONE page: the IPC contract returns a bounded list
 * and no cursor, so there is nothing to paginate and a "Load more" affordance
 * here would be an invitation main cannot honour.
 *
 * A failed or unmounted read is NOT an empty read — the block renders those as
 * separate rungs (the TokenHistory precedent), because "you have never launched
 * a token" is a factual claim we cannot make from a degraded read.
 */
export function useMyLaunches(): UseQueryResult<Result<TokenLaunchMyLaunchesResult>> {
  return useQuery(
    queryOptions({
      queryKey: tokenLaunchKeys.myLaunches(),
      queryFn: async () => {
        const bridge = tokenLaunchBridge();
        if (bridge === null) return BRIDGE_UNAVAILABLE;
        return bridge.myLaunches({ limit: MY_LAUNCHES_PAGE_SIZE });
      },
      enabled: isTokenLaunchAvailable(),
      retry: false,
    }),
  );
}
