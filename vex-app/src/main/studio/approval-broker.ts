/**
 * The Vex Studio APPROVAL BROKER - the in-memory half of the blocking arm.
 *
 * An external coding agent calls a mutating Vex tool through MCP. The call is
 * refused with `pendingApproval`, an intent is enqueued, and the agent's
 * request BLOCKS until a human decides. This module owns that block: one waiter
 * per approval id, released exactly once, by whichever of four things happens
 * first - a settlement, a refusal, the intent's own expiry, or the transport
 * going away.
 *
 * ## Durable first, waiter second
 *
 * Nothing here is authority. Every release is driven by a COMMITTED row: the
 * settlement bridge reads the intent by id after the engine's settlement bus
 * says it is durable, and hands that row to the waiter. A waiter that is lost
 * (a torn-down broker, a crashed process) therefore costs the blocked call its
 * early answer and nothing else - the row is still correct and the approvals UI
 * still shows it. The inverse design, releasing on an in-memory belief and
 * writing afterwards, is what would let an agent be told "cancelled" while a
 * dispatch was still on its way.
 *
 * ## The cap is a refusal, not a queue, and it is RESERVED BEFORE the enqueue
 *
 * Waiters are bounded. Above the cap a new call is REFUSED by name rather than
 * parked, because a parked approval request is indistinguishable to the agent
 * from a slow human, and an unbounded map of them is an unbounded hold on
 * memory and on MCP request slots. The refusal says what to do (decide the
 * outstanding cards first), which is actionable; a hang is not.
 *
 * The bound is claimed with `reserveStudioWaiterSlot` BEFORE the intent is
 * written, and that ordering is the point. Checking it only at registration
 * meant an approval row was already enqueued and approvable when the caller was
 * told "not queued": a human could then approve an action whose requester had
 * been told nothing would happen. A reservation is released when the enqueue
 * refuses, and converted into the registered waiter when it succeeds, so it is
 * never counted twice.
 *
 * ## The lost-wakeup window, and the reads that close it
 *
 * A settlement can COMMIT between the enqueue and the waiter's registration.
 * Its bus event reaches no waiter, and the intent's expiry cannot reject an
 * already-approved row, so the call would block until the transport gave up.
 * So registration is followed by a durable read, and that read REPEATS - one at
 * a time, each armed only after the previous one settled - for as long as the
 * call blocks. One read is not enough: a row that is `approved` is past the
 * expiry sweep's reach for good (the
 * sweep scans UNDECIDED rows only), so a bus event lost to a torn-down
 * subscriber, a failed read, or a settlement committed by a writer this
 * process never heard from would leave the call blocked with a terminal row
 * sitting in the database. The periodic read is that floor. `settle` is
 * idempotent, so a bus event arriving concurrently is harmless, and a failed
 * read only logs and waits for the next tick.
 *
 * Both reads release ONLY on a TERMINAL row (`settlement-terminal.ts`).
 * `approved/not_started` and `approved/dispatching` are not terminal: the
 * approval commits BEFORE the dispatch, so those two are exactly what a probe
 * legitimately observes while the approved action is still on its way, and
 * answering them would tell the agent nothing happened while it did.
 *
 * ## The expiry timer is not the durable floor
 *
 * Each waiter arms one timer at its intent's `expires_at` and calls
 * `expireApproval`, which routes through the origin-aware rejection dispatcher
 * and settles the row without a transcript message or a continuation. That is
 * the FAST path. The five-minute scheduled sweep does the same thing for rows
 * whose broker died with the process, and stays the floor under all of it.
 */

import { randomUUID } from "node:crypto";

import type { StudioSettlementRow } from "@vex-agent/db/repos/approval-intents.js";
import type { StudioCancelCause } from "@vex-agent/mcp/outcome.js";
import { log } from "../logger/index.js";
import { isTerminalStudioRow } from "./settlement-terminal.js";

/**
 * How many Studio approvals may block at once. Deliberately small: each one is
 * a human decision somebody has to make, and a number large enough to hide a
 * runaway agent would defeat the point of the bound.
 */
export const STUDIO_WAITER_CAP = 32;

