/**
 * THE SESSION ORDINAL LEDGER'S PERSISTED SHAPE.
 *
 * The left page prints a stable `(02)` beside each session
 * (`features/appShell/leftPage/sessionOrdinals.ts` owns the assignment rules).
 * The numbers must survive a reload, so the ledger lives in the `vex-ui`
 * persist payload like every other cosmetic renderer preference: display
 * memory only, ids and numbers (never a title), no IPC.
 *
 * `vex-ui` is user-writable localStorage, so {@link coerceSessionOrdinals}
 * treats every payload as hostile: anything off-shape degrades to the empty
 * ledger, which simply re-seeds from the session list.
 */

/** Every number handed out so far, and the next one. */
export interface SessionOrdinalLedger {
  readonly next: number;
  readonly byId: Readonly<Record<string, number>>;
}

export const EMPTY_ORDINAL_LEDGER: SessionOrdinalLedger = { next: 1, byId: {} };

/**
 * The ledger keeps at most this many numbers. Past it, the lowest numbers of
 * sessions the list no longer carries are forgotten first; `next` never moves
 * back, so a forgotten number is never handed out again.
 */
export const ORDINAL_LEDGER_MAX = 5000;

/** Hard bound on one stored session id (ids are UUIDs). */
const ORDINAL_ID_MAX_LENGTH = 64;

export function coerceSessionOrdinals(value: unknown): SessionOrdinalLedger {
  if (typeof value !== "object" || value === null) return EMPTY_ORDINAL_LEDGER;
  const next: unknown = Reflect.get(value, "next");
  const byId: unknown = Reflect.get(value, "byId");
  if (typeof next !== "number" || !Number.isInteger(next) || next < 1) {
    return EMPTY_ORDINAL_LEDGER;
  }
  if (typeof byId !== "object" || byId === null || Array.isArray(byId)) {
    return EMPTY_ORDINAL_LEDGER;
  }
  const entries = Object.entries(byId);
  if (entries.length > ORDINAL_LEDGER_MAX) return EMPTY_ORDINAL_LEDGER;
  const clean: Record<string, number> = {};
  for (const [id, n] of entries) {
    if (
      id.length === 0 ||
      id.length > ORDINAL_ID_MAX_LENGTH ||
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n >= next
    ) {
      return EMPTY_ORDINAL_LEDGER;
    }
    clean[id] = n;
  }
  return { next, byId: clean };
}
