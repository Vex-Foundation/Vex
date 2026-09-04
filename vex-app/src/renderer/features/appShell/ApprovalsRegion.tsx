/**
 * Inline approval region (F3 — restricted-mode unblock).
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
 *  1. `Result.ok === false` is surfaced as an inline error — TanStack `isError`
 *     would not catch app-level `Result` failures.
 *  2. Bounded height + `overflow-y-auto` so multiple pending approvals cannot
 *     push the composer off-screen.
 *  3. Only the FIRST newly-appearing card gets `focusOnMount`. Subsequent
 *     refetches that include the same id no longer re-focus.
 *  5. (Mount test) — `__tests__/SessionPanel-approval.test.tsx` asserts that
 *     the selected-session path renders a pending approval card via this
 *     region (directly protects the bug fix).
 */

import { useEffect, useMemo, useRef } from "react";
import type { JSX } from "react";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { usePendingApprovals } from "../../lib/api/approvals.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { selectFreshApprovals } from "./approvals/fresh-approvals.js";

/**
 * Fallback poll only. `useMissionUpdateLiveSync` pushes `approval_enqueued`
 * the moment the enqueue transaction commits, so a new card no longer waits
 * on this tick — it covers a dropped event, nothing else. Never delete it:
 * without it a dropped event hides an approval the run is blocked on.
 */
const REFETCH_INTERVAL_MS = 60_000;

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

  const view = useMemo<ViewState>(() => {
    if (!query.data) return null;
    if (query.data.ok === false) {
      return { kind: "error", message: query.data.error.message };
    }
    return { kind: "rows", rows: query.data.data };
  }, [query.data]);

  // Identify the FIRST newly-appearing id (oldest by createdAt) for focus.
  // The selector is shared with the cross-mode toast
  // (`approvals/fresh-approvals.ts`); the RETENTION below is this region's own.
  const focusTargetId = useMemo<string | null>(() => {
    if (view === null || view.kind !== "rows") return null;
    return selectFreshApprovals(view.rows, seenIdsRef.current)[0]?.id ?? null;
  }, [view]);

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

  if (view === null) return null;
  if (view.kind === "error") {
    return (
      <p
        role="alert"
        data-vex-area="approvals-region-error"
        className="mt-2 text-xs text-destructive"
      >
        Could not load pending approvals: {view.message}
      </p>
    );
  }
  if (view.rows.length === 0) return null;

  return (
    <section
      data-vex-area="approvals-region"
      // Bound height (Codex F3 #2) so multiple pendings can't push the composer
      // off-screen; scroll within the region instead. S3: a single hairline
      // separates the region from the transcript — no box of its own.
      className="max-h-[40vh] shrink-0 overflow-y-auto border-t border-[var(--vex-line)]"
    >
      {view.rows.map((summary) => (
        <ApprovalCard
          key={summary.id}
          summary={summary}
          sessionId={sessionId}
          focusOnMount={summary.id === focusTargetId}
        />
      ))}
    </section>
  );
}
