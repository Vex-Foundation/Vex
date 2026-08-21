/**
 * THE TRANSCRIPT'S SCROLL MODEL — follow-stream with reader ownership
 * (owner decision 3, 2026-08-21; replaces the top-anchor/never-follow model).
 *
 * The rule the whole file exists to enforce: **only reader input may change
 * follow ownership.** While the reader is pinned to the floor the transcript
 * follows the tip of the conversation; the moment the reader scrolls away it
 * stops and offers the jump instead of taking it. Nothing else — not a
 * streamed delta, not a disclosure toggle, not a growing draft, not a browser
 * shrink-clamp, not a late programmatic delivery — is allowed to arm or
 * disarm follow.
 *
 * HOW OWNERSHIP IS ATTRIBUTED. Every programmatic write records the resulting
 * position in `observedTop` synchronously. The scroll handler then asks
 * whether the delivered position deviates from that ledger by more than half a
 * pixel; only a deviation is reader input. This covers wheel, touch, drag,
 * scrollbar and keyboard without naming a single device, and it is exactly why
 * the two hostile cases behave: a browser shrink-clamp lands on the floor
 * minimum (inside the ledger, ownership preserved), and a compositor that
 * advanced geometry before delivering the event still compares against the
 * ledger rather than against already-moved raw geometry.
 *
 * WHEN FOLLOW ACTUALLY FIRES. Not on every render — on every TIP MOVE. The
 * layout effect compares a `followSig` assembled from the row-order tip, the
 * preview signature and the steering mark; a chrome-only re-render (the pill
 * appearing because the reader crossed the threshold) leaves the signature
 * alone, so entering the threshold never snaps the remaining distance to the
 * floor. Two arrivals force the scroll unconditionally, pinned or not, because
 * the reader's OWN WORDS must be visible: a new trailing live user row, and a
 * new steering mark.
 *
 * WHERE IT SCROLLS. `scrollportOf` resolves the nearest
 * `[data-vex-conversation-scroll]` host — the resident shell's scroll body,
 * which also holds the sticky composer seat — and falls back to the
 * transcript's own element when the transcript is mounted alone (unit tests).
 * Bottom-follow, paging anchors and position persistence always target the
 * resolved scrollport, never whichever element happens to hold the rows.
 *
 * PAGING. A load-older prepend restores a semantic anchor (a stable row
 * identity plus its offset in scrollport coordinates), not a scrollHeight
 * delta: reader scrolls WHILE the request is in flight update the anchor, so
 * the arriving page preserves the reader's latest intent rather than the
 * position they held at click time. Returning to the floor cancels the anchor.
 *
 * PERSISTENCE. A non-pinned reader position is saved per session and restored
 * against its anchor row, so a remount after a width reflow lands on the same
 * ROW rather than the same pixel. Pinned saves null: a remount keeps
 * following.
 *
 * DELIBERATE DEVIATION from the deepseek reference this model is ported from:
 * the paging anchor scans `[data-vex-anchor-key]` rather than hit-testing with
 * `document.elementsFromPoint`. The mounted row set is already bounded by
 * `MAX_TRANSCRIPT_PAGES`, and the scan is deterministic in jsdom, where
 * `elementsFromPoint` reports nothing.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** At-bottom band. A reader inside it is still "pinned" and keeps following. */
const FOLLOW_THRESHOLD_PX = 24;
/** Proximity to the head that arms an older-page fetch. */
const LOAD_OLDER_THRESHOLD_PX = 64;
/** How many sessions' reader positions are retained. Oldest evicted first. */
const SAVED_POSITION_LIMIT = 32;

/** The slice of the infinite query the scroll model needs (structural). */
interface OlderPageQuery {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
}

/** A reflow-resistant reader position: a row identity plus where it sat. */
interface SavedScrollPosition {
  readonly anchorKey: string;
  readonly anchorTop: number;
  readonly scrollTop: number;
}

/**
 * Per-session reader positions. Renderer-local and display-only: nothing here
 * reaches main, the model, or durable storage. Bounded so a long session
 * hopping run cannot grow it without limit.
 */
const savedPositions = new Map<string, SavedScrollPosition>();