/** Why a waiter was released. */
export type StudioBrokerOutcome =
  | {
      /** A committed decision exists. The row carries the whole truth. */
      readonly kind: "settled";
      readonly row: StudioSettlementRow;
    }
  | {
      /**
       * The call was withdrawn (transport EOF, MCP cancellation) and the
       * durable refusal was attempted BEFORE this release. `reason` names the
       * cause; `refusalCommitted` says whether the refusal reached the
       * database, because a refusal that did not is reconciled by the sweep and
       * the agent must not be told it was cleanly cancelled.
       */
      readonly kind: "withdrawn";
      readonly reason: StudioWithdrawalReason;
      readonly refusalCommitted: boolean;
    }
  | {
      /** The broker was disposed (application quit) with the call still open. */
      readonly kind: "broker_closed";
    };

/**
 * Why a waiter was withdrawn. The four TRUSTED teardown causes
 * (`StudioCancelCause`), plus `expired`, which is not a refusal at all: the
 * intent's own TTL ran out and the engine's expiry path owns the row. Both
 * families are typed so nothing a client sent can become the value Vex records.
 */
export type StudioWithdrawalReason = StudioCancelCause | "expired";

/** Registration refused before any wait began. */
export interface StudioBrokerAtCapacity {
  readonly kind: "at_capacity";
  readonly reason: string;
}

export interface StudioWaiterInput {
  readonly approvalId: string;
  readonly projectId: string | null;
  /** ISO instant from the intent row. `null` means no timer is armed. */
  readonly expiresAt: string | null;
  /** Fires every `progressIntervalMs` while the call is still blocked. */
  readonly onProgress?: () => void;
  readonly progressIntervalMs?: number;
  /** Aborting REFUSES the intent durably first, then releases the waiter. */
  readonly signal?: AbortSignal;
  /**
   * Asked once, when `signal` aborts, for the TRUSTED cause of the teardown.
   *
   * The owner that aborts is the one that knows why - an MCP
   * `notifications/cancelled` is `cancelled`, a peer FIN is `disconnect`, the
   * secret-session lock is `lock`, quit is `vex_quit` - and that cause is what
   * `approval_intents.refusal_reason` records, so a later reader can tell a
   * lock apart from a client hanging up. Absent, or throwing, means
   * `cancelled`: the honest machine fact for "the caller went away without
   * saying why", and the behaviour every caller had before this channel.
   */
  readonly cancelCause?: () => StudioCancelCause;
  /**
   * The slot this call reserved BEFORE it enqueued its intent. Handing it over
   * is what stops the reservation and the registered waiter counting twice; it
   * is released as soon as the waiter is in the map.
   */
  readonly reservation?: StudioWaiterReservation;
}

/** A claimed place under the cap. `release` is idempotent. */
export interface StudioWaiterReservation {
  release: () => void;
}

export type StudioWaiterReservationOutcome =
  | { readonly ok: true; readonly reservation: StudioWaiterReservation }
  | { readonly ok: false; readonly reason: string };

/**
 * Injected so the broker owns no policy: the refusal owner lives in
 * `approval-refusals.ts` and the expiry entry point is the engine's. Both are
 * functions rather than imports so a test can drive the ordering assertions
 * this module exists to guarantee.
 */
export interface StudioBrokerDependencies {
  /** Durably refuse ONE pending intent. `true` when the write committed. */
  readonly refuseIntent: (
    approvalId: string,
    reason: StudioWithdrawalReason,
  ) => Promise<boolean>;
  /** Expire ONE intent through the engine's origin-aware decision path. */
  readonly expireIntent: (approvalId: string) => Promise<void>;
  /**
   * Read the committed intent row by id. Called straight after registration
   * and then periodically, to close the lost-wakeup window described in the
   * header.
   */
  readonly readSettlement: (
    approvalId: string,
  ) => Promise<StudioSettlementRow | null>;
}

interface Waiter {
  readonly approvalId: string;
  readonly settle: (outcome: StudioBrokerOutcome) => void;
  readonly dispose: () => void;
}

const waiters = new Map<string, Waiter>();
/**
 * Places claimed but not yet registered. A set rather than a counter so
 * `release` is idempotent by construction and `dispose` can drop every
 * outstanding claim without the count going negative.
 */
const reservations = new Set<symbol>();
let dependencies: StudioBrokerDependencies | null = null;

/** Waiters plus claimed-but-unregistered places. */
function occupiedSlots(): number {
  return waiters.size + reservations.size;
}

