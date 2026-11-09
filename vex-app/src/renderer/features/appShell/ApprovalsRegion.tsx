/**
 * Inline approval region (F3: restricted-mode unblock).
 *
 * Mounted in `SessionPanel` between the transcript and the composer for an
 * active session. `useControlStateLiveSync` (F5) now pushes a pending-approval
 * refresh on `EV.engine.controlState`, and `useMissionUpdateLiveSync` pushes
 * `approval_enqueued` straight from the enqueue transaction, so a newly-paused
 * run surfaces near-instantly. The REFETCH_INTERVAL_MS poll is retained as a
 * SLOW fallback (5s → 60s once the push landed): an event can be dropped at
 * the preload Zod gate or fire before the renderer subscribes.
 *
 * Codex F3 constraints honoured:
 *  1. `Result.ok === false` is surfaced as an inline error: TanStack `isError`
 *     would not catch app-level `Result` failures.
 *  2. Bounded height + `overflow-y-auto` so multiple pending approvals cannot
 *     push the composer off-screen.
 *  3. Only the FIRST newly-appearing card gets `focusOnMount`. Subsequent
 *     refetches that include the same id no longer re-focus.
 *  5. (Mount test): `__tests__/SessionPanel-approval.test.tsx` asserts that
 *     the selected-session path renders a pending approval card via this
 *     region (directly protects the bug fix).
 *
 * CLOSED CARDS (docs/design/H3-DESKTOP.md section 4.3; Cloud's EC-09). A card
 * that stops waiting while this region shows it, because it was decided here
 * or elsewhere or because it expired, leaves a closed card in its place
 * (`ApprovalCard/ClosedApprovalCard.tsx`) that says only what the attempt
 * recorded, with its next key. Display only: the record is the approvals
 * read that already exists, plus the reply this chat's own card received.
 * A closed card lives as long as this region shows this chat, or until
 * Dismiss; it never holds the dock, so the composer comes back at once.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { usePendingApprovals } from "../../lib/api/approvals.js";
import { Swatch } from "../../components/ui/swatch.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { useApprovalDock } from "./ApprovalCard/approval-dock.js";
import { ClosedApprovalCard } from "./ApprovalCard/ClosedApprovalCard.js";
import type { DecidedHere } from "./ApprovalCard/closed-approval.js";
import { selectFreshApprovals } from "./approvals/fresh-approvals.js";
import { decisionFailed, decisionLanded, publishApprovalDecision } from "./approvals/decision-signal.js";

/** The region's stack in createdAt order, the pending list's own (`ORDER BY created_at`). */
function byCreatedAt(a: ApprovalSummaryDto, b: ApprovalSummaryDto): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Fallback poll only. `useMissionUpdateLiveSync` pushes `approval_enqueued`
 * the moment the enqueue transaction commits, so a new card no longer waits
 * on this tick: it covers a dropped event, nothing else. Never delete it:
 * without it a dropped event hides an approval the run is blocked on.
 */
const REFETCH_INTERVAL_MS = 60_000;

/** The session content's own padding under the region (`pb-4`, `SessionPanel`). */
const CONTENT_FOOT_PX = 16;
/** The least room the stack keeps, so a card is never squeezed out of sight. */
const ROOM_FLOOR_PX = 120;

/**
 * THE ROOM THE STACK IS GIVEN (the money rule, docs/design/H3-DESKTOP.md
 * sections 3.6 and 4.3). The region is bounded at 75vh, but in a chat the
 * composer seat under it is a sticky floor of the same scrollport, and while
 * a card waits the seat holds the card's docked decision row (the reason
 * field and the band). 75vh alone does not see that row, so at a short
 * window (1280 x 720) the stack plus the docked row overran the scrollport
 * and the card's top strip slid under the header, where the toast stands.
 * So the region's height is also held to the scrollport's height less the
 * seat (whatever it holds), the content's foot padding and the tail space:
 * with the chat at its floor, the card's top never goes above the
 * scrollport's top, the header's rule. Measured, and measured again whenever
 * the scrollport, the seat or the tail changes size; outside a chat (the
 * Needs you page, a dialog) nothing is found and 75vh stands alone.
 */
