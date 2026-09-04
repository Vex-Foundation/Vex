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
 *   1b. THE ENGINE DATABASE IS AWAITED. Steps 2 and 3 read and write Studio
 *      rows, and on a cold start the database does not exist yet: compose is
 *      triggered by the renderer, ten to twenty seconds after this runs. So the
 *      bridge WAITS for `whenEngineDbReady` instead of spending three bounded
 *      attempts against a database that has not been started yet and then
 *      declaring Studio unavailable for the session. The wait ends only when
 *      the database is ready or when this bridge's teardown aborts it. EVERY
 *      path that registers the preflight goes through it, the bounded retry
 *      included: a retry that reached the database work directly spent the
 *      whole budget on a database that had not started yet.
 *   1c. AFTER EVERY AWAITED PHASE the abort signal and the epoch are checked
 *      again, INSIDE the reconciliation as well as around it, and the readiness
 *      write reports whether it COMMITTED. Only a committed transition logs a
 *      ready Studio and starts the project-cleanup repair, so a teardown
 *      landing inside the reconciliation can neither announce its rows, nor
 *      start the second reconciliation query, nor publish readiness.
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
 * Teardown also cancels the owned retry timer, ABORTS the database wait and
 * invalidates the readiness EPOCH, so neither a retry nor a wait already in
 * flight can mark a shutting-down process ready, and stops the engine's
 * terminal-write repair owner.
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
import { projectDeleteRuntimeDeps } from "../studio/project-delete-runtime.js";
import { repairUnfinishedProjectCleanups } from "../studio/project-delete.js";
import {
  beginStudioReadinessEpoch,
  currentStudioReadinessEpoch,
  isStudioRuntimeReady,
  markStudioFenceUninitialized,
  markStudioRuntimeReady,
  markStudioRuntimeShuttingDown,
  setStudioRuntimeRetryHook,
} from "../studio/readiness.js";
import {
  EngineDbWaitAbortedError,
  whenEngineDbReady,
} from "../database/engine-db-readiness.js";

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
  // ONE controller for the whole lifecycle, owned here and aborted by the
  // teardown below. It is what ends an unbounded database wait; the wait has no
  // deadline of its own on purpose (see the header).
  initializationAbort = new AbortController();
  // The re-entry the secret session asks for on an unlock and on its recovery
  // pass. Registered at setup rather than only after the bounded retry gives
  // up, so there is one hook with one owner and nothing to arm later.
  setStudioRuntimeRetryHook(retryStudioRuntimeInitialization);
  readyBarrier = initializeStudioRuntime(epoch, initializationAbort.signal);

  return () => {
    off();
    readyBarrier = null;
    setStudioRuntimeRetryHook(null);
    // Cancel the owned retry BEFORE invalidating the epoch, so the timer is
    // gone rather than merely neutered, and idempotently: a second teardown
    // clears nothing and logs nothing.
    cancelDispatchPreflightRetry();
    // Ends the database wait, which is otherwise unbounded by design.
    initializationAbort?.abort();
    initializationAbort = null;
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
 * Register the fence, WAIT FOR THE DATABASE, reconcile, then open Studio. The
 * whole sequence is best-effort in the sense that it never throws at its caller
 * - main must boot regardless - but every failure leaves Studio CLOSED rather
 * than open.
 */
async function initializeStudioRuntime(
  epoch: number,
  signal: AbortSignal,
): Promise<void> {
  initializationInFlight = true;
  try {
    const registered = await registerDispatchPreflight();
    if (!registered) {
      markStudioFenceUninitialized(epoch);
      scheduleDispatchPreflightRetry(epoch, signal);
      return;
    }
    await awaitEngineDbThenComplete(epoch, signal, 0);
  } catch (cause) {
    // The barrier is awaited by boot (`awaitStudioRuntimeReady`), so a
    // rejection here would take the whole start-up down over a Studio step
    // whose only correct failure mode is a Studio that stays closed.
    log.warn(
      "[agent:studio-settlement-bridge] studio runtime initialization failed",
      cause,
    );
  } finally {
    initializationInFlight = false;
  }
}

/**
 * THE ONE CONTINUATION every successful registration takes: wait for the
 * database, THEN do the work that needs it.
 *
 * It exists as a named seam because the retry path used to skip it. A
 * registration that failed once and succeeded on the retry went straight to
 * `completeStudioRuntime`, so on a cold start the retries spent the whole
 * bounded budget querying a database that compose had not started yet - three
 * attempts at 5, 10 and 15 s against a database that appeared at 15.6 s - and
 * then declared Studio unavailable for the session. The bounded retry is for
 * failures that happen AFTER the database is ready, and this is what keeps it
 * that way, whichever attempt reaches it.
 *
 * UNBOUNDED on purpose, and cancellable: giving up here would decide, for the
 * user, that a slow database is a dead one. The boot deadline lives in
 * `awaitStudioRuntimeReady`, which opens the window without opening the fence.
 */
async function awaitEngineDbThenComplete(
  epoch: number,
  signal: AbortSignal,
  retriesUsed: number,
): Promise<void> {
  try {
    await whenEngineDbReady({ signal });
  } catch (cause) {
    if (cause instanceof EngineDbWaitAbortedError) return;
    log.warn(
      "[agent:studio-settlement-bridge] database readiness wait failed",
      cause,
    );
    return;
  }
  await completeStudioRuntime(epoch, signal, retriesUsed);
}

/**
 * Everything that needs the database: repair the durable refusal a previous
 * lock owes, reconcile abandoned dispatches, then open Studio.
 *
 * `retriesUsed` is the bounded retry counter for failures that happen AFTER the
 * database is ready - a genuinely transient import or query failure - and is
 * deliberately not spent on a database that has not started yet.
 */
async function completeStudioRuntime(
  epoch: number,
  signal: AbortSignal,
  retriesUsed: number,
): Promise<void> {
  if (signal.aborted) return;
  const repaired = await repairPendingStudioRefusal();
  // RE-CHECKED AFTER THE AWAIT, both facts. A teardown that landed during the
  // repair has already cancelled the retry timer and invalidated the epoch, so
  // arming another retry here would leave a live timer nobody owns.
  if (signal.aborted || currentStudioReadinessEpoch() !== epoch) return;
  if (!repaired) {
    markStudioFenceUninitialized(epoch);
    scheduleDispatchPreflightRetry(epoch, signal, retriesUsed);
    return;
  }
  await reconcileAbandonedDispatches(epoch, signal);
  if (!initializationIsCurrent(epoch, signal)) return;
  // THE COMMIT, and everything below it is strictly after it. The epoch is
  // checked INSIDE readiness, at the moment of the write, not before the awaits
  // above, which would prove nothing about the state now; what the caller needs
  // back is whether that write actually happened, because a teardown during the
  // reconciliation otherwise left this path announcing a ready Studio and
  // starting fresh cleanup work on a process that is going away.
  if (!markStudioRuntimeReady(epoch)) return;
  log.info("[agent:studio-settlement-bridge] studio runtime ready");

  // B0: finish any project cleanup a previous run did not. Deliberately AFTER
  // the barrier opens and deliberately NOT awaited into readiness: an
  // unfinished cleanup is a durable obligation on a project that is already
  // gone, so it must never be able to hold Studio closed. Its own failures are
  // recorded on the row and retried by the next start or by the user.
  void repairUnfinishedProjectCleanups(projectDeleteRuntimeDeps).catch(
    (cause: unknown) => {
      log.warn(
        "[agent:studio-settlement-bridge] project cleanup repair failed",
        cause,
      );
    },
  );
}

/**
 * Try an initialization that never finished, ONE more time.
 *
 * Called by the secret session through the readiness retry hook: an unlock, and
 * the recovery pass that already polls while the dispatch fence is unproven,
 * are the two moments at which a user is waiting for Studio and something in
 * the process may have changed. It is a no-op when there is no live bridge,
 * when Studio is already ready, or when an initialization is still running, so
 * the caller does not have to know any of that.
 */
export function retryStudioRuntimeInitialization(): void {
  const controller = initializationAbort;
  if (readyBarrier === null || controller === null) return;
  if (controller.signal.aborted) return;
  if (isStudioRuntimeReady() || initializationInFlight) return;
  cancelDispatchPreflightRetry();
  log.info(
    "[agent:studio-settlement-bridge] retrying studio runtime initialization",
  );
  readyBarrier = initializeStudioRuntime(
    currentStudioReadinessEpoch(),
    controller.signal,
  );
}

/**
 * The post-database retry. It exists because a failed dynamic import or a
 * single failed query is typically transient, and the alternative is a Studio
 * that stays closed until the user restarts. Bounded, it stops at the first
 * success, and a teardown clears it.
 *
 * When it IS exhausted, Studio is not dead for the session: the readiness retry
 * hook registered at setup brings it back on the next unlock or on the secret
 * session's recovery pass.
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

/**
 * The lifecycle's abort owner, and the guard that stops a re-entry from
 * starting a second initialization beside a live one.
 */
let initializationAbort: AbortController | null = null;
let initializationInFlight = false;

/**
 * Is THIS initialization still the one that may act?
 *
 * Both facts a teardown moves, checked together, because different owners move
 * them: the abort controller lives in this module and the epoch in
 * `readiness.ts`. A retry that outlived its teardown holds a stale epoch even
 * though it also holds an aborted signal, and a re-entry that began a NEW epoch
 * leaves the previous run's signal untouched.
 */
function initializationIsCurrent(epoch: number, signal: AbortSignal): boolean {
  return !signal.aborted && currentStudioReadinessEpoch() === epoch;
}

function cancelDispatchPreflightRetry(): void {
  if (preflightRetryTimer === null) return;
  clearTimeout(preflightRetryTimer);
  preflightRetryTimer = null;
}

function scheduleDispatchPreflightRetry(
  epoch: number,
  signal: AbortSignal,
  retriesUsed = 0,
): void {
  // THE TEARDOWN CHECK BELONGS HERE, at the one owner of the arming, not at
  // each caller. Every call site reaches this function AFTER an awaited
  // registration, and a registration that was still in flight when teardown
  // landed answers once the teardown has already cleared the timers: arming
  // then leaves a live timer behind a lifecycle that is over, owned by
  // nobody, on a process that is going away. Both facts teardown moves are
  // checked, because they are moved by different owners: the controller here
  // and the epoch in `readiness.ts`.
  if (signal.aborted || currentStudioReadinessEpoch() !== epoch) return;
  if (retriesUsed >= PREFLIGHT_RETRY_ATTEMPTS) {
    log.error(
      "[agent:studio-settlement-bridge] studio runtime initialization did not "
        + "complete after its bounded retries; Vex Studio stays unavailable "
        + "until the next unlock retries it",
    );
    return;
  }
  cancelDispatchPreflightRetry();
  const timer = setTimeout(() => {
    preflightRetryTimer = null;
    void (async () => {
      if (readyBarrier === null || signal.aborted) return;
      initializationInFlight = true;
      try {
        if (await registerDispatchPreflight()) {
          // THE SAME continuation as the first attempt: the database wait comes
          // before any work that needs the database, on every path.
          await awaitEngineDbThenComplete(epoch, signal, retriesUsed + 1);
          return;
        }
        scheduleDispatchPreflightRetry(epoch, signal, retriesUsed + 1);
      } catch (cause) {
        log.warn(
          "[agent:studio-settlement-bridge] studio runtime retry failed",
          cause,
        );
      } finally {
        initializationInFlight = false;
      }
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
async function reconcileAbandonedDispatches(
  epoch: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    const {
      reconcileAbandonedStudioDispatches,
      announceStudioReconciliations,
      reconcileUnstartedStudioApprovals,
      announceStudioUnstartedRefusals,
    } = await import("@vex-agent/engine/core/approval-runtime.js");
    if (!initializationIsCurrent(epoch, signal)) return;
    const reconciled = await reconcileAbandonedStudioDispatches();
    // AFTER the writes have committed, never inside them - and only while this
    // initialization is still the current one. The rows themselves are durable
    // and the next process start reconciles them again, so a dropped
    // announcement costs nothing; announcing from a process that is shutting
    // down, or starting the SECOND scan behind it, is fresh work nobody owns.
    if (!initializationIsCurrent(epoch, signal)) return;
    announceStudioReconciliations(reconciled);
    if (reconciled.length > 0) {
      log.warn(
        `[agent:studio-settlement-bridge] reconciled ${String(reconciled.length)} `
          + "abandoned Studio dispatch(es) to indeterminate",
      );
    }
    // The second half of the same premise: an APPROVED row that never started
    // has no owner either, and unlike a `dispatching` one it can still RUN.
    if (!initializationIsCurrent(epoch, signal)) return;
    const unstarted = await reconcileUnstartedStudioApprovals();
    if (!initializationIsCurrent(epoch, signal)) return;
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