function atCapacityReason(): string {
  return (
    `Vex is already holding ${String(STUDIO_WAITER_CAP)} actions waiting for `
    + "approval, so this one was not queued. Nothing was executed. Decide the "
    + "pending approvals in Vex, then ask again."
  );
}

/**
 * Claim a place under the cap BEFORE writing an approval intent.
 *
 * Refusing here is the only refusal that leaves NOTHING behind: no row, no
 * card, nothing for a human to approve. Every later refusal has to be durable
 * precisely because the row exists by then.
 */
export function reserveStudioWaiterSlot(): StudioWaiterReservationOutcome {
  if (occupiedSlots() >= STUDIO_WAITER_CAP) {
    log.warn(
      `[studio:broker] reservation refused at capacity waiters=${String(waiters.size)} `
        + `reserved=${String(reservations.size)}`,
    );
    return { ok: false, reason: atCapacityReason() };
  }
  const token = Symbol("studio-waiter-reservation");
  reservations.add(token);
  return {
    ok: true,
    reservation: {
      release: (): void => {
        reservations.delete(token);
      },
    },
  };
}

/** Reserved-but-unregistered places. Exposed for the cap tests. */
export function studioReservationCount(): number {
  return reservations.size;
}

/**
 * Install the broker's collaborators. Called once at startup, next to the other
 * Studio registrations, and again by tests with their own doubles.
 */
export function configureStudioApprovalBroker(
  deps: StudioBrokerDependencies,
): void {
  dependencies = deps;
}

export function studioWaiterCount(): number {
  return waiters.size;
}

/**
 * Block until this approval has a durable answer.
 *
 * Returns `at_capacity` WITHOUT waiting when the cap is reached, and without
 * touching the intent: the row stays pending and decidable, so the human can
 * still approve it and the agent can ask again.
 */
