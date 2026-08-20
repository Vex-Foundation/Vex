/**
 * Session transcript surface (stage 8-1 + 8-2b load-older).
 *
 * Pages backward through `useTranscriptInfinite` (newest page first). Renders
 * loading / error / empty / list (`SessionTranscript/TranscriptStates.tsx`).
 * The whole scroll model — user-anchor-at-top, never-follow, "latest" pill,
 * load-older viewport hold — lives in
 * `SessionTranscript/useTranscriptScroll.ts`.
 *
 * Error handling is split: an initial (newest-page) failure shows the
 * transcript error state; an older-page failure keeps the loaded messages and
 * shows a top "couldn't load older" strip. Content rendering is delegated to
 * `TranscriptMessage` (assistant = safe markdown, others = plain text).
 *
 * S3 entry settle: only rows appended LIVE after the session's first completed
 * render get the one-shot `.vex-entry-settle` print animation. Historical rows
 * (initial load + load-older prepends) enter with a hard cut.
 */

import { useMemo, useRef, type JSX } from "react";
import { IconChevronDown } from "../../components/icons/index.js";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import { usePendingApprovals } from "../../lib/api/approvals.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import {
  flattenTranscriptPages,
  useTranscriptInfinite,
} from "../../lib/api/messages.js";
import { useStreamPreview } from "../../stores/streamStore.js";
import { StreamingBubble } from "./StreamingBubble.js";
import { findWorkingAgentEntryKey } from "./agentActivity.js";
import {
  groupTranscriptRows,
  toTranscriptRows,
} from "./transcriptRowModel.js";
import {
  trackSettledIds,
  type SettledIdsTracker,
} from "./SessionTranscript/settledIds.js";
import { useTurnPreview } from "./SessionTranscript/turnPreview.js";
import {
  VexingOverlay,
  isCentredSceneUp,
} from "./SessionTranscript/VexingOverlay.js";
import { TranscriptRows } from "./SessionTranscript/TranscriptRows.js";
import {
  OlderPageErrorStrip,
  OlderPageLoadingStrip,
  TranscriptEmptyState,
  TranscriptErrorState,
  TranscriptLoadingState,
} from "./SessionTranscript/TranscriptStates.js";
import { TurnStatsLine } from "./SessionTranscript/TurnStatsLine.js";
import { useMessageForkActions } from "./SessionTranscript/useMessageForkActions.js";
import { useTranscriptScroll } from "./SessionTranscript/useTranscriptScroll.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";

// Same cadence as ApprovalsRegion — both observers share one query, so this
// adds no IPC load; it only keeps the act-ledger stamps as fresh as the cards.
// Slowed 5s → 60s with the rest: `useMissionUpdateLiveSync` pushes
// `approval_enqueued`, and TanStack invalidation refreshes every observer of
// the shared key, this one included. Fallback only — not deleted.
const PENDING_APPROVALS_REFETCH_MS = 60_000;

