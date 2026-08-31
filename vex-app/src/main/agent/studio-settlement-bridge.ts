/**
 * Engine -> Vex Studio broker settlement bridge.
 *
 * Subscribes to the in-process `studioSettlementBus`
 * (`src/vex-agent/engine/runtime/studio-settlement-bus.ts`) and releases the
 * blocked MCP call that was waiting on the settled approval.
 *
 * Sibling of `mission-update-bridge.ts` in shape and in import discipline: the
 * bus is imported DIRECTLY from its module rather than through the engine
 * barrel, which would pull the database client into the main-process graph at
 * bridge-setup time.
 *
 * It differs in destination, which is why it is a separate bridge and not
 * another kind on the mission bus: nothing here reaches a renderer window.
 * These ids belong to an external coding agent's request, and broadcasting them
 * would put Studio state into every window for no reader.
 *
 * ## THE READINESS BARRIER this bridge owns at setup time
 *
 * Setup starts an initialization whose completion is awaited by main
 * (`awaitStudioRuntimeReady`), in this order and for these reasons:
 *
 *   0. THE PREFLIGHT REGISTRY IS SET TO DENY, SYNCHRONOUSLY, before any of
 *      this runs. It is an import-free engine module for exactly that reason,
 *      so the window in which the engine's default-ALLOW applied to a process
 *      that HAS a main is closed at setup rather than whenever an async
 *      registration happened to land.
 *   1. THE DISPATCH PREFLIGHT is registered. The engine cannot see whether a
 *      lock's durable generation advance actually committed; only the main
 *      process, which tried it, can. The predicate is registered FIRST because
 *      the engine's default with nothing registered is ALLOW, and it refuses
 *      everything until step 3 - so from the moment it exists, no Studio
 *      dispatch can slip through this window. A registration that FAILS leaves
 *      Studio unready for good (fail closed), with a bounded retry.
 *   2. THE ABANDONED-DISPATCH RECONCILER runs, in bounded pages. A Studio row
 *      left `dispatching` belongs to a process that died holding it, and
 *      process start is the one moment at which that is provable - which is
 *      exactly why nothing may dispatch while it runs: a fresh `dispatching`
 *      row started during the scan is indistinguishable from an abandoned one.
 *      Its rows are announced through the SAME committed-row path every other
 *      settlement takes.
 *   3. Only then is Studio marked READY.
 *
 * Teardown registers a DENY predicate rather than removing the preflight, and
 * does it SYNCHRONOUSLY. The engine's default-ALLOW belongs to a headless
 * engine that never had a main process; restoring it on a shutting-down main
 * would open the fence at the worst possible moment.
 *
 * Teardown also cancels the owned retry timer and invalidates the readiness
 * EPOCH, so a retry already in flight cannot mark a shutting-down process
 * ready, and stops the engine's terminal-write repair owner.
 *
 * ## The event is a SIGNAL, the row is the truth
 *
 * The bus payload carries ids and one enum, deliberately. This bridge reads the
 * intent row by id and hands THAT to the waiter, so the agent's answer is
 * always committed state. An event for a row that has vanished, or for an
 * approval nobody is waiting on, is dropped: both are normal (a decision made
 * from the Vex UI with no MCP call outstanding is the common case).
 */

import { studioSettlementBus } from "@vex-agent/engine/runtime/studio-settlement-bus.js";
import { setStudioDispatchPreflight } from "@vex-agent/engine/core/approval-runtime/studio/dispatch-preflight.js";
import {
  setStudioProjectLeaseAcquirer,
  type StudioProjectDispatchLease,
} from "@vex-agent/engine/core/approval-runtime/studio/project-lease-registry.js";
import { log } from "../logger/index.js";
import {
  isSecretSessionUnlocked,
  isStudioDispatchPoisoned,
  isStudioSessionTransitionInProgress,
} from "../secrets/session.js";
import { settleStudioWaiter } from "../studio/approval-broker.js";
import { acquireProjectLease } from "../studio/project-lifecycle-gate.js";
import { repairPendingStudioRefusal } from "../studio/approval-refusals.js";
import { trashItemToOsTrash } from "../studio/os-trash.js";
import { repairUnfinishedProjectCleanups } from "../studio/project-delete.js";
import {
  beginStudioReadinessEpoch,
  isStudioRuntimeReady,
  markStudioFenceUninitialized,
  markStudioRuntimeReady,
  markStudioRuntimeShuttingDown,
} from "../studio/readiness.js";

