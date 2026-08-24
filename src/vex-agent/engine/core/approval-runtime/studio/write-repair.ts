/**
 * The Vex Studio TERMINAL-WRITE REPAIR OWNER.
 *
 * ## The failure it closes
 *
 * Every exit from the Studio dispatch path is supposed to leave the row
 * TERMINAL. Two of them could fail to: a pre-dispatch refusal whose CAS THREW
 * (`studio-gate.ts`), and the `dispatching -> indeterminate` write whose three
 * bounded attempts all threw (`../post-tx/dispatch-approved/studio.ts`). Both
 * gave up and named a floor that does not exist for those rows:
 *
 *   - the expiry sweep scans `decision IS NULL` only, so it never revisits an
 *     APPROVED row;
 *   - the agent lifecycle scans exclude Studio rows outright;
 *   - the startup reconciler is a floor only at the NEXT process start.
 *
 * So in a live process the row stayed `approved/not_started` (still eligible
 * for the dispatch-slot CAS, so still able to run an action whose requester was
 * already told it did not happen) or `approved/dispatching` for ever, and the
 * blocked MCP caller waited until Vex restarted.
 *
 * ## What this owner does, and the one thing it must never do
 *
 * It retries THE WRITE, and only the write: the identical CAS, with the
 * identical body, against a row whose dispatch decision has already been made.
 * IT NEVER DISPATCHES. Re-running an approved money-path call to discover its
 * outcome is the defect the whole Studio arm is shaped to prevent, and nothing
 * in this module can reach a tool.
 *
 * ## Single-flight, and why the timer is a recursive `setTimeout`
 *
 * A pass is scheduled only AFTER the previous pass has settled. An interval
 * would stack passes on top of a database that is slow or wedged - which is
 * precisely the condition that put entries here - and every stacked pass would
 * hold another connection. There is at most one pass in flight, for ever.
 *
 * ## When an entry stops being retried
 *
 * On success, on a CAS that matched zero rows (a durable winner owns the row),
 * and on a row that reads TERMINAL. In each case somebody's terminal state
 * exists, so there is nothing left to repair. A read or write that THROWS keeps
 * the entry for the next pass, because a transport failure proves nothing about
 * the row.
 *
 * ## Write first, announce second
 *
 * The same split every other Studio writer uses. A settlement is announced only
 * once a terminal state is committed and observed, because a subscriber reads
 * the row by id on that signal and would otherwise answer a blocked agent from
 * a state that does not exist yet.
 *
 * ## BOUNDED
 *
 * At most `STUDIO_REPAIR_CAP` entries. A registration above the cap is DROPPED
 * and LOGGED with the id, rather than growing a map that a failing database
 * would fill without limit; the next process start's reconciler remains the
 * floor for a dropped row.
 */

import logger from "@utils/logger.js";
import { withTransaction } from "@vex-agent/db/client.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import type { StudioPostDecisionRefusalReason } from "@vex-agent/db/repos/approval-intents.js";
import { emitStudioSettlement } from "@vex-agent/engine/runtime/studio-settlement-bus.js";

import { isTerminalStudioState } from "./terminal-state.js";

/** The serialized settlement body a repair re-attempts, byte-for-byte. */
interface StudioRepairBody {
  readonly settlementJson: string | null;
  readonly settlementBytes: number | null;
  readonly resultHash: string | null;
}

/**
 * Which write failed. `refusal` is the pre-dispatch CAS
 * (`approved/not_started -> failed`); `indeterminate` is the post-dispatch one
 * (`dispatching -> indeterminate`). They are not interchangeable: their CAS
 * predicates require different execution states, so replaying the wrong one
 * would silently match nothing for ever.
 */
export type StudioRepairWrite = "refusal" | "indeterminate";

export type StudioWriteRepair =
  | ({
      readonly write: "refusal";
      readonly approvalId: string;
      readonly refusalReason: StudioPostDecisionRefusalReason;
    } & StudioRepairBody)
  | ({
      readonly write: "indeterminate";
      readonly approvalId: string;
    } & StudioRepairBody);