export async function awaitStudioSettlement(
  input: StudioWaiterInput,
): Promise<StudioBrokerOutcome | StudioBrokerAtCapacity> {
  // A caller that reserved has already been counted; re-checking the cap here
  // would refuse it against its own reservation. The check stays for callers
  // that did not reserve, as the defense for that path.
  if (
    input.reservation === undefined
    && occupiedSlots() >= STUDIO_WAITER_CAP
    && !waiters.has(input.approvalId)
  ) {
    log.warn(
      `[studio:broker] at capacity waiters=${waiters.size} `
        + `approvalId=${input.approvalId}`,
    );
    return { kind: "at_capacity", reason: atCapacityReason() };
  }

  const existing = waiters.get(input.approvalId);
  if (existing !== undefined) {
    // Two waiters for one approval would each get a release and one of them
    // would be a duplicate answer to a call that is not there any more.
    log.warn(`[studio:broker] duplicate waiter approvalId=${input.approvalId}`);
    existing.settle({ kind: "broker_closed" });
  }

  return new Promise<StudioBrokerOutcome>((resolve) => {
    let released = false;
    const timers: NodeJS.Timeout[] = [];
    /**
     * The ONE outstanding durable-read timer for this waiter. A single binding
     * rather than a list, because the read reschedules itself: only one can be
     * armed at a time, and dispose has to be able to cancel exactly that one.
     */
    let recheckTimer: NodeJS.Timeout | null = null;
    /**
     * The ONE outstanding progress timer, for the same reason `recheckTimer` is
     * one binding: the progress tick RESCHEDULES itself every couple of seconds
     * for as long as the human takes to decide, and it used to push each new
     * handle onto `timers` without ever removing the settled one. An approval
     * left open for an hour accumulated ~1800 dead `Timeout` objects that only
     * `dispose` ever released - a per-call leak that grows with exactly the wait
     * this waiter exists to survive (rule 05: every handle has one owner, and a
     * growing buffer needs a bound).
     */
    let progressTimer: NodeJS.Timeout | null = null;
    let removeAbortListener: (() => void) | null = null;

    const dispose = (): void => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      if (recheckTimer !== null) clearTimeout(recheckTimer);
      recheckTimer = null;
      if (progressTimer !== null) clearTimeout(progressTimer);
      progressTimer = null;
      if (removeAbortListener !== null) removeAbortListener();
      removeAbortListener = null;
      waiters.delete(input.approvalId);
    };

    // IDEMPOTENT by construction: the first release wins and every later one is
    // a no-op. Four producers can fire at once (settlement, expiry, abort,
    // dispose) and exactly one answer must reach the blocked call.
    const settle = (outcome: StudioBrokerOutcome): void => {
      if (released) return;
      released = true;
      dispose();
      resolve(outcome);
    };

    waiters.set(input.approvalId, {
      approvalId: input.approvalId,
      settle,
      dispose,
    });
    // The reservation has become the registered waiter; releasing it here keeps
    // the two from counting as two places.
    input.reservation?.release();

    // The lost-wakeup close: one read now, then the same read again for as long
    // as this call blocks. That repetition is the durable floor for an APPROVED
    // row, which no sweep will ever revisit.
    //
    // SINGLE-FLIGHT, and that is why it is a recursive `setTimeout` and not an
    // interval. The next read is armed only once the previous one has SETTLED,
    // so a database that never answers leaves at most ONE outstanding read per
    // waiter, for ever. An interval would stack a fresh read on top of every
    // hung one - each holding a connection - precisely when the database is
    // least able to serve them.
    const scheduleRecheck = (): void => {
      if (released) return;
      const timer = setTimeout(() => {
        recheckTimer = null;
        if (released) return;
        // `probeDurableRow` never rejects: it owns its own catch, so the
        // rescheduling below cannot be skipped by a failed read.
        void probeDurableRow(input.approvalId, settle).finally(scheduleRecheck);
      }, STUDIO_DURABLE_RECHECK_INTERVAL_MS);
      // A blocked MCP call is not a reason to hold the process open.
      timer.unref?.();
      recheckTimer = timer;
    };
    void probeDurableRow(input.approvalId, settle).finally(scheduleRecheck);

    const progressMs = input.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    if (input.onProgress !== undefined) {
      const armProgress = (): void => {
        if (released) return;
        const timer = setTimeout(tick, progressMs);
        // A blocked MCP call is not a reason to hold the process open, same as
        // the durable re-read timer above.
        timer.unref?.();
        progressTimer = timer;
      };
      const tick = (): void => {
        // Cleared FIRST: this handle has fired and is dead, so leaving it in the
        // binding would let `dispose` clear a settled timer while the live one
        // armed below went unowned.
        progressTimer = null;
        if (released) return;
        try {
          input.onProgress?.();
        } catch (cause) {
          log.warn("[studio:broker] progress callback threw", cause);
        }
        armProgress();
      };
      armProgress();
    }

    if (input.expiresAt !== null) {
      const delay = Math.max(0, Date.parse(input.expiresAt) - Date.now());
      timers.push(
        setTimeout(() => {
          void runExpiry(input.approvalId, settle);
        }, delay),
      );
    }

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        void runWithdrawal(input.approvalId, readCancelCause(input), settle);
      } else {
        const onAbort = (): void => {
          void runWithdrawal(input.approvalId, readCancelCause(input), settle);
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => {
          input.signal?.removeEventListener("abort", onAbort);
        };
      }
    }
  });
}

const DEFAULT_PROGRESS_INTERVAL_MS = 2_000;

/**
 * How long a blocked waiter waits BETWEEN durable re-reads of its own row.
 *
 * A gap, not a period: the next read is armed after the previous one settles,
 * so a slow read stretches the cycle rather than overlapping with itself.
 * Deliberately low frequency either way - this is a backstop for a lost event,
 * not the primary release path, and every read is a database round trip per
 * blocked call.
 */
export const STUDIO_DURABLE_RECHECK_INTERVAL_MS = 15_000;

/**
 * Release the waiter when its row is ALREADY TERMINAL, and only then.
 *
 * Terminal is read from the row through the shared predicate, never guessed.
 * An `approved` row that has not finished executing is left alone: the
 * dispatcher (or, if that process died, the startup reconciler) still owns it
 * and will produce the terminal state this probe is waiting for.
 */
async function probeDurableRow(
  approvalId: string,
  settle: (outcome: StudioBrokerOutcome) => void,
): Promise<void> {
  try {
    const row = await dependencies?.readSettlement(approvalId);
    if (row === undefined || row === null) return;
    if (!isTerminalStudioRow(row)) return;
    settle({ kind: "settled", row });
  } catch (cause) {
    // Only a lost EARLY answer, and only until the next tick.
    log.warn(
      `[studio:broker] settled-row probe failed approvalId=${approvalId}`,
      cause,
    );
  }
}

