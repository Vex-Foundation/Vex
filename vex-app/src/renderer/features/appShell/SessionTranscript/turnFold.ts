/**
 * THE TURN'S FOLD (docs/design/H3-DESKTOP.md section 1.7; VEX Cloud's built
 * trace, `LiveThread.tsx` `useAutoFold` and `TraceCard.tsx`). Per turn, in
 * renderer memory, keyed by the person's message that opened it:
 *
 *  - a turn reopened from history starts folded: its head alone;
 *  - a turn running now stands open, its steps arriving under the head;
 *  - when that turn settles it folds itself `FOLD_DELAY_MS` later, unless the
 *    person pressed its head (the press is respected, also after it settles);
 *  - the head's press opens or shuts the turn at any time;
 *  - a stopped or failed turn never folds (its head is a label), which the
 *    caller decides (`shut`).
 *
 * RUNNING. The newest turn runs while the transcript shows a live turn and
 * rows of that turn arrive live (outside the settled set): new rows are what
 * proves the steps belong to the turn in flight. A send whose own message has
 * not landed yet leaves the turn above it as it was, so it never reopens.
 * A mission or wake round that writes into the newest turn reopens it, unless
 * the person pressed its head.
 *
 * Nothing here is persisted or sent; a remount starts every turn folded.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/** How long a settled turn stays open before it folds itself (Cloud's `FOLD_DELAY_MS`). */
export const FOLD_DELAY_MS = 900;

interface FoldEntry {
  readonly open: boolean;
  /** The person pressed the head: no fold of its own may override them. */
  readonly pressed: boolean;
}

interface FoldState {
  readonly sessionId: string;
  readonly entries: ReadonlyMap<number, FoldEntry>;
  /** The turn marked running by the last live arrival, or null. */
  readonly running: number | null;
}

const NO_ENTRIES: ReadonlyMap<number, FoldEntry> = new Map();

function withEntry(
  entries: ReadonlyMap<number, FoldEntry>,
  anchorId: number,
  entry: FoldEntry,
): ReadonlyMap<number, FoldEntry> {
  const next = new Map(entries);
  next.set(anchorId, entry);
  return next;
}

export interface TurnFoldInput {
  readonly sessionId: string;
  /** The newest whole turn's opening message, or null. */
  readonly lastAnchorId: number | null;
  /** Rows of the newest turn, its opening message included, that arrived live. */
  readonly lastLiveRows: number;
  /** The transcript shows a turn in flight. */
  readonly live: boolean;
}

export interface TurnFold {
  /** Whether the turn's steps are shown. */
  readonly isOpen: (anchorId: number) => boolean;
  /** The turn running now, whose head reads "Working", or null. */
  readonly runningAnchorId: number | null;
  /** The head's press. */
  readonly toggle: (anchorId: number) => void;
  /** Open a shut turn for find in page or focus inside it. */
  readonly reveal: (anchorId: number) => void;
}

export function useTurnFold({
  sessionId,
  lastAnchorId,
  lastLiveRows,
  live,
}: TurnFoldInput): TurnFold {
  const [state, setState] = useState<FoldState>(() => ({
    sessionId,
    entries: NO_ENTRIES,
    running: null,
  }));
  const current: FoldState =
    state.sessionId === sessionId
      ? state
      : { sessionId, entries: NO_ENTRIES, running: null };

  // Until the first effect after a live arrival has marked the turn, it reads
  // as running on its own first paint, so it never flashes shut.
  const runningAnchorId = !live || lastAnchorId === null
    ? null
    : current.running === lastAnchorId ||
        (lastLiveRows > 0 && !current.entries.has(lastAnchorId))
      ? lastAnchorId
      : null;

  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const seen = useRef<{ sessionId: string; anchorId: number | null; rows: number }>({
    sessionId,
    anchorId: null,
    rows: 0,
  });

  const clearTimer = useCallback((anchorId: number) => {
    const timer = timers.current.get(anchorId);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(anchorId);
  }, []);

  useEffect(() => {
    const prior = seen.current;
    const sameSession = prior.sessionId === sessionId;
    const arrived =
      lastAnchorId !== null &&
      lastLiveRows > 0 &&
      (!sameSession || prior.anchorId !== lastAnchorId || lastLiveRows > prior.rows);
    seen.current = { sessionId, anchorId: lastAnchorId, rows: lastLiveRows };

    let entries = current.entries;
    let running = current.running;

    // The turn that ran has settled (or a newer one took over): it folds
    // itself after the delay, unless the person pressed its head by then.
    if (running !== null && (!live || running !== lastAnchorId)) {
      const settled = running;
      running = null;
      clearTimer(settled);
      timers.current.set(
        settled,
        setTimeout(() => {
          timers.current.delete(settled);
          setState((prev) => {
            const entry = prev.entries.get(settled);
            if (prev.sessionId !== sessionId || entry === undefined || entry.pressed || !entry.open) {
              return prev;
            }
            return { ...prev, entries: withEntry(prev.entries, settled, { open: false, pressed: false }) };
          });
        }, FOLD_DELAY_MS),
      );
    }

    if (live && arrived && lastAnchorId !== null) {
      clearTimer(lastAnchorId);
      const entry = entries.get(lastAnchorId);
      if (entry === undefined || (!entry.pressed && !entry.open)) {
        entries = withEntry(entries, lastAnchorId, { open: true, pressed: false });
      }
      running = lastAnchorId;
    } else if (lastAnchorId !== null && running !== lastAnchorId && !entries.has(lastAnchorId)) {
      // The newest turn, seen settled: it keeps its fold from here on, so a
      // later send whose message has not landed yet never reopens it.
      entries = withEntry(entries, lastAnchorId, { open: false, pressed: false });
    }

    if (entries !== current.entries || running !== current.running || state !== current) {
      setState({ sessionId, entries, running });
    }
    // `current` and `state` are read as of this render on purpose: the effect
    // runs once per change of what the turn shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, lastAnchorId, lastLiveRows, live, clearTimer]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const entries = current.entries;
  const isOpen = useCallback(
    (anchorId: number) => entries.get(anchorId)?.open ?? anchorId === runningAnchorId,
    [entries, runningAnchorId],
  );

  const set = useCallback(
    (anchorId: number, open: (was: boolean) => boolean) => {
      clearTimer(anchorId);
      setState((prev) => {
        const base: FoldState =
          prev.sessionId === sessionId ? prev : { sessionId, entries: NO_ENTRIES, running: null };
        const was = base.entries.get(anchorId)?.open ?? anchorId === runningAnchorId;
        return { ...base, entries: withEntry(base.entries, anchorId, { open: open(was), pressed: true }) };
      });
    },
    [clearTimer, runningAnchorId, sessionId],
  );
  const toggle = useCallback((anchorId: number) => set(anchorId, (was) => !was), [set]);
  const reveal = useCallback((anchorId: number) => set(anchorId, () => true), [set]);

  return useMemo(
    () => ({ isOpen, runningAnchorId, toggle, reveal }),
    [isOpen, runningAnchorId, toggle, reveal],
  );
}

/** What a turn's head and its step groups read of the fold. */
export interface TurnFoldView {
  /** Turns whose steps are folded away now (never a stopped or failed one). */
  readonly shut: ReadonlySet<number>;
  readonly runningAnchorId: number | null;
  readonly toggle: (anchorId: number) => void;
  readonly reveal: (anchorId: number) => void;
}

/** No provider: a row drawn on its own never folds. */
export const TurnFoldContext = createContext<TurnFoldView | null>(null);

export function useTurnFoldView(): TurnFoldView | null {
  return useContext(TurnFoldContext);
}