/**
 * How many failed terminal writes are held at once, and how long the owner
 * waits between passes.
 *
 * The cap is small because an entry represents ONE blocked external call, and
 * the broker caps those at 32; twice that leaves room for rows whose waiter has
 * already gone away while staying a number a log line can enumerate. The
 * cadence is slow because the condition that creates entries is a database that
 * is down or wedged, and a fast retry against one buys nothing.
 */
export const STUDIO_REPAIR_CAP = 64;
export const STUDIO_REPAIR_INTERVAL_MS = 10_000;

/** THE registry. One owner, one map, one timer. */
const pending = new Map<string, StudioWriteRepair>();
let passTimer: NodeJS.Timeout | null = null;
let passInFlight = false;
let disposed = false;

/**
 * Register a terminal write that FAILED, and start the owner if it is idle.
 *
 * Called at the moment the write throws, never speculatively: an entry here
 * asserts "this row has no terminal state and this process owes it one".
 * Registering the same approval twice replaces the entry, because the second
 * failure describes the same row and the newer body is the newer truth.
 */
export function registerStudioWriteRepair(repair: StudioWriteRepair): void {
  if (disposed) return;
  if (!pending.has(repair.approvalId) && pending.size >= STUDIO_REPAIR_CAP) {
    // REPORTED, never silent: the row keeps whatever state it has and the next
    // process start's reconciler is its floor.
    logger.error("engine.studio.write_repair_dropped_at_cap", {
      approvalId: repair.approvalId,
      write: repair.write,
      cap: STUDIO_REPAIR_CAP,
    });
    return;
  }
  pending.set(repair.approvalId, repair);
  logger.warn("engine.studio.write_repair_registered", {
    approvalId: repair.approvalId,
    write: repair.write,
    pending: pending.size,
  });
  schedulePass();
}

/** Entries still awaiting repair. For the owner's tests and its log lines. */
export function studioWriteRepairCount(): number {
  return pending.size;
}

/**
 * Stop the owner: cancel the timer, drop every entry, and refuse further
 * registrations. IDEMPOTENT, and safe after a partial start.
 *
 * Called from the settlement bridge's teardown and from the ordered quit
 * cleanup. Dropping the entries is the honest behaviour on shutdown: the
 * process is going away, the next start's reconciler owns those rows, and a
 * write attempted while the local database is stopping would only fail again.
 */
export function disposeStudioWriteRepair(): void {
  disposed = true;
  if (passTimer !== null) {
    clearTimeout(passTimer);
    passTimer = null;
  }
  const dropped = pending.size;
  pending.clear();
  if (dropped > 0) {
    logger.warn("engine.studio.write_repair_disposed", { dropped });
  }
}

/** Test seam: a fresh owner with no entries, no timer, and not disposed. */
export function resetStudioWriteRepairForTests(): void {
  if (passTimer !== null) clearTimeout(passTimer);
  passTimer = null;
  passInFlight = false;
  pending.clear();
  disposed = false;
}

/**
 * Arm the next pass, unless one is already armed, already running, or there is
 * nothing to do. This is the ONLY place a timer is created.
 */
function schedulePass(): void {
  if (disposed || passInFlight || passTimer !== null) return;
  if (pending.size === 0) return;
  const timer = setTimeout(() => {
    passTimer = null;
    void runRepairPass();
  }, STUDIO_REPAIR_INTERVAL_MS);
  // A repair owner must never hold the process open by itself.
  timer.unref?.();
  passTimer = timer;
}

/**
 * ONE pass over a SNAPSHOT of the entries, then re-arm if anything is left.
 *
 * The snapshot matters: a repair that commits announces a settlement, a
 * subscriber may register another failed write from that signal, and iterating
 * the live map would then walk an entry this pass never planned to touch.
 */
async function runRepairPass(): Promise<void> {
  if (disposed) return;
  passInFlight = true;
  try {
    for (const entry of [...pending.values()]) {
      if (disposed) return;
      await repairOne(entry);
    }
  } finally {
    passInFlight = false;
    schedulePass();
  }
}