/**
 * Hand a committed settlement to its waiter. Called by the settlement bridge
 * AFTER it has read the row, never with an in-memory guess.
 *
 * A row with no waiter is normal and is not an error: the call may have been
 * withdrawn, the process may have restarted, or the human may have decided from
 * the Vex UI with no MCP call outstanding at all.
 */
export function settleStudioWaiter(row: StudioSettlementRow): void {
  const waiter = waiters.get(row.approvalId);
  if (waiter === undefined) return;
  // The same guard the probe applies. An announce for a row that is still
  // mid-flight (approval committed, dispatch not finished) must not answer the
  // blocked call: the terminal event that follows is the one that may.
  if (!isTerminalStudioRow(row)) {
    log.warn(
      `[studio:broker] non-terminal settlement ignored approvalId=${row.approvalId} `
        + `decision=${String(row.decision)} status=${row.executionStatus}`,
    );
    return;
  }
  waiter.settle({ kind: "settled", row });
}

/**
 * Withdraw one blocked call: REFUSE FIRST, RELEASE SECOND. The order is the
 * safety property - a waiter released before its intent is terminal leaves an
 * approvable row behind a caller that has already been told nothing will
 * happen.
 */
export async function withdrawStudioWaiter(
  approvalId: string,
  reason: StudioCancelCause,
): Promise<void> {
  const waiter = waiters.get(approvalId);
  if (waiter === undefined) return;
  await runWithdrawal(approvalId, reason, waiter.settle);
}

/**
 * The teardown owner's typed cause, or `cancelled`.
 *
 * A THROWING callback is treated as absent rather than allowed to escape: this
 * runs inside an abort listener, where an exception would leave the waiter
 * blocked and its intent pending - the exact failure the withdrawal exists to
 * prevent.
 */
function readCancelCause(input: StudioWaiterInput): StudioCancelCause {
  if (input.cancelCause === undefined) return "cancelled";
  try {
    return input.cancelCause();
  } catch (cause) {
    log.warn(
      `[studio:broker] cancel-cause callback threw approvalId=${input.approvalId}`,
      cause,
    );
    return "cancelled";
  }
}

async function runWithdrawal(
  approvalId: string,
  reason: StudioWithdrawalReason,
  settle: (outcome: StudioBrokerOutcome) => void,
): Promise<void> {
  let committed = false;
  try {
    committed = (await dependencies?.refuseIntent(approvalId, reason)) ?? false;
  } catch (cause) {
    // A refusal that could not be written is reported as such rather than
    // swallowed: the sweep reconciles the row, and the caller is told the
    // cancellation is not confirmed.
    log.warn(
      `[studio:broker] refusal failed approvalId=${approvalId} reason=${reason}`,
      cause,
    );
  }
  settle({ kind: "withdrawn", reason, refusalCommitted: committed });
}

async function runExpiry(
  approvalId: string,
  settle: (outcome: StudioBrokerOutcome) => void,
): Promise<void> {
  try {
    await dependencies?.expireIntent(approvalId);
    // No release here on purpose. `expireApproval` settles the row and emits
    // the settlement event, so the waiter is released through the SAME
    // committed-row path every other decision takes.
  } catch (cause) {
    log.warn(`[studio:broker] expiry failed approvalId=${approvalId}`, cause);
    settle({
      kind: "withdrawn",
      reason: "expired",
      refusalCommitted: false,
    });
  }
}

/**
 * Release every outstanding waiter and forget them. The durable refusal for a
 * quit is performed by the ordered quit cleanup BEFORE this runs, so a call
 * released here already has a terminal row.
 */
export function disposeStudioApprovalBroker(): void {
  const open = [...waiters.values()];
  waiters.clear();
  // Outstanding reservations belong to calls that are about to be answered by
  // the quit path; dropping them here keeps the cap honest for a broker that is
  // reconfigured (tests) rather than torn down for good.
  reservations.clear();
  for (const waiter of open) {
    waiter.dispose();
    waiter.settle({ kind: "broker_closed" });
  }
  if (open.length > 0) {
    log.info(`[studio:broker] disposed with ${String(open.length)} open waiter(s)`);
  }
}

/** Correlation id for a Studio approval operation that has no request id. */
export function studioCorrelationId(): string {
  return `studio-${randomUUID()}`;
}
