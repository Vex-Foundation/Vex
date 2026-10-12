/**
 * THE SESSION ORDINAL: the italic `(02)` the left page prints beside a session
 * (docs/design/V10-SPREAD.md section 3). The session record carries no
 * number, so the ordinal is derived from what the list already returns, the
 * id and the start time, and it must stay put while the list moves under it:
 *
 *   - PINNING reorders the list (pinned rows lead), so the ordinal is never a
 *     display position;
 *   - the All | Agent | Mission tabs and the title search FILTER the list, so
 *     it is never a position inside a filter either;
 *   - REMOVING a session hides it from every later read, and the list is
 *     bounded (the oldest rows age out of it), so a rank over the current
 *     list would renumber every younger session.
 *
 * So the ordinal is a LEDGER, not a rank: the first time the renderer sees a
 * session it takes the next number, oldest first by start time (id breaks a
 * tie), and keeps it. A removed or aged-out session keeps its number in the
 * ledger, so nobody inherits it and nobody shifts; a new session takes the
 * next one. The first read on a machine seeds the ledger in start order, which
 * is exactly the rank, so a fresh install numbers 1..n.
 *
 * The ledger is display memory and nothing else: it lives in this renderer's
 * local storage under its own key, holds ids and numbers only (never a title),
 * adds no IPC and no store field, and a lost ledger re-seeds from the list. It
 * numbers the agent workspace only, the sessions the left page lists.
 */

import { useEffect, useMemo } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";

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

type OrdinalSource = Pick<SessionListItem, "id" | "startedAt">;

function startOrder(a: OrdinalSource, b: OrdinalSource): number {
  const ta = Date.parse(a.startedAt);
  const tb = Date.parse(b.startedAt);
  const sa = Number.isNaN(ta) ? 0 : ta;
  const sb = Number.isNaN(tb) ? 0 : tb;
  if (sa !== sb) return sa - sb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Number every row the ledger has not seen, oldest first, and return the new
 * ledger. Pure. Returns the SAME ledger object when there is nothing new, so a
 * caller can tell "unchanged" by identity.
 */
export function assignSessionOrdinals(
  ledger: SessionOrdinalLedger,
  rows: readonly OrdinalSource[],
): SessionOrdinalLedger {
  const unseen = rows.filter((row) => ledger.byId[row.id] === undefined);
  if (unseen.length === 0) return ledger;
  const byId: Record<string, number> = { ...ledger.byId };
  let next = ledger.next;
  for (const row of [...unseen].sort(startOrder)) {
    if (byId[row.id] !== undefined) continue;
    byId[row.id] = next;
    next += 1;
  }
  return { next, byId: pruneLedger(byId, rows) };
}

function pruneLedger(
  byId: Record<string, number>,
  rows: readonly OrdinalSource[],
): Record<string, number> {
  const ids = Object.keys(byId);
  if (ids.length <= ORDINAL_LEDGER_MAX) return byId;
  const listed = new Set(rows.map((row) => row.id));
  const forgettable = ids
    .filter((id) => !listed.has(id))
    .sort((a, b) => (byId[a] ?? 0) - (byId[b] ?? 0));
  const kept = { ...byId };
  for (const id of forgettable.slice(0, ids.length - ORDINAL_LEDGER_MAX)) {
    delete kept[id];
  }
  return kept;
}

/** `07`: two digits at least, the way the print sets every counter. */
export function ordinalDigits(n: number): string {
  return String(n).padStart(2, "0");
}

/** `(07)`: the ordinal as an index row prints it. */
export function formatOrdinal(n: number): string {
  return `(${ordinalDigits(n)})`;
}

/* ------------------------------------------------------------ persistence */

const STORAGE_KEY = "vex-session-ordinals";

function isLedger(value: unknown): value is SessionOrdinalLedger {
  if (typeof value !== "object" || value === null) return false;
  const next: unknown = Reflect.get(value, "next");
  const byId: unknown = Reflect.get(value, "byId");
  if (typeof next !== "number" || !Number.isInteger(next) || next < 1) return false;
  if (typeof byId !== "object" || byId === null || Array.isArray(byId)) return false;
  return Object.values(byId).every(
    (n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n < next,
  );
}

let memory: SessionOrdinalLedger | null = null;

/** The ledger as stored; an unreadable or malformed entry reads as empty. */
export function readOrdinalLedger(): SessionOrdinalLedger {
  if (memory !== null) return memory;
  let stored: SessionOrdinalLedger = EMPTY_ORDINAL_LEDGER;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (isLedger(parsed)) stored = parsed;
    }
  } catch {
    // Storage blocked or the entry is not JSON: re-seed from the list.
  }
  memory = stored;
  return stored;
}

function writeOrdinalLedger(ledger: SessionOrdinalLedger): void {
  memory = ledger;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
  } catch {
    // Storage full or blocked: the numbers hold for this window only.
  }
}

/** Test seam: forget the in-memory copy so the next read goes to storage. */
export function resetOrdinalLedgerMemory(): void {
  memory = null;
}

/**
 * The ordinal of every listed session, keyed by id. Pass the agent workspace
 * rows UNFILTERED (before the tab and the search), so a filter never numbers.
 * A row seen for the first time is numbered here and written back once the
 * render commits.
 */
export function useSessionOrdinals(
  rows: readonly SessionListItem[] | null,
): ReadonlyMap<string, number> {
  const ledger = useMemo(
    () => (rows === null ? readOrdinalLedger() : assignSessionOrdinals(readOrdinalLedger(), rows)),
    [rows],
  );
  useEffect(() => {
    if (ledger !== readOrdinalLedger()) writeOrdinalLedger(ledger);
  }, [ledger]);
  return useMemo(() => new Map(Object.entries(ledger.byId)), [ledger]);
}
