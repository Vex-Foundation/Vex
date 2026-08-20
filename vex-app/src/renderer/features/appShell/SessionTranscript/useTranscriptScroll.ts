/**
 * The transcript's entire scroll model (owner decree 2026-07-29 — CHAT NEVER
 * AUTO-SCROLLS DURING STREAMING). Exactly ONE arrival moves the viewport: a
 * just-sent USER message anchors at the viewport TOP, so the reply streams
 * into the space below it (the trailing anchor spacer guarantees the scroll
 * range). EVERY other new row — assistant text, tool rows, every growth tick
 * of the live preview — moves nothing at all. When newer content lands out of
 * view, the "latest" pill offers the jump instead of taking it. Session
 * change still jumps to newest. Load-older prepends are held steady by
 * restoring the scrollHeight delta — and ONLY for that intentional prepend.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
const PINNED_THRESHOLD_PX = 48;
const LOAD_OLDER_THRESHOLD_PX = 64;

/** The slice of the infinite query the scroll model needs (structural). */
interface OlderPageQuery {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
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
}

interface TranscriptScroll {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly anchorSpacerRef: RefObject<HTMLDivElement | null>;
  readonly showLatest: boolean;
  readonly jumpToLatest: () => void;
  readonly onScroll: () => void;
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
}: TranscriptScrollInput): TranscriptScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorSpacerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // Set ONLY by an intentional load-older fetch; consumed by the settle effect
  // below for scroll restoration. It never gates fetching or bottom-follow, so
  // it cannot wedge the transcript even if the older fetch fails.
  const prependAnchor = useRef<{
    readonly prevHeight: number;
    readonly prevOldestId: number;
  } | null>(null);

  // "latest" pill visibility. Derived by MEASUREMENT, never by guessing: the
  // pill exists to say "there is newer content below the fold", so the one
  // honest source is the live distance from the bottom. Every caller (scroll,
  // a new row, a preview tick) funnels through here, which is why the pill can
  // never desync from what the reader can actually see. It also keeps
  // `pinnedToBottom` — the load-older/anchor bookkeeping — in step.
  const [showLatest, setShowLatest] = useState(false);
  const syncLatestVisibility = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distanceFromBottom < PINNED_THRESHOLD_PX;
    pinnedToBottom.current = pinned;
    setShowLatest(!pinned);
  }, []);

  // The SAME measurement, coalesced to one per animation frame. Reading
  // scrollHeight/scrollTop/clientHeight forces a synchronous layout, so doing
  // it once per streamed growth tick made the reflow the stream's own cost
  // (owner decree 2026-08-03). A frame is the finest cadence the pill can
  // actually be seen changing at, and the trailing edge is guaranteed: the
  // last scheduled frame always runs, so the pill can never settle on a stale
  // measurement.
  const latestSyncFrame = useRef<number | null>(null);
  const scheduleLatestSync = useCallback((): void => {
    if (latestSyncFrame.current !== null) return;
    latestSyncFrame.current = window.requestAnimationFrame(() => {
      latestSyncFrame.current = null;
      syncLatestVisibility();
    });
  }, [syncLatestVisibility]);
  useEffect(
    () => () => {
      if (latestSyncFrame.current !== null) {
        window.cancelAnimationFrame(latestSyncFrame.current);
      }
    },
    [],
  );

  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    // Instant, never smooth — reduced-motion safe by construction.
    el.scrollTop = el.scrollHeight;
    pinnedToBottom.current = true;
    setShowLatest(false);
  }, []);

  // Session change → jump to the newest message. The anchor spacer is zeroed
  // FIRST so the jump lands on real content, not send-time run-out space.
  useEffect(() => {
    pinnedToBottom.current = true;
    setShowLatest(false);
    prependAnchor.current = null;
    const spacer = anchorSpacerRef.current;
    if (spacer !== null) spacer.style.height = "0px";
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  // FIRST PAGE LANDED → jump to newest. The session-change effect above can
  // only reach the scroller when one is already mounted; opening an UNCACHED
  // session renders the loading branch first, so that effect finds
  // `scrollRef.current === null` and the transcript would otherwise open at
  // its OLDEST visible row. This layout effect is the landing counterpart: it
  // fires once per session, on the commit where rows first exist, before paint.
  // Declared ABOVE the newest-row effect on purpose — if the same commit also
  // carries a live user append, that effect runs after and its top-anchor wins.
  const bottomJumpedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (bottomJumpedFor.current === sessionId || itemCount === 0) return;
    const el = scrollRef.current;
    if (el === null) return;
    bottomJumpedFor.current = sessionId;
    el.scrollTop = el.scrollHeight;
    pinnedToBottom.current = true;
    setShowLatest(false);
  }, [sessionId, itemCount]);

  // New newest message. A just-SENT user message (a LIVE append) anchors at
  // the viewport TOP: the reading position for the reply streaming in below
  // it, with the trailing spacer guaranteeing the scroll range even when
  // nothing follows yet. A HISTORICAL user row (opening an old session) never
  // anchors. EVERY other newest row moves nothing — the old "bottom-follow
  // while pinned" branch is deliberately gone; it is replaced by the pill,
  // which offers the jump instead of taking it. A load-older prepend never
  // changes `newestId`, so this stays quiet during one. Scrolls are instant
  // (no smooth) — reduced-motion safe.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null || newestId === 0) return;
    if (newestVariant === "user" && newestIsLiveAppend) {
      const target = el.querySelector(
        `[data-vex-entry-id="${newestId}"][data-vex-entry-variant="user"]`,
      );
      if (target instanceof HTMLElement) {
        const spacer = anchorSpacerRef.current;
        if (spacer !== null) {
          spacer.style.height = `${Math.max(0, el.clientHeight - 96)}px`;
        }
        const gap = 12;
        el.scrollTop =
          target.getBoundingClientRect().top -
          el.getBoundingClientRect().top +
          el.scrollTop -
          gap;
        pinnedToBottom.current = false;
        setShowLatest(false);
        return;
      }
    }
    syncLatestVisibility();
  }, [newestId, newestVariant, newestIsLiveAppend, syncLatestVisibility]);

  // Every visible preview change re-measures whether the growing bubble has
  // left the viewport. It NEVER drives a scroll.
  useEffect(() => {
    if (previewSig === null) return;
    // Frame-coalesced: a growth tick asks for a measurement, it does not take
    // one. See `scheduleLatestSync`.
    scheduleLatestSync();
  }, [previewSig, scheduleLatestSync]);

  // Turn settled (stream → null): retire the anchor run-out. The spacer's job
  // was to guarantee scroll range WHILE the reply streamed below the anchored
  // user message; once the turn is complete, "scrolled to bottom" must mean
  // the last message sits flush with the bottom edge — no dead space (owner
  // order). If the viewport was inside the removed range the browser clamps
  // scrollTop, which lands exactly on that flush state; a reader anchored
  // above a long reply sees no movement at all.
  const hadPreview = useRef(false);
  useEffect(() => {
    const had = hadPreview.current;
    hadPreview.current = previewSig !== null;
    if (!had || previewSig !== null) return;
    const spacer = anchorSpacerRef.current;
    if (spacer !== null) spacer.style.height = "0px";
    // Retiring the spacer CHANGES the scroll geometry (scrollHeight shrinks,
    // and the browser may clamp scrollTop), so the pill must be re-derived
    // from the new measurements — a stale pill would point at a bottom that
    // is already in view.
    syncLatestVisibility();
  }, [previewSig, syncLatestVisibility]);

  // After an intentional older-page fetch settles, hold the viewport if a page
  // was actually prepended (oldest id changed); clear the anchor either way —
  // success OR failure — so it can never gate a later load or bottom-follow.
  useLayoutEffect(() => {
    if (query.isFetchingNextPage) return;
    const anchor = prependAnchor.current;
    if (anchor === null) return;
    const el = scrollRef.current;
    if (el !== null && oldestId !== anchor.prevOldestId) {
      el.scrollTop += el.scrollHeight - anchor.prevHeight;
    }
    prependAnchor.current = null;
  }, [query.isFetchingNextPage, oldestId]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    syncLatestVisibility();
    if (
      el.scrollTop < LOAD_OLDER_THRESHOLD_PX &&
      query.hasNextPage &&
      !query.isFetchingNextPage
    ) {
      prependAnchor.current = {
        prevHeight: el.scrollHeight,
        prevOldestId: oldestId,
      };
      void query.fetchNextPage();
    }
  }, [query, oldestId, syncLatestVisibility]);

  return { scrollRef, anchorSpacerRef, showLatest, jumpToLatest, onScroll };
}
