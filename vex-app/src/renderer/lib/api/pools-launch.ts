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
 * Deliberately NOT hooks. The two-stage lane drives `prepare` and `deploy`
 * imperatively from its own state machine — a background-refetching query is
 * exactly the shape this launchpad must not have, because a fingerprint that
 * refreshed itself under the user would break the promise that Deploy authorizes
 * what is on screen.
 */

import type { Result } from "@shared/ipc/result.js";
import type {
  PoolsClaimInput,
  PoolsClaimedFees,
  PoolsClaimPreview,
  PoolsDeployedLaunch,
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