function savePosition(
  sessionId: string,
  position: SavedScrollPosition | null,
): void {
  if (position === null) {
    savedPositions.delete(sessionId);
    return;
  }
  // Re-insert so the entry moves to the tail of the insertion order and the
  // eviction below always drops the least recently written session.
  savedPositions.delete(sessionId);
  savedPositions.set(sessionId, position);
  while (savedPositions.size > SAVED_POSITION_LIMIT) {
    const oldest = savedPositions.keys().next();
    if (oldest.done === true) break;
    savedPositions.delete(oldest.value);
  }
}

/** Test seam: drop every retained position (per-test isolation). */
export function clearSavedScrollPositions(): void {
  savedPositions.clear();
}

interface TranscriptScrollInput {
  readonly sessionId: string;
  readonly query: OlderPageQuery;
  readonly itemCount: number;
  readonly newestId: number;
  readonly oldestId: number;
  readonly newestVariant: string | null;
  readonly newestIsLiveAppend: boolean;
  /** Signature of every VISIBLE preview change; null when no turn is live. */
  readonly previewSig: string | null;
  /**
   * Identity of the newest steering mark in the loaded rows, or null. A change
   * force-scrolls: a steer is the reader's own words entering a running turn.
   */
  readonly steeringSig: string | null;
}

interface TranscriptScroll {
  /**
   * CALLBACK ref for the transcript's flow root (also the scroller when
   * mounted standalone). A callback rather than an object ref because the
   * transcript renders its loading/error/empty branches FIRST: an effect with
   * a mount-time dependency list would run while the node is still null and
   * never bind the scroll listener when the rows finally arrive.
   */
  readonly scrollRef: (node: HTMLDivElement | null) => void;
  /** The same node as an object ref, for hooks that take one. */
  readonly scrollNodeRef: RefObject<HTMLDivElement | null>;
  /** The message column — the growth this model follows while pinned. */
  readonly columnRef: (node: HTMLDivElement | null) => void;
  readonly showLatest: boolean;
  readonly jumpToLatest: () => void;
}

/** The resident shell's scroll body, or this element when mounted alone. */
function scrollportOf(from: HTMLElement): HTMLElement {
  return from.closest<HTMLElement>("[data-vex-conversation-scroll]") ?? from;
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return (
    row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
  );
}

function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>(
    "[data-vex-anchor-key]",
  )) {
    if (row.dataset.vexAnchorKey === key) return row;
  }
  return null;
}

/** The topmost row still visible in the scrollport; the head row otherwise. */
function pagingAnchor(
  list: HTMLElement,
  scrollport: HTMLElement,
): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect();
  const rows = [
    ...list.querySelectorAll<HTMLElement>("[data-vex-anchor-key]"),
  ];
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) return row;
  }
  return rows[0] ?? null;
}

function capturePosition(
  list: HTMLElement,
  scrollport: HTMLElement,
): SavedScrollPosition | null {
  const row = pagingAnchor(list, scrollport);
  const anchorKey = row?.dataset.vexAnchorKey;
  if (row === null || anchorKey === undefined) return null;
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  };
}