function useRoomAboveSeat(regionRef: { readonly current: HTMLElement | null }, active: boolean): number | null {
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const region = regionRef.current;
    const scroll = region?.closest<HTMLElement>("[data-vex-conversation-scroll]") ?? null;
    const seat = scroll?.querySelector<HTMLElement>("[data-vex-composer-seat]") ?? null;
    if (!active || region === null || scroll === null || seat === null) {
      setRoom(null);
      return;
    }
    const tail = scroll.querySelector<HTMLElement>("[data-vex-transcript-tail]");
    const measure = (): void => {
      const next = Math.max(ROOM_FLOOR_PX, scroll.clientHeight - seat.offsetHeight - CONTENT_FOOT_PX - (tail?.offsetHeight ?? 0));
      setRoom((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(seat);
    if (tail !== null) observer.observe(tail);
    return () => observer.disconnect();
  }, [regionRef, active]);
  return room;
}

export interface ApprovalsRegionProps {
  readonly sessionId: string;
}

type ViewState =
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<ApprovalSummaryDto> }
  | { readonly kind: "error"; readonly message: string }
  | null;

export function ApprovalsRegion({
  sessionId,
}: ApprovalsRegionProps): JSX.Element | null {
  const query = usePendingApprovals(sessionId, {
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const seenIdsRef = useRef<Set<string>>(new Set());
  const regionRef = useRef<HTMLElement | null>(null);
  // The chat's decision-row seat, when the panel offers one (the shell's
  // chat; `ApprovalCard/approval-dock.tsx`).
  const dock = useApprovalDock();

  const view = useMemo<ViewState>(() => {
    if (!query.data) return null;
    if (query.data.ok === false) {
      return { kind: "error", message: query.data.error.message };
    }
    // A desk click's card pops in the desk's own dialog; chat shows what was
    // proposed to it.
    return { kind: "rows", rows: query.data.data.filter((row) => row.origin !== "desk") };
  }, [query.data]);

  // Identify the FIRST newly-appearing id (oldest by createdAt) for focus.
  // The selector is shared with the cross-mode toast
  // (`approvals/fresh-approvals.ts`); the RETENTION below is this region's own.
  const focusTargetId = useMemo<string | null>(() => {
    if (view === null || view.kind !== "rows") return null;
    return selectFreshApprovals(view.rows, seenIdsRef.current)[0]?.id ?? null;
  }, [view]);

  // The card whose decision row the chat's bottom row holds: the oldest by
  // createdAt, by the same order the fresh-card focus uses (an empty "seen"
  // set sorts every row), so a fresh batch focuses the card it docks.
  const dockedId = useMemo<string | null>(() => {
    if (dock === null || view === null || view.kind !== "rows") return null;
    return selectFreshApprovals(view.rows, { has: () => false })[0]?.id ?? null;
  }, [dock, view]);

  // THE CLOSED CARDS. Each render compares the waiting list with the one
  // before it (React's "adjust state while rendering" pattern, so a card
  // that leaves is replaced in the same commit, never a frame later): a card
  // that left keeps its last summary here until Dismiss. A new chat starts
  // with none, and a card that comes back to the list is a waiting card again.
  // The list is compared by its ids, never by its identity: a read that
  // answers the same list again changes nothing here.
  const rows = view !== null && view.kind === "rows" ? view.rows : null;
  const rowsKey = rows === null ? null : rows.map((row) => row.id).join("\n");
  const [tracked, setTracked] = useState<{
    readonly sessionId: string;
    readonly key: string | null;
    readonly rows: ReadonlyArray<ApprovalSummaryDto> | null;
  }>({ sessionId, key: null, rows: null });
  const [closed, setClosed] = useState<ReadonlyMap<string, ApprovalSummaryDto>>(() => new Map());
  const [decided, setDecided] = useState<ReadonlyMap<string, DecidedHere>>(() => new Map());
  if (tracked.sessionId !== sessionId) {
    setTracked({ sessionId, key: rowsKey, rows });
    if (closed.size > 0) setClosed(new Map());
    if (decided.size > 0) setDecided(new Map());
  } else if (rows !== null && rowsKey !== tracked.key) {
    setTracked({ sessionId, key: rowsKey, rows });
    const waiting = new Set(rows.map((row) => row.id));
    const left = (tracked.rows ?? []).filter((row) => !waiting.has(row.id));
    const back = [...closed.keys()].filter((id) => waiting.has(id));
    if (left.length > 0 || back.length > 0) {
      const next = new Map(closed);
      for (const row of left) next.set(row.id, row);
      for (const id of back) next.delete(id);
      setClosed(next);
    }
  }
  const dismiss = useCallback((id: string): void => {
    setClosed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const recordDecision = useCallback((id: string, decision: DecidedHere): void => {
    setDecided((prev) => new Map(prev).set(id, decision));
  }, []);

  // Sync the "seen" set AFTER render so subsequent renders treat current ids
  // as known (no re-focus on refetch). REPLACE, not accumulate: an approval
  // that leaves this session's list and comes back is a fresh card and
  // deserves the focus again. The toast's memory accumulates instead - see
  // `fresh-approvals.ts`.
  useEffect(() => {
    if (view === null || view.kind !== "rows") return;
    const next = new Set<string>();
    for (const r of view.rows) next.add(r.id);
    seenIdsRef.current = next;
  }, [view]);

  const shown = view !== null && view.kind === "rows" && (view.rows.length > 0 || closed.size > 0);
  const room = useRoomAboveSeat(regionRef, shown);

  if (view === null) return null;
  if (view.kind === "error") {
    return (
      <p
        role="alert"
        data-vex-area="approvals-region-error"
        className="mt-2 flex items-start gap-2 text-[13px] leading-5 text-ink-primary"
      >
        <Swatch state="error" size={10} className="mt-[4px]" />
        <span>Could not load pending approvals: {view.message}</span>
      </p>
    );
  }
  if (view.rows.length === 0 && closed.size === 0) return null;

  // Waiting and closed cards in one stack, each where it stood.
  const stack = [
    ...view.rows.map((summary) => ({ summary, closed: false })),
    ...[...closed.values()].map((summary) => ({ summary, closed: true })),
  ].sort((a, b) => byCreatedAt(a.summary, b.summary));

  return (
    <section
      ref={regionRef}
      data-vex-area="approvals-region"
      // NO VEIL (docs/design/R3-MINIMAL.md sections 8.1 and 12): nothing dims
      // the session while an approval waits; the card is the one framed thing
      // on screen, Vex points at it and the composer says "Waiting for
      // approval". No box of its own: the card's REAL FUNDS frame is the only
      // edge.
      //
      // Bound height (Codex F3 #2) so multiple pendings can't push the
      // composer off-screen; scroll within the region instead. 75vh keeps that
      // guarantee while fitting one long card (a Lighter withdrawal's
      // live-state disclosure runs to about 18 rows) on screen, and the
      // card's sticky footer keeps Reject and the action button in view while
      // it scrolls. 10px below the stack.
      //
      // And never taller than the room above the seat (`useRoomAboveSeat`):
      // the docked decision row must not push the card's top under the header.
      className="max-h-[75vh] shrink-0 overflow-y-auto pb-2.5"
      style={room === null ? undefined : { maxHeight: `min(75vh, ${String(room)}px)` }}
    >
      {stack.map(({ summary, closed: isClosed }) =>
        isClosed ? (
          <ClosedApprovalCard
            key={summary.id}
            summary={summary}
            sessionId={sessionId}
            decidedHere={decided.get(summary.id) ?? null}
            onDismiss={() => dismiss(summary.id)}
          />
        ) : (
          <ApprovalCard
            key={summary.id}
            summary={summary}
            sessionId={sessionId}
            focusOnMount={summary.id === focusTargetId}
            // THE BOTTOM ROW HOLDS ONE DECISION (docs/design/H3-DESKTOP.md
            // section 1.8): the oldest waiting card, the one the run asked for
            // first and the one a fresh batch focuses, draws its decision row
            // there; every other card keeps its own footer, with the same keys
            // and the same gate.
            decisionDock={summary.id === dockedId ? dock : null}
            // The reply to a decision made here, kept for the closed card
            // that will stand in this one's place. Read only; the decision
            // itself is the card's.
            onResolved={(decision, result) => {
              recordDecision(summary.id, { decision, result });
              // Display only: Kimm's mood clock reads it, the decision never does.
              publishApprovalDecision(decisionLanded({ decision, result, approvalId: summary.id, sessionId }));
            }}
            onDecisionFailed={(decision) =>
              publishApprovalDecision(decisionFailed({ decision, approvalId: summary.id, sessionId }))
            }
          />
        ),
      )}
    </section>
  );
}