/**
 * DENY, as a value rather than a lambda per call site, so the predicate this
 * bridge installs before and after its lifecycle is provably the same one.
 */
const DENY_DISPATCH = (): boolean => false;

/**
 * Main's `dispatch` lease acquirer, handed to the engine's registry.
 *
 * The engine owns the approved-dispatch path but cannot import the lifecycle
 * gate (main's property, and a headless engine has no delete to race). This is
 * the whole adapter: one synchronous acquisition, translated to the registry's
 * `lease | null` contract. `null` is accounting, never a refusal to dispatch -
 * see `project-lease-registry.ts` and the gate's own header on why the gate is
 * not consulted for authority anywhere.
 */
function acquireStudioDispatchLease(
  projectId: string,
): StudioProjectDispatchLease | null {
  const outcome = acquireProjectLease(projectId, "dispatch");
  return outcome.ok ? outcome.lease : null;
}

/**
 * Subscribe the settlement bus to the broker. Returns the teardown - the caller
 * pushes it into `globalCleanup` through `setupAgentBridges`.
 */
export function setupStudioSettlementBridge(): () => void {
  // THE SYNCHRONOUS DENY, FIRST, before anything that can fail or await.
  //
  // The engine's default with nothing registered is ALLOW, which belongs to a
  // headless engine that never had a main process. From the moment THIS process
  // exists, that default is wrong - and it used to stay in place for the whole
  // of an asynchronous registration, and for the whole session when that
  // registration failed. The registry is an import-free module precisely so
  // this line can be a plain static call: after it returns, no Studio dispatch
  // can be admitted by an absent predicate, whatever happens next.
  setStudioDispatchPreflight(DENY_DISPATCH);

  // Registered SYNCHRONOUSLY alongside the deny, for the same reason: an
  // acquirer installed after an await leaves a window in which an approved
  // dispatch runs uncounted, and an uncounted dispatch is one a concurrent
  // delete's drain does not wait for.
  setStudioProjectLeaseAcquirer(acquireStudioDispatchLease);

  const off = studioSettlementBus.subscribe((event) => {
    void releaseWaiter(event.approvalId);
  });

  // The token every transition of THIS initialization must present. A retry
  // that outlives the teardown below holds a stale one and cannot move the flag.
  const epoch = beginStudioReadinessEpoch();
  readyBarrier = initializeStudioRuntime(epoch);

  return () => {
    off();
    readyBarrier = null;
    // Cancel the owned retry BEFORE invalidating the epoch, so the timer is
    // gone rather than merely neutered, and idempotently: a second teardown
    // clears nothing and logs nothing.
    cancelDispatchPreflightRetry();
    markStudioRuntimeShuttingDown();
    // Synchronous, for the same reason as the deny at setup: a teardown that
    // waited on a dynamic import would leave the previous predicate live across
    // the window in which the process is shutting down.
    setStudioDispatchPreflight(DENY_DISPATCH);
    // Cleared, not left installed: the gate is process-local state belonging to
    // a main that is going away, and an engine that outlived it must fall back
    // to its headless default rather than keep counting into a dead map.
    setStudioProjectLeaseAcquirer(null);
    void disposeStudioWriteRepairOwner();
  };
}

/**
 * The barrier main awaits before it opens a window. `null` means setup has not
 * run, which in main only happens in tests; those callers get an immediately
 * resolved promise and a Studio that is still unready, which is the safe
 * answer.
 */
let readyBarrier: Promise<void> | null = null;

/**
 * Wait for the barrier, BOUNDED.
 *
 * The bound is not a shortcut around the safety property: it is main's own
 * deadline for opening a window. If the barrier is still running when it
 * elapses, boot continues and Studio stays UNREADY, which the registered
 * preflight enforces durably on every dispatch and `runStudioCall` enforces on
 * every enqueue. The barrier keeps running and opens Studio when it finishes.
 * Without the bound, a database that is slow to answer would hold the whole
 * application at a blank screen.
 */
