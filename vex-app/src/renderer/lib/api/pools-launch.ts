/**
 * pools.fun launch (P3-renderer) — the renderer half of the `vex:poolsLaunch:*`
 * IPC contract.
 *
 * ── THE BOUNDARY LAW OF THIS FILE ─────────────────────────────────────────
 * The renderer holds no keys and never signs. It sends the LOGICAL form the user
 * filled and, at stage 2, only the opaque `fingerprintId` it was handed. MAIN
 * reads the gateway's dynamic deployment fee, converts the typed prebuy against
 * on-chain decimals, composes `msg.value`, runs the calldata verifier and takes
 * the authorization. No amount is ever COMPUTED here: a decimals slip in the UI
 * is a thousandfold spend error, so the conversion lives exactly once, main-side.
 *
 * ── ONE CONTRACT, NOT TWO ─────────────────────────────────────────────────
 * Every request and reply type is the inferred type of the shared zod schema in
 * `@shared/schemas/pools-launch.js` — the same schema `main/ipc/pools-launch.ts`
 * validates with. There is deliberately no local re-declaration of a wire shape:
 * a renderer that type-checks against a contract main does not implement is a
 * runtime failure with a green build.
 *
 * THE TWO-STAGE CALLS ARE DELIBERATELY NOT HOOKS. The lane drives `prepare` and
 * `deploy` imperatively from its own state machine - a background-refetching
 * query is exactly the shape this launchpad must not have, because a fingerprint
 * that refreshed itself under the user would break the promise that Deploy
 * authorizes what is on screen.
 *
 * THE AWAITING-FORM READ IS THE ONE EXCEPTION, and it is not a money surface:
 * it answers "has an agent drafted a launch for this session?" and nothing more.
 * It is a poll plus a push, so it is a query. It moved here from the retired
 * `token-launch.ts` adapter with the rest of the launch lane (migration 108).
 */

import { useEffect } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { Result } from "@shared/ipc/result.js";
import type {
  PoolsAwaitingFormCancelResult,
  PoolsClaimInput,
  PoolsClaimedFees,
  PoolsClaimPreview,
  PoolsDeployedLaunch,
  PoolsLaunchCancelAwaitingFormInput,
  PoolsLaunchCancelInput,
  PoolsLaunchCancelResult,
  PoolsLaunchDeployInput,
  PoolsLaunchGetAwaitingInput,
  PoolsLaunchGetAwaitingResult,
  PoolsLaunchMyLaunchesInput,
  PoolsLaunchMyLaunchesResult,
  PoolsLaunchPrepareInput,
  PoolsPreparedLaunch,
} from "@shared/schemas/pools-launch.js";
import type { PoolsLaunchBridge } from "@shared/types/bridge/agent/pools-launch.js";
import { poolsLaunchKeys } from "./queryKeys.js";

/**
 * The preload domain, or `null`.
 *
 * The `?? null` is NOT redundant: `window.vex` is built by whatever preload the
 * running app actually loaded, and a build whose preload predates this domain
 * has no `poolsLaunch` at runtime however the type reads. That resolves to the
 * lane's honest "not available" state instead of a TypeError.
 */
function poolsLaunchBridge(): PoolsLaunchBridge | null {
  return window.vex.poolsLaunch ?? null;
}

/** True once the pools.fun launch IPC domain is mounted. */
export function isPoolsLaunchAvailable(): boolean {
  return poolsLaunchBridge() !== null;
}

/**
 * The synthetic result for an unmounted bridge. `internal.contract_violation`
 * is the honest existing code: the preload domain this file is written against
 * is not present, which is a broken contract on our side and never the user's
 * doing.
 */
const BRIDGE_UNAVAILABLE: Result<never> = {
  ok: false,
  error: {
    code: "internal.contract_violation",
    domain: "system",
    message: "Launching on pools.fun isn't available in this build yet.",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId: "renderer-local",
  },
};

async function call<T>(
  run: (bridge: PoolsLaunchBridge) => Promise<Result<T>>,
): Promise<Result<T>> {
  const bridge = poolsLaunchBridge();
  if (bridge === null) return BRIDGE_UNAVAILABLE;
  return run(bridge);
}

/** STAGE 1: prepare and verify. Signs nothing, spends nothing. */
export function preparePoolsLaunch(
  input: PoolsLaunchPrepareInput,
): Promise<Result<PoolsPreparedLaunch>> {
  return call((bridge) => bridge.prepare(input));
}