export function SessionTranscript({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element {
  const query = useTranscriptInfinite(sessionId);
  const streamPreview = useStreamPreview(sessionId);
  const chatSubmitting = useIsChatSubmitting(sessionId);

  const pages = query.data?.pages;
  const items = useMemo<SessionMessageDto[]>(
    () => (pages === undefined ? [] : flattenTranscriptPages(pages)),
    [pages],
  );
  // One pass that correlates each tool_result row to its call's name, then
  // the S5 act-ledger post-pass: merge outputs into call acts and collapse
  // runs of ≥TOOL_GROUP_MIN_CALLS (6) calls into one group entry.
  const rows = useMemo(
    () => groupTranscriptRows(toTranscriptRows(items)),
    [items],
  );
  const workingAgentEntryKey = findWorkingAgentEntryKey(rows, chatSubmitting);
  // A14/A18 - branch + edit hover keys on prose rows.
  const forkActions = useMessageForkActions({ sessionId, rows });

  // S5 — pending approvals drive two quiet signals: per-act "Awaiting
  // signature" stamps (matched by toolCallId) and the working strip's
  // circuit-break. Shares ApprovalsRegion's query key: no new IPC.
  const pendingQuery = usePendingApprovals(sessionId, {
    refetchInterval: PENDING_APPROVALS_REFETCH_MS,
  });
  const pendingApprovals = useMemo<ReadonlyMap<string, string>>(() => {
    const byToolCallId = new Map<string, string>();
    const result = pendingQuery.data;
    if (result === undefined || !result.ok) return byToolCallId;
    for (const approval of result.data) {
      // Defensive status check — listPending should only return pendings.
      if (approval.status !== "pending" || approval.toolCallId === null) continue;
      if (!byToolCallId.has(approval.toolCallId)) {
        byToolCallId.set(approval.toolCallId, approval.id);
      }
    }
    return byToolCallId;
  }, [pendingQuery.data]);
  const hasPendingApproval =
    pendingQuery.data !== undefined &&
    pendingQuery.data.ok &&
    pendingQuery.data.data.length > 0;

  // Render-time bookkeeping (not an effect): the settle class must be present
  // on a live row's FIRST paint or the animation start is visibly late.
  const settledRef = useRef<SettledIdsTracker | null>(null);
  settledRef.current = trackSettledIds(settledRef.current, sessionId, pages);
  const settledIds = settledRef.current?.ids ?? null;
  const newestId = items.at(-1)?.id ?? 0;
  const oldestId = items.at(0)?.id ?? 0;
  const firstPage = pages?.[0];
  const olderError =
    items.length > 0 &&
    ((pages?.some((page) => !page.ok) ?? false) || query.isError);

  const newestVariant = rows.at(-1)?.variant ?? null;
  const newestIsLiveAppend =
    settledIds !== null && newestId !== 0 && !settledIds.has(newestId);

  // THE TURN, not the round (see `turnPreview.ts`). This is what the whole
  // rest of this component means by "a turn is in flight": it opens on the
  // SEND rather than on the first provider delta, and it survives the
  // mid-turn assistant rows a tool call persists. Both the ghost-moment and
  // the scroll-jump reports were the round-scoped value leaking into
  // turn-scoped decisions (the island's mount, the anchor run-out).
  //
  // It is called HERE, after the row bookkeeping, because its centred-scene
  // latch reads the very rows the scroll model keys on — passed in rather
  // than re-queried, so there is no second source of truth.
  const { preview, centredSceneEligible } = useTurnPreview({
    sessionId,
    preview: streamPreview,
    submitting: chatSubmitting,
    newestId,
    newestVariant,
    newestIsLiveAppend,
  });
  const centredSceneUp = isCentredSceneUp(
    preview,
    centredSceneEligible,
    hasPendingApproval,
  );

  // Preview signature — every VISIBLE preview change, so the pill measurement
  // sees the bubble grow no matter WHICH part of it is growing: streamed text,
  // the tool name, the phase, the island's own live reasoning (its status and
  // active-segment length, which flushes independently of the answer text and
  // expands the island into a panel), and the SETTLED segment count (each
  // settle adds a collapsed stamp row). Omitting reasoning let the surface
  // grow past the fold without ever raising the pill.
  const previewSig =
    preview === null
      ? null
      : `${preview.streamId}:${preview.phase}:${preview.status}:${preview.toolName ?? ""}:${preview.text.length}:${preview.reasoningSegments.length}:${preview.reasoningText.length}`;

  const { scrollRef, anchorSpacerRef, showLatest, jumpToLatest, onScroll } =
    useTranscriptScroll({
      sessionId,
      query,
      itemCount: items.length,
      newestId,
      oldestId,
      newestVariant,
      newestIsLiveAppend,
      previewSig,
    });

  // macOS-style overlay bar: visible while scrolling, gone ~1s after.
  useScrollbarVisibility(scrollRef);

  if (query.isLoading) {
    return <TranscriptLoadingState />;
  }

  // Empty/error copy only when there is also no live preview — otherwise the
  // first streamed reply in a brand-new session would be invisible. A preview
  // falls through to the scroll container below.
  if (items.length === 0 && preview === null) {
    if (query.isError || (firstPage !== undefined && !firstPage.ok)) {
      const message =
        firstPage !== undefined && !firstPage.ok
          ? firstPage.error.message
          : "Unable to load this conversation.";
      return <TranscriptErrorState message={message} />;
    }
    return <TranscriptEmptyState />;
  }

  return (
    // Positioning frame for the "↓ latest" pill ONLY. It sizes exactly like the
    // scroller it wraps (`flex min-h-0 flex-1`), so the transcript's own layout
    // and scroll math are unchanged; the pill floats over it rather than inside
    // it, which keeps the pill out of the scrolled content.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-vex-area="chat-transcript"
        data-state="ready"
        // SCROLLBAR (owner visual round 2026-07-30): the scroller spans the
        // full column width so the bar hugs its OUTER edge,
        // `scrollbar-gutter: stable` reserves the track so content never
        // shifts when it appears, and the row padding moved INSIDE (`px-3` on
        // the content wrapper). `.vex-scroll` is the repo's thin treatment.
        className="vex-scroll vex-scroll-overlay flex min-h-0 flex-1 flex-col overflow-y-auto py-4 [scrollbar-gutter:stable]"
      >
      {/* THE READING COLUMN, re-applied INSIDE the scroller so the native
          scrollbar sits at the panel's right edge. Nesting the column here
          keeps the text measure byte-identical to when the column was the
          scroller; both wrappers size to content, so the outer scroll math is
          unchanged. */}
      {/* 780px card axis − 16px sides = the 748px reading column: the
          transcript stays exactly 32px narrower than the composer card
          (the shared width rule). The 16px column gap is the ONE vertical
          rhythm — no per-element margins. */}
      <div className="mx-auto w-full max-w-[780px] px-4">
      <div className="relative flex flex-col gap-4">
        {/* The gutter hosts the live working mark (StreamingBubble, left-0) —
            an indicator, not a wall. */}
        {query.isFetchingNextPage ? <OlderPageLoadingStrip /> : null}
        {olderError ? <OlderPageErrorStrip /> : null}
        <TranscriptRows
          rows={rows}
          sessionId={sessionId}
          settledIds={settledIds}
          pendingApprovals={pendingApprovals}
          workingAgentEntryKey={workingAgentEntryKey}
          forkActions={forkActions}
        />
        {/* A17 — the settled turn's tail wears its usage stats. Mounted only
            between turns; a user-tail (message sent, reply not begun) or a
            live preview means the turn is not settled yet. */}
        {preview === null && rows.length > 0 && newestVariant !== "user" ? (
          <TurnStatsLine sessionId={sessionId} />
        ) : null}
        {preview !== null ? (
          <StreamingBubble
            preview={preview}
            awaitingApproval={hasPendingApproval}
            centredSceneUp={centredSceneUp}
          />
        ) : null}
        {/* Anchor spacer — inert run-out below the newest turn. Sized (via the
            top-anchor effect, direct style so it lands in the same frame as
            the scroll) so a just-sent user message can anchor at the viewport
            TOP with the reply streaming into the space beneath it. Zeroed on
            session switch: history browsing gets no dead scroll region. */}
        <div ref={anchorSpacerRef} aria-hidden className="shrink-0" />
        </div>
        </div>
      </div>

      {/* The centred scene — a SIBLING of the scroller, never a descendant.
          See `SessionTranscript/VexingOverlay.tsx` for why. */}
      <VexingOverlay
        preview={preview}
        centredSceneEligible={centredSceneEligible}
        awaitingApproval={hasPendingApproval}
      />

      {/* "↓ LATEST" — the jump the transcript no longer takes on the reader's
          behalf. Solid ink (no glass), bottom-centred over the chat column,
          and mounted ONLY while newer content sits below the fold, so it never
          covers text the reader is already looking at. The jump is instant, so
          it needs no reduced-motion branch. */}
      {/* A4 geometry: a 34px floating circle over the column's bottom edge,
          l2 hairline + solid layer fill + lv2 shadow. Mounted ONLY while
          newer content sits below the fold. */}
      {showLatest ? (
        <button
          type="button"
          data-vex-latest-pill
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
          className="absolute bottom-4 left-1/2 z-10 inline-flex h-[34px] w-[34px] -translate-x-1/2 items-center justify-center rounded-full border border-line-2 bg-surface-2 text-ink-primary shadow-md transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          <IconChevronDown size={14} />
        </button>
      ) : null}
    </div>
  );
}