/**
 * Repair ONE row: read it, and write only if it still needs a terminal state.
 *
 * The read comes first because it is the cheapest way to learn that the entry
 * is finished, and because it is what makes the announce honest - the row it
 * announces is the row it just read.
 */
async function repairOne(entry: StudioWriteRepair): Promise<void> {
  let row: Awaited<
    ReturnType<typeof approvalIntentsRepo.getStudioSettlementByApprovalId>
  >;
  try {
    row = await approvalIntentsRepo.getStudioSettlementByApprovalId(
      entry.approvalId,
    );
  } catch (cause) {
    // The row is unreadable. That says nothing about its state, so the entry
    // stays and the next pass tries again.
    logger.warn("engine.studio.write_repair_read_failed", {
      approvalId: entry.approvalId,
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
    return;
  }
  if (row === null) {
    // Nothing to repair and nobody to answer: the row is gone.
    finish(entry, "row_missing");
    return;
  }
  if (isTerminalStudioState(row)) {
    // Somebody committed a terminal state. The waiter may be released, and it
    // is released from the state that exists rather than the one this entry
    // wanted to write.
    finish(entry, "already_terminal");
    announce(entry.approvalId, row.projectId, row.executionStatus);
    return;
  }

  let committed = false;
  try {
    committed = await commitRepair(entry);
  } catch (cause) {
    logger.warn("engine.studio.write_repair_write_failed", {
      approvalId: entry.approvalId,
      write: entry.write,
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
    return;
  }
  if (committed) {
    finish(entry, "repaired");
    // AFTER the commit, never before it.
    announce(
      entry.approvalId,
      row.projectId,
      entry.write === "refusal" ? "failed" : "indeterminate",
    );
    return;
  }
  // Zero rows: the CAS predicate no longer holds, so another writer owns this
  // row. Stop retrying - the same race would only be lost again - and re-read
  // once so a waiter whose row went terminal in this window is still released.
  finish(entry, "superseded");
  await announceIfTerminal(entry.approvalId);
}

function commitRepair(entry: StudioWriteRepair): Promise<boolean> {
  if (entry.write === "refusal") {
    return withTransaction((client) =>
      approvalIntentsRepo.casRefuseStudioBeforeDispatchWith(client, {
        approvalId: entry.approvalId,
        refusalReason: entry.refusalReason,
        settlementJson: entry.settlementJson,
        settlementBytes: entry.settlementBytes,
        resultHash: entry.resultHash,
      }),
    );
  }
  return withTransaction((client) =>
    approvalIntentsRepo.casMarkIndeterminateWithSettlementWith(client, {
      approvalId: entry.approvalId,
      settlementJson: entry.settlementJson,
      settlementBytes: entry.settlementBytes,
      resultHash: entry.resultHash,
    }),
  );
}

/** Re-read after a lost CAS and announce only a state that actually exists. */
async function announceIfTerminal(approvalId: string): Promise<void> {
  try {
    const row = await approvalIntentsRepo.getStudioSettlementByApprovalId(
      approvalId,
    );
    if (row === null || !isTerminalStudioState(row)) return;
    announce(approvalId, row.projectId, row.executionStatus);
  } catch {
    // Only a lost EARLY answer: the broker's periodic durable read is the floor
    // for this waiter, and the row itself is correct either way.
  }
}

function finish(entry: StudioWriteRepair, outcome: string): void {
  pending.delete(entry.approvalId);
  logger.info("engine.studio.write_repair_finished", {
    approvalId: entry.approvalId,
    write: entry.write,
    outcome,
    pending: pending.size,
  });
}

/**
 * Emit the settlement signal for a row this owner has PROVEN terminal. The
 * outcome enum follows the committed execution status, never the intent: a
 * refusal never dispatched, so it is `rejected`; an indeterminate row may have
 * taken effect, and saying anything else would invite a retry.
 */
function announce(
  approvalId: string,
  projectId: string | null,
  executionStatus: string,
): void {
  emitStudioSettlement({
    approvalId,
    projectId,
    outcome:
      executionStatus === "indeterminate"
        ? "indeterminate"
        : executionStatus === "succeeded"
          ? "settled"
          : "rejected",
  });
}