export async function awaitStudioRuntimeReady(
  timeoutMs = STUDIO_BARRIER_TIMEOUT_MS,
): Promise<void> {
  if (readyBarrier === null) return;
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn(
        "[agent:studio-settlement-bridge] readiness barrier still running at "
          + "the boot deadline; Vex Studio stays unavailable until it finishes",
      );
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([readyBarrier, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const STUDIO_BARRIER_TIMEOUT_MS = 15_000;

/**
 * Register the fence, reconcile, then open Studio. The whole sequence is
 * best-effort in the sense that it never throws at its caller - main must boot
 * regardless - but every failure leaves Studio CLOSED rather than open.
 */
async function initializeStudioRuntime(epoch: number): Promise<void> {
  const registered = await registerDispatchPreflight();
  if (!registered) {
    markStudioFenceUninitialized(epoch);
    scheduleDispatchPreflightRetry(epoch);
    return;
  }
  if (!(await repairPendingStudioRefusal())) {
    markStudioFenceUninitialized(epoch);
    scheduleDispatchPreflightRetry(epoch);
    return;
  }
  await reconcileAbandonedDispatches();
  markStudioRuntimeReady(epoch);
  log.info("[agent:studio-settlement-bridge] studio runtime ready");

  // B0: finish any project cleanup a previous run did not. Deliberately AFTER
  // the barrier opens and deliberately NOT awaited into readiness: an
  // unfinished cleanup is a durable obligation on a project that is already
  // gone, so it must never be able to hold Studio closed. Its own failures are
  // recorded on the row and retried by the next start or by the user.
  void repairUnfinishedProjectCleanups({ trashItem: trashItemToOsTrash }).catch(
    (cause: unknown) => {
      log.warn(
        "[agent:studio-settlement-bridge] project cleanup repair failed",
        cause,
      );
    },
  );
}

/**
 * The registration retry. It exists because a failed dynamic import is
 * typically transient, and the alternative is a Studio that stays closed for
 * the whole session. Bounded, and it stops at the first success; a teardown
 * clears it through the same `readyBarrier` reset that stops the barrier.
 */
const PREFLIGHT_RETRY_MS = 5_000;
const PREFLIGHT_RETRY_ATTEMPTS = 3;

/**
 * The ONE outstanding retry timer, and its owner is this module. Held in a
 * module binding rather than a closure so teardown can actually CANCEL it: a
 * timer only guarded by a flag still fires, still runs its body, and still
 * costs a database round trip on a process that is going away.
 */
let preflightRetryTimer: NodeJS.Timeout | null = null;

function cancelDispatchPreflightRetry(): void {
  if (preflightRetryTimer === null) return;
  clearTimeout(preflightRetryTimer);
  preflightRetryTimer = null;
}

function scheduleDispatchPreflightRetry(epoch: number, attempt = 1): void {
  if (attempt > PREFLIGHT_RETRY_ATTEMPTS) {
    log.error(
      "[agent:studio-settlement-bridge] preflight registration gave up; "
        + "Vex Studio stays unavailable this session",
    );
    return;
  }
  cancelDispatchPreflightRetry();
  const timer = setTimeout(() => {
    preflightRetryTimer = null;
    void (async () => {
      if (readyBarrier === null) return;
      if (await registerDispatchPreflight()) {
        if (!(await repairPendingStudioRefusal())) {
          markStudioFenceUninitialized(epoch);
          scheduleDispatchPreflightRetry(epoch, attempt + 1);
          return;
        }
        await reconcileAbandonedDispatches();
        // The epoch is checked INSIDE readiness, at the moment of the write,
        // not here: a teardown can land during the awaits above, and a check
        // performed before them would prove nothing about the state now.
        markStudioRuntimeReady(epoch);
        log.info("[agent:studio-settlement-bridge] studio runtime ready (retry)");
        return;
      }
      scheduleDispatchPreflightRetry(epoch, attempt + 1);
    })();
  }, PREFLIGHT_RETRY_MS);
  // A retry must never hold the process open by itself.
  timer.unref?.();
  preflightRetryTimer = timer;
}

async function registerDispatchPreflight(): Promise<boolean> {
  try {
    const { setStudioDispatchPreflight } = await import(
      "@vex-agent/engine/core/approval-runtime.js"
    );
    // `true` means "Vex can prove its lock fence AND this process finished
    // starting Studio". A poisoned fence, or a reconciliation still in flight,
    // refuses the dispatch durably rather than running an approved action under
    // a generation nobody advanced past or racing the reconciler for its row.
    setStudioDispatchPreflight(
      () =>
        isStudioRuntimeReady()
        && isSecretSessionUnlocked()
        && !isStudioSessionTransitionInProgress()
        && !isStudioDispatchPoisoned(),
    );
    return true;
  } catch (cause) {
    log.warn("[agent:studio-settlement-bridge] preflight registration failed", cause);
    return false;
  }
}

/**
 * Stop the engine's terminal-write repair owner.
 *
 * Reached through the barrel's DYNAMIC import, unlike the preflight registry:
 * the repair owner reads and writes the database, so importing it statically
 * would put `pg` into main's load path. Teardown is the one place that can
 * afford to wait a microtask for it, because its entries are dropped either
 * way - the next process start's reconciler owns those rows.
 */
export async function disposeStudioWriteRepairOwner(): Promise<void> {
  try {
    const { disposeStudioWriteRepair } = await import(
      "@vex-agent/engine/core/approval-runtime.js"
    );
    disposeStudioWriteRepair();
  } catch (cause) {
    log.warn(
      "[agent:studio-settlement-bridge] write-repair owner teardown failed",
      cause,
    );
  }
}

/**
 * One BOUNDED, PAGED pass at process start, awaited by the readiness barrier.
 * Failures are logged: the rows stay `dispatching` and the next start tries
 * again, which is strictly better than guessing an outcome for a call that may
 * have moved funds. A failed pass does not keep Studio closed - the scan is
 * over either way, so the race it exists to prevent is over too.
 */
async function reconcileAbandonedDispatches(): Promise<void> {
  try {
    const {
      reconcileAbandonedStudioDispatches,
      announceStudioReconciliations,
      reconcileUnstartedStudioApprovals,
      announceStudioUnstartedRefusals,
    } = await import("@vex-agent/engine/core/approval-runtime.js");
    const reconciled = await reconcileAbandonedStudioDispatches();
    // AFTER the writes have committed, never inside them.
    announceStudioReconciliations(reconciled);
    if (reconciled.length > 0) {
      log.warn(
        `[agent:studio-settlement-bridge] reconciled ${String(reconciled.length)} `
          + "abandoned Studio dispatch(es) to indeterminate",
      );
    }
    // The second half of the same premise: an APPROVED row that never started
    // has no owner either, and unlike a `dispatching` one it can still RUN.
    const unstarted = await reconcileUnstartedStudioApprovals();
    announceStudioUnstartedRefusals(unstarted);
    if (unstarted.length > 0) {
      log.warn(
        `[agent:studio-settlement-bridge] refused ${String(unstarted.length)} `
          + "approved Studio action(s) that never started",
      );
    }
  } catch (cause) {
    log.warn(
      "[agent:studio-settlement-bridge] abandoned-dispatch reconcile failed",
      cause,
    );
  }
}

async function releaseWaiter(approvalId: string): Promise<void> {
  try {
    const { getStudioSettlementByApprovalId } = await import(
      "@vex-agent/db/repos/approval-intents.js"
    );
    const row = await getStudioSettlementByApprovalId(approvalId);
    if (row === null) {
      log.warn(
        `[agent:studio-settlement-bridge] no row for approvalId=${approvalId}`,
      );
      return;
    }
    settleStudioWaiter(row);
  } catch (cause) {
    // The row is durable regardless. Losing the release costs the blocked call
    // its early answer; its own expiry timer and the scheduled sweep remain.
    log.warn(
      `[agent:studio-settlement-bridge] release failed approvalId=${approvalId}`,
      cause,
    );
  }
}
