/**
 * IN-FLIGHT SIGNING: is anything in this process signing or sending right now?
 *
 * A process-wide count of the work that may sign a transaction or send one to
 * a venue, so a user-initiated lock (the Lock Vex button and menu item,
 * `LOCK_BUTTON`) can refuse instead of pulling the vault out from under it.
 *
 * Today a lock is immediate: anything that has not yet loaded its key fails
 * closed, and anything that has keeps going. That never moves funds wrongly,
 * but a lock that lands inside an approved send can stop its post-send
 * evidence reads and leave the outcome to be reconciled later. Counting the
 * work lets the button say "not now" for exactly that window.
 *
 * What is counted (each call site wraps its own work):
 *  - every MUTATING tool dispatch (`tools/dispatcher.ts`): chat approvals, the
 *    Lighter desk, missions and Studio all execute fund-moving tools there;
 *  - the main-process signers that run outside a tool dispatch (Lighter
 *    leverage confirmation, pools.fun deploy and claim) and the Lighter key
 *    registration and fee authorization executors.
 *
 * Observational while no explicit lock lease is active: admitted work keeps
 * its result, error and execution order. New work refuses during that lease. The count is in memory only and carries no identifiers.
 */

export type InFlightSigningKind =
  | "mutating_tool"
  | "lighter_leverage"
  | "lighter_key_registration"
  | "lighter_fee_authorization"
  | "pools_launch_deploy"
  | "pools_launch_claim";

export interface InFlightSigningSnapshot {
  readonly total: number;
  /** Kinds with at least one unit of work in flight, in a stable order. */
  readonly kinds: readonly InFlightSigningKind[];
}

const KIND_ORDER: readonly InFlightSigningKind[] = [
  "mutating_tool",
  "lighter_leverage",
  "lighter_key_registration",
  "lighter_fee_authorization",
  "pools_launch_deploy",
  "pools_launch_claim",
];

const counts = new Map<InFlightSigningKind, number>();
let locking = false;

/** No identifiers or secrets are retained by this admission error. */
export class SigningLockInProgressError extends Error {
  constructor() {
    super("Vex is locking. Unlock Vex before starting another transaction.");
    this.name = "SigningLockInProgressError";
  }
}

/** Atomically reserve the explicit lock window without interrupting admitted work. */
export function tryAcquireSigningLock(): (() => void) | null {
  if (locking || inFlightSigningSnapshot().total > 0) return null;
  locking = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locking = false;
  };
}

function adjust(kind: InFlightSigningKind, delta: 1 | -1): void {
  const next = (counts.get(kind) ?? 0) + delta;
  if (next <= 0) counts.delete(kind);
  else counts.set(kind, next);
}

/**
 * Run `work` counted as in flight until it settles, whether it resolves,
 * rejects or throws synchronously. The count rises BEFORE `work` starts, in
 * the same synchronous step, so a lock checked after this call has begun
 * always sees it.
 */
export async function trackInFlightSigning<T>(
  kind: InFlightSigningKind,
  work: () => Promise<T>,
): Promise<T> {
  if (locking) throw new SigningLockInProgressError();
  adjust(kind, 1);
  try {
    return await work();
  } finally {
    adjust(kind, -1);
  }
}

export function inFlightSigningSnapshot(): InFlightSigningSnapshot {
  let total = 0;
  const kinds: InFlightSigningKind[] = [];
  for (const kind of KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) {
      total += count;
      kinds.push(kind);
    }
  }
  return { total, kinds };
}

/** Test seam: forget every count. */
export function __resetInFlightSigningForTests(): void {
  counts.clear();
  locking = false;
}