export function useTranscriptScroll({
  sessionId,
  query,
  itemCount,
  newestId,
  oldestId,
  newestVariant,
  newestIsLiveAppend,
  previewSig,
  steeringSig,
}: TranscriptScrollInput): TranscriptScroll {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  // Bumped whenever either node attaches or detaches, so the listener and the
  // observer below re-bind on the commit the rows actually mount in.
  const [nodeEpoch, setNodeEpoch] = useState(0);
  const setScrollNode = useCallback((node: HTMLDivElement | null): void => {
    scrollRef.current = node;
    setNodeEpoch((epoch) => epoch + 1);
  }, []);
  const setColumnNode = useCallback((node: HTMLDivElement | null): void => {
    columnRef.current = node;
    setNodeEpoch((epoch) => epoch + 1);
  }, []);

  const atBottomRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  /** Last position delivered or written by this model. See the header. */
  const observedTopRef = useRef(0);
  /** Armed at load-older, updated by reader scrolls, consumed by the prepend. */
  const anchorRef = useRef<{ key: string; top: number } | null>(null);

  const openedFor = useRef<string | null>(null);
  const prevOldestId = useRef(0);
  const lastIdRef = useRef(0);
  const lastSteeringRef = useRef<string | null>(null);
  const followSigRef = useRef<string | null>(null);

  // The flow TIP. Follow fires only when this moves, never on a chrome
  // re-render — the difference between "new content arrived" and "the pill
  // appeared", which is what keeps entering the threshold from snapping.
  const followSig = `${itemCount}:${oldestId}:${newestId}:${previewSig ?? ""}:${steeringSig ?? ""}`;

  const toBottom = useCallback(
    (el: HTMLElement): void => {
      anchorRef.current = null;
      el.scrollTop = el.scrollHeight;
      observedTopRef.current = el.scrollTop;
      atBottomRef.current = true;
      setShowLatest(false);
      savePosition(sessionId, null);
    },
    [sessionId],
  );

  const jumpToLatest = useCallback((): void => {
    const local = scrollRef.current;
    if (local === null) return;
    // Instant, never smooth — reduced-motion safe by construction.
    toBottom(scrollportOf(local));
  }, [toBottom]);

  const remember = (): void => {
    prevOldestId.current = oldestId;
    lastIdRef.current = newestId;
    lastSteeringRef.current = steeringSig;
    followSigRef.current = followSig;
  };

  // Runs on EVERY commit by design (no dependency array): the decision is the
  // signature comparison above, not React's identity comparison. A dependency
  // list here would silently re-add the "re-pin on any render" bug.
  useLayoutEffect(() => {
    const local = scrollRef.current;
    if (local === null) return;
    const el = scrollportOf(local);

    // FIRST LANDING for this session. Deferred until there is something to
    // land on, so an uncached session (which renders its loading branch first)
    // does not consume the landing on an empty column and open at its oldest
    // row. A saved reader position wins over the floor jump.
    if (openedFor.current !== sessionId) {
      if (itemCount === 0 && previewSig === null) return;
      openedFor.current = sessionId;
      const saved = savedPositions.get(sessionId);
      if (saved === undefined) {
        toBottom(el);
      } else {
        el.scrollTop = saved.scrollTop;
        const row = anchorElement(local, saved.anchorKey);
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop;
        observedTopRef.current = el.scrollTop;
        // The restore may have been clamped (a narrower window, a shorter
        // transcript). Re-derive ownership from where it actually landed.
        const floor = Math.max(0, el.scrollHeight - el.clientHeight);
        const isAtBottom = floor - el.scrollTop <= FOLLOW_THRESHOLD_PX + 1;
        atBottomRef.current = isAtBottom;
        setShowLatest(!isAtBottom);
        savePosition(
          sessionId,
          isAtBottom ? null : capturePosition(local, el),
        );
      }
      remember();
      return;
    }

    // PREPEND: the head moved older with an armed anchor. Restore the anchored
    // row to the offset the reader's LATEST scroll established, which excludes
    // unrelated tail growth that landed while the request was in flight.
    if (
      anchorRef.current !== null &&
      oldestId !== 0 &&
      prevOldestId.current !== 0 &&
      oldestId < prevOldestId.current
    ) {
      const anchor = anchorRef.current;
      anchorRef.current = null;
      const row = anchorElement(local, anchor.key);
      if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top;
      observedTopRef.current = el.scrollTop;
      remember();
      return;
    }

    // Own words must be visible. Detected on ARRIVAL rather than armed at the
    // send, because there is no optimistic echo: the user row reaches the
    // screen only after main persists it and the transcript refetches.
    const appendedUser =
      newestId !== lastIdRef.current &&
      newestVariant === "user" &&
      newestIsLiveAppend;
    const appendedSteering =
      steeringSig !== null && steeringSig !== lastSteeringRef.current;
    const tipMoved = followSigRef.current !== followSig;
    remember();
    if (appendedUser || appendedSteering || (tipMoved && atBottomRef.current)) {
      toBottom(el);
    }
  });

  // Reassigned every render so the handler always reads current props without
  // rebinding the listener (which would drop scroll events mid-gesture).
  const onScrollRef = useRef(() => {});
  onScrollRef.current = () => {
    const local = scrollRef.current;
    if (local === null) return;
    const el = scrollportOf(local);

    // PAGING is independent of follow ownership: whether the head came into
    // reach by a reader gesture or by a clamp, the page below it is missing
    // either way. Called from BOTH exits of the ownership block below so a
    // re-pin can never swallow it.
    const maybeLoadOlder = (): void => {
      if (el.scrollTop >= LOAD_OLDER_THRESHOLD_PX) return;
      if (!query.hasNextPage || query.isFetchingNextPage) return;
      const row = pagingAnchor(local, el);
      const key = row?.dataset.vexAnchorKey;
      if (row !== null && key !== undefined) {
        anchorRef.current = { key, top: flowTop(row, el) };
      }
      void query.fetchNextPage();
    };

    const floor = Math.max(0, el.scrollHeight - el.clientHeight);
    const movedByReader =
      Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5;
    const isAtBottom = movedByReader
      ? floor - el.scrollTop <= FOLLOW_THRESHOLD_PX + 1
      : atBottomRef.current;
    // A non-reader event that finds us still pinned re-pins: this is the
    // shrink-clamp delivery, and letting it stand would leave the floor a few
    // pixels away with follow still armed.
    if (!movedByReader && isAtBottom) {
      toBottom(el);
      maybeLoadOlder();
      return;
    }
    atBottomRef.current = isAtBottom;
    setShowLatest(!isAtBottom);
    const position = isAtBottom ? null : capturePosition(local, el);
    if (isAtBottom) {
      anchorRef.current = null;
    } else if (anchorRef.current !== null && position !== null) {
      anchorRef.current = { key: position.anchorKey, top: position.anchorTop };
    }
    // Saved continuously: the ref detaches before unmount, so saving there
    // would be too late to read the geometry.
    savePosition(sessionId, position);
    observedTopRef.current = el.scrollTop;
    maybeLoadOlder();
  };

  // One listener per attached scroller, on the RESOLVED scrollport. Reader
  // attribution rides the observed-top ledger, so no per-device listeners are
  // needed.
  useEffect(() => {
    const local = scrollRef.current;
    if (local === null) return;
    const el = scrollportOf(local);
    const onScroll = (): void => {
      onScrollRef.current();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [nodeEpoch]);

  // A failed or empty older page leaves the head unchanged, so once the
  // request leaves its busy state there is no future prepend for the anchor to
  // own. Runs AFTER the layout effect above in the same commit, so a page that
  // did land has already consumed it.
  useEffect(() => {
    if (!query.isFetchingNextPage) anchorRef.current = null;
  }, [query.isFetchingNextPage]);

  // ONE observer owns every dynamic-height consequence:
  //   - the message column grows (streaming, disclosure toggles) → follow, but
  //     ONLY while the reader is pinned;
  //   - the composer seat grows (a growing draft, the queue dock) → follow,
  //     and republish `--vex-composer-height` so the floating jump pill keeps
  //     clearing the seat;
  //   - the scrollport itself resizes (window, rails) → republish
  //     `--vex-conversation-viewport`, the height the centred working scene
  //     centres itself in without contributing to `scrollHeight`.
  // The two variables live here rather than with the seat because this model
  // is the only consumer of both, and a second writer would be a second source
  // of truth for the same geometry.
  useEffect(() => {
    const local = scrollRef.current;
    const column = columnRef.current;
    if (local === null || column === null) return;
    if (typeof ResizeObserver === "undefined") return;
    const el = scrollportOf(local);
    const seat = el.querySelector<HTMLElement>("[data-vex-composer-seat]");
    const observer = new ResizeObserver(() => {
      if (seat !== null) {
        el.style.setProperty("--vex-composer-height", `${seat.offsetHeight}px`);
      }
      el.style.setProperty(
        "--vex-conversation-viewport",
        `${el.clientHeight}px`,
      );
      if (!atBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
      observedTopRef.current = el.scrollTop;
      savePosition(sessionId, null);
    });
    observer.observe(column);
    observer.observe(el);
    if (seat !== null) observer.observe(seat);
    return () => {
      observer.disconnect();
    };
  }, [sessionId, nodeEpoch]);

  return {
    scrollRef: setScrollNode,
    scrollNodeRef: scrollRef,
    columnRef: setColumnNode,
    showLatest,
    jumpToLatest,
  };
}