/** STAGE 2: authorize exactly the fingerprint stage 1 returned. */
export function deployPoolsLaunch(
  input: PoolsLaunchDeployInput,
): Promise<Result<PoolsDeployedLaunch>> {
  return call((bridge) => bridge.deploy(input));
}

export function cancelPoolsLaunch(
  input: PoolsLaunchCancelInput,
): Promise<Result<PoolsLaunchCancelResult>> {
  return call((bridge) => bridge.cancel(input));
}

/**
 * THE DISMISSAL of an agent-requested form: end the draft and wake the turn.
 *
 * Deliberately NOT `cancelPoolsLaunch` above, which takes a `fingerprintId` and
 * ends a PREPARED launch. This one takes the `intentId` the awaiting read
 * handed over, and is the only launch call that answers a parked agent.
 *
 * Fire-and-forget at the call site by design: the dialog must close on the
 * user's click rather than behind a round-trip, and main owns the row either
 * way. What comes back is what happened, for the log - `cancelled: false` is a
 * success meaning the form was answered in the same instant.
 */
export function cancelAwaitingPoolsLaunchForm(
  input: PoolsLaunchCancelAwaitingFormInput,
): Promise<Result<PoolsAwaitingFormCancelResult>> {
  return call((bridge) => bridge.cancelAwaitingForm(input));
}

export function listPoolsMyLaunches(
  input: PoolsLaunchMyLaunchesInput,
): Promise<Result<PoolsLaunchMyLaunchesResult>> {
  return call((bridge) => bridge.myLaunches(input));
}

export function getAwaitingPoolsLaunchForm(
  input: PoolsLaunchGetAwaitingInput,
): Promise<Result<PoolsLaunchGetAwaitingResult>> {
  return call((bridge) => bridge.getAwaiting(input));
}

export function previewPoolsClaim(
  input: PoolsClaimInput,
): Promise<Result<PoolsClaimPreview>> {
  return call((bridge) => bridge.claimPreview(input));
}

export function claimPoolsFees(
  input: PoolsClaimInput,
): Promise<Result<PoolsClaimedFees>> {
  return call((bridge) => bridge.claim(input));
}

// ─────────────────────────────────────────────────────────────────────────
// The agent-requested form (C3b): a poll and a push over ONE query key
// ─────────────────────────────────────────────────────────────────────────

/**
 * The fallback poll's cadence. The push below is the primary signal; this only
 * has to catch a DROPPED event, so it is deliberately slow.
 */
const AWAITING_POLL_MS = 30_000;

/**
 * The form an agent drafted for this session, or `null` when none is waiting.
 *
 * READ-ONLY and NOT a spend surface: it returns what the agent PROPOSED so the
 * dialog can prefill. Stage 1 still has to be asked for explicitly and Deploy is
 * still armed only by a verified fingerprint main produced, so a prefilled form
 * shortens the typing and never the authorization.
 *
 * `null` data is the ordinary idle answer, not an error.
 */
export function useAwaitingPoolsLaunchForm(
  sessionId: string | null,
): UseQueryResult<Result<PoolsLaunchGetAwaitingResult>> {
  return useQuery(
    queryOptions({
      queryKey: poolsLaunchKeys.awaiting(sessionId),
      queryFn: async () => {
        const bridge = poolsLaunchBridge();
        if (bridge === null || sessionId === null) return BRIDGE_UNAVAILABLE;
        return bridge.getAwaiting({ sessionId });
      },
      enabled: sessionId !== null && isPoolsLaunchAvailable(),
      refetchInterval: AWAITING_POLL_MS,
      retry: false,
    }),
  );
}

/**
 * Push half of the C3b pair: invalidate the awaiting read the moment main says
 * an agent drafted a form.
 *
 * SESSION-SCOPED ON PURPOSE, and this is the opposite choice from
 * `useGlobalApprovalsLiveSync`. An approval inbox is a global badge that must
 * surface background sessions; this drives a MODAL that takes over the screen,
 * and popping a spend-consent dialog for a session the user is not looking at
 * would interrupt them about a conversation they did not open. Foreign-session
 * events are dropped here rather than filtered downstream so the query key and
 * the filter can never disagree.
 *
 * The event carries ids only - nothing is reconstructed from it. It invalidates,
 * and the database answers.
 */
export function usePoolsLaunchFormLiveSync(sessionId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const bridge = poolsLaunchBridge();
    if (bridge === null || sessionId === null) return;
    const off = bridge.onFormRequested((event) => {
      if (event.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: poolsLaunchKeys.awaiting(sessionId),
      });
    });
    return () => {
      off();
    };
  }, [queryClient, sessionId]);
}
