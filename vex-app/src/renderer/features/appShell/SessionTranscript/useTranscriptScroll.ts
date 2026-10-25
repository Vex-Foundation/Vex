/**
 * THE TRANSCRIPT'S SCROLL MODEL - the newest turn anchored at the top, with
 * reader ownership (owner, 2026-10-25, for v0.4.3; VEX Cloud parity).
 *
 * THIS REVERSES OWNER DECISION 3 (2026-08-21, commit 5d3353fa0), which
 * replaced the old top-anchor/never-follow model with follow-stream: every
 * send force-scrolled to the floor and the reply streamed up from the
 * composer, so on a long answer the reader saw only its end and the question
 * scrolled away. Now a send (or a steer) puts the reader's own turn at the TOP
 * of the view and the reply grows downward beneath it without moving the
 * view. Unlike the model decision 3 retired, the floor still follows: a reader
 * who goes to the exact floor, or takes the jump pill, gets tail following
 * back for the rest of the stream. Decision 3's ownership rule stands.
 *
 * The policy is `scrollFollow.ts` (ported from VEX Cloud, DeepSeek MIT): a
 * pure controller in one of three modes, `anchor`, `tail` or `free`. This hook
 * binds it to the scrollport and keeps what only Desktop has: load-older
 * paging, per-session position persistence and the jump pill.
 *
 * OWNERSHIP. Only reader input may take or give back the view. Every
 * programmatic write acknowledges the landed position in the controller's
 * observed-top LEDGER; a delivered position that deviates from
 * `min(ledger, floor)` by more than half a pixel is the reader, so a browser
 * shrink-clamp (which lands on the floor minimum) never is. Reader movement,
 * and any reader intent (wheel, touch, pointer, scroll keys) outside the
 * composer seat, starts one 500ms sample; growth never writes while it is
 * pending. Movement that ends away from the floor frees the view.
 *
 * THE ANCHOR. On ARRIVAL of a new live user row or a new steering mark (there
 * is no optimistic echo: the row reaches the screen only after main persists
 * it and the transcript refetches), the newest `[data-vex-entry-variant="user"]`
 * row is written to the top of the view once, `ANCHOR_AIR_PX` below it. The
 * TAIL SPACE (`[data-vex-transcript-tail]`, the last child of `SessionPanel`'s
 * session content, after the approvals and the mission controls) is sized so
 * the floor can reach that top, and shrinks as the reply, an approval card or
 * a launch form fills it. Anchored growth writes nothing; the one write left
 * restores the anchor after a browser clamp. The first turn of a session
 * whose head is loaded anchors at 0, so the day label above it stays in view.
 *
 * WHEN GROWTH IS REPORTED. One ResizeObserver (the row column, the session
 * content, the seat and the scrollport) plus every TIP MOVE in the layout
 * effect: the `followSig` of the row-order tip, the preview signature and the
 * steering mark. A chrome-only re-render (the pill appearing) leaves the
 * signature alone.
 *
 * WHERE IT SCROLLS. `scrollportOf` resolves the nearest
 * `[data-vex-conversation-scroll]` host - the resident shell's scroll body,
 * which also holds the sticky composer seat - and falls back to the
 * transcript's own element when the transcript is mounted alone (unit tests).
 * Mounted alone there is no tail space, so an anchor near the end clamps to
 * the floor.
 *
 * PAGING. A load-older prepend restores a semantic anchor (a stable row
 * identity plus its offset in scrollport coordinates), not a scrollHeight
 * delta: reader scrolls WHILE the request is in flight update it, so the
 * arriving page preserves the reader's latest intent rather than the position
 * they held at click time. Returning to the floor cancels it. The restore
 * shifts the controller's ledger by the same amount (`shifted`).
 *
 * PERSISTENCE. A free reader position is saved per session and restored
 * against its anchor row (`restore`), so a remount after a width reflow lands
 * on the same ROW rather than the same pixel. Following or anchored saves
 * null: opening the session again lands at the floor, with no tail space.
 *
 * DELIBERATE DEVIATION from the deepseek reference the paging model is ported
 * from: the paging anchor scans `[data-vex-anchor-key]` rather than
 * hit-testing with `document.elementsFromPoint`. The mounted row set is
 * already bounded by `MAX_TRANSCRIPT_PAGES`, and the scan is deterministic in
 * jsdom, where `elementsFromPoint` reports nothing.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  nearBottom,
  ScrollFollow,
  scrollMetrics,
  type FollowMode,
  type FollowPort,
} from "./scrollFollow.js";
import {
  anchorElement,
  capturePosition,
  flowTop,
  isReaderIntent,
  newestAnchorTop,
  pagingAnchor,
  READER_INTENTS,
  scrollportOf,
  sizeTail,
  TAIL_SELECTOR,
  type SavedScrollPosition,
} from "./transcriptScrollGeometry.js";

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
   * anchors it: a steer is the reader's own words entering a running turn.
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
  /**
   * Bumped every time the flow root attaches or detaches. A hook that binds to
   * `scrollNodeRef` must key its effect on this too, or it binds once against
   * the null of the loading branch and never rebinds (`useScrollbarVisibility`).
   */
  readonly scrollNodeEpoch: number;
  /** The message column - growth the controller is told about. */
  readonly columnRef: (node: HTMLDivElement | null) => void;
  /** The controller's mode, rendered as `data-vex-follow-mode` (probes, e2e). */
  readonly followMode: FollowMode;
  readonly showLatest: boolean;
  readonly jumpToLatest: () => void;
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

  const [showLatest, setShowLatest] = useState(false);
  const [followMode, setFollowMode] = useState<FollowMode>("tail");
  /** Armed at load-older, updated by reader scrolls, consumed by the prepend. */
  const pagingRef = useRef<{ key: string; top: number } | null>(null);
  /** The controller, bound to one resolved scrollport. */
  const followRef = useRef<{
    readonly scrollport: HTMLElement;
    readonly follow: ScrollFollow;
  } | null>(null);
  const headLoadedRef = useRef(!query.hasNextPage);
  headLoadedRef.current = !query.hasNextPage;

  const openedFor = useRef<string | null>(null);
  const prevOldestId = useRef(0);
  const lastIdRef = useRef(0);
  const lastSteeringRef = useRef<string | null>(null);
  const followSigRef = useRef<string | null>(null);

  // The flow TIP. Growth is reported only when this moves, never on a chrome
  // re-render - the difference between "new content arrived" and "the pill
  // appeared".
  const followSig = `${itemCount}:${oldestId}:${newestId}:${previewSig ?? ""}:${steeringSig ?? ""}`;

  // Saved continuously (the ref detaches before unmount, so saving there would
  // be too late to read the geometry). Reassigned every render for the
  // current session id.
  const persistRef = useRef(() => {});
  persistRef.current = () => {
    const local = scrollRef.current;
    const bound = followRef.current;
    if (local === null || bound === null) return;
    savePosition(
      sessionId,
      bound.follow.mode === "free"
        ? capturePosition(local, bound.scrollport)
        : null,
    );
  };

  /** The controller for the scrollport `local` resolves to, made on first use. */
  const followFor = useCallback((local: HTMLElement): ScrollFollow => {
    const scrollport = scrollportOf(local);
    const bound = followRef.current;
    if (bound !== null && bound.scrollport === scrollport) return bound.follow;
    bound?.follow.dispose();
    const port: FollowPort = {
      read: () => scrollMetrics(scrollport),
      write: (top) => {
        scrollport.scrollTop = top;
      },
      anchorTop: () => {
        const list = scrollRef.current;
        return list === null
          ? null
          : newestAnchorTop(list, scrollport, headLoadedRef.current);
      },
      reserve: (anchorTop) => {
        sizeTail(scrollport, anchorTop);
      },
    };
    const follow = new ScrollFollow(port, {
      onChange: (state) => {
        setFollowMode(state.mode);
        setShowLatest(state.behind);
        persistRef.current();
      },
    });
    followRef.current = { scrollport, follow };
    return follow;
  }, []);

  const jumpToLatest = useCallback((): void => {
    const local = scrollRef.current;
    if (local === null) return;
    pagingRef.current = null;
    // Instant, never smooth - reduced-motion safe by construction.
    followFor(local).repin();
    savePosition(sessionId, null);
  }, [followFor, sessionId]);

  const remember = (): void => {
    prevOldestId.current = oldestId;
    lastIdRef.current = newestId;
    lastSteeringRef.current = steeringSig;
    followSigRef.current = followSig;
  };

  // Runs on EVERY commit by design (no dependency array): the decision is the
  // signature comparison above, not React's identity comparison.
  useLayoutEffect(() => {
    const local = scrollRef.current;
    if (local === null) return;
    const el = scrollportOf(local);
    const follow = followFor(local);

    // FIRST LANDING for this session. Deferred until there is something to
    // land on, so an uncached session (which renders its loading branch first)
    // does not consume the landing on an empty column and open at its oldest
    // row. A saved reader position wins over the floor; neither keeps a tail
    // space.
    if (openedFor.current !== sessionId) {
      if (itemCount === 0 && previewSig === null) return;
      openedFor.current = sessionId;
      const saved = savedPositions.get(sessionId);
      if (saved === undefined) {
        follow.land();
      } else {
        // The saved pixel, corrected by where its anchor ROW sits now.
        el.scrollTop = saved.scrollTop;
        const row = anchorElement(local, saved.anchorKey);
        follow.restore(
          row === null
            ? el.scrollTop
            : el.scrollTop + flowTop(row, el) - saved.anchorTop,
        );
      }
      persistRef.current();
      remember();
      return;
    }

    // PREPEND: the head moved older with an armed paging anchor. Restore the
    // anchored row to the offset the reader's LATEST scroll established, which
    // excludes unrelated tail growth that landed while the request was in
    // flight, and move the ledger with it.
    if (
      pagingRef.current !== null &&
      oldestId !== 0 &&
      prevOldestId.current !== 0 &&
      oldestId < prevOldestId.current
    ) {
      const anchor = pagingRef.current;
      pagingRef.current = null;
      const row = anchorElement(local, anchor.key);
      if (row !== null) {
        const before = el.scrollTop;
        el.scrollTop += flowTop(row, el) - anchor.top;
        follow.shifted(el.scrollTop - before);
      }
      remember();
      return;
    }

    // Own words go to the top. Detected on ARRIVAL rather than armed at the
    // send, because there is no optimistic echo.
    const appendedUser =
      newestId !== lastIdRef.current &&
      newestVariant === "user" &&
      newestIsLiveAppend;
    const appendedSteering =
      steeringSig !== null && steeringSig !== lastSteeringRef.current;
    const tipMoved = followSigRef.current !== followSig;
    remember();
    if (appendedUser || appendedSteering) {
      pagingRef.current = null;
      follow.anchor();
      persistRef.current();
      return;
    }
    if (tipMoved) follow.onGrowth();
  });

  // Reassigned every render so the handler always reads current props without
  // rebinding the listener (which would drop scroll events mid-gesture).
  const onScrollRef = useRef(() => {});
  onScrollRef.current = () => {
    const local = scrollRef.current;
    if (local === null) return;
    const el = scrollportOf(local);
    followFor(local).onScroll();

    // The paging anchor follows the reader while a page is in flight, and
    // returning to the floor cancels it.
    if (nearBottom(scrollMetrics(el))) {
      pagingRef.current = null;
    } else if (pagingRef.current !== null) {
      const position = capturePosition(local, el);
      if (position !== null) {
        pagingRef.current = { key: position.anchorKey, top: position.anchorTop };
      }
    }
    persistRef.current();

    // PAGING is independent of follow ownership: whether the head came into
    // reach by a reader gesture or by a clamp, the page above it is missing
    // either way.
    if (el.scrollTop >= LOAD_OLDER_THRESHOLD_PX) return;
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    const row = pagingAnchor(local, el);
    const key = row?.dataset.vexAnchorKey;
    if (row !== null && key !== undefined) {
      pagingRef.current = { key, top: flowTop(row, el) };
    }
    void query.fetchNextPage();
  };

  // The listeners, on the RESOLVED scrollport: `scroll` and `scrollend`, and
  // the reader intents (capturing and passive). An intent inside the composer
  // seat is ignored, so typing or clicking in the composer never unpins.
  useEffect(() => {
    const local = scrollRef.current;
    if (local === null) return;
    const el = scrollportOf(local);
    const onScroll = (): void => {
      onScrollRef.current();
    };
    const onScrollEnd = (): void => {
      followFor(local).onScrollEnd();
    };
    const onIntent = (event: Event): void => {
      if (isReaderIntent(event)) followFor(local).onIntent();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", onScrollEnd, { passive: true });
    for (const type of READER_INTENTS) {
      el.addEventListener(type, onIntent, { passive: true, capture: true });
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", onScrollEnd);
      for (const type of READER_INTENTS) {
        el.removeEventListener(type, onIntent, { capture: true });
      }
    };
  }, [nodeEpoch, followFor]);

  // Unmount: stop the sample timer and drop the tail space (the scrollport
  // outlives this transcript).
  useEffect(
    () => () => {
      const bound = followRef.current;
      if (bound === null) return;
      bound.follow.dispose();
      sizeTail(bound.scrollport, null);
      followRef.current = null;
    },
    [],
  );

  // A failed or empty older page leaves the head unchanged, so once the
  // request leaves its busy state there is no future prepend for the anchor to
  // own. Runs AFTER the layout effect above in the same commit, so a page that
  // did land has already consumed it.
  useEffect(() => {
    if (!query.isFetchingNextPage) pagingRef.current = null;
  }, [query.isFetchingNextPage]);

  // ONE observer reports every dynamic-height consequence to the controller,
  // which follows the tail, holds the anchored turn or leaves the reader be:
  //   - the message column grows (streaming, disclosure toggles);
  //   - the session content grows (an approval card, a mission control, a
  //     banner after the transcript), seen through the tail's siblings;
  //   - the composer seat grows (a growing draft, the queue dock), and
  //     `--vex-composer-height` is republished so the jump pill keeps
  //     clearing the seat;
  //   - the scrollport itself resizes (window, rails).
  // `--vex-composer-height` lives here rather than with the seat because this
  // model is its only consumer, and a second writer would be a second source
  // of truth for the same geometry.
  useEffect(() => {
    const local = scrollRef.current;
    const column = columnRef.current;
    if (local === null || column === null) return;
    if (typeof ResizeObserver === "undefined") return;
    const el = scrollportOf(local);
    const seat = el.querySelector<HTMLElement>("[data-vex-composer-seat]");
    const tail = el.querySelector<HTMLElement>(TAIL_SELECTOR);
    const observer = new ResizeObserver(() => {
      if (seat !== null) {
        el.style.setProperty("--vex-composer-height", `${seat.offsetHeight}px`);
      }
      followFor(local).onGrowth();
    });
    observer.observe(column);
    observer.observe(el);
    if (seat !== null) observer.observe(seat);
    // The session content's growth is observed through the tail's SIBLINGS,
    // never the content box itself: the callback resizes the tail, and a
    // resize of an observed box shallower than the column inside the callback
    // is the "ResizeObserver loop completed with undelivered notifications"
    // error.
    for (const sibling of tail?.parentElement?.children ?? []) {
      if (sibling !== tail) observer.observe(sibling);
    }
    return () => {
      observer.disconnect();
    };
  }, [nodeEpoch, followFor]);

  return {
    scrollRef: setScrollNode,
    scrollNodeRef: scrollRef,
    scrollNodeEpoch: nodeEpoch,
    columnRef: setColumnNode,
    followMode,
    showLatest,
    jumpToLatest,
  };
}
