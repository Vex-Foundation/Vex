/**
 * ENTRY-SETTLE BOOKKEEPING for the transcript.
 *
 * Which rows are HISTORY and which are LIVE ARRIVALS — the one signal behind
 * two behaviors in `SessionTranscript`: the one-shot `.vex-entry-settle` print
 * animation, and the top-anchor that only a just-SENT user message may take.
 *
 * Extracted from `SessionTranscript.tsx` (move-only) when the turn-scoping
 * work pushed that file toward the 550-line limit. Behavior is unchanged.
 */

import type { Result } from "@shared/ipc/result.js";
import type { MessagePage } from "@shared/schemas/messages.js";

/**
 * Ids that must NOT animate: everything visible at the session's first
 * completed render plus every page later added via load-older (an older page
 * is history, not a live arrival). Tracked per session; `pageCount` detects
 * fetchNextPage appends (a live refetch replaces pages without growing the
 * array). Mutated during render — safe because the bookkeeping is idempotent,
 * which also makes StrictMode's double render/mount a no-op.
 */
export interface SettledIdsTracker {
  readonly sessionId: string;
  readonly ids: Set<number>;
  pageCount: number;
}

export function trackSettledIds(
  tracker: SettledIdsTracker | null,
  sessionId: string,
  pages: readonly Result<MessagePage>[] | undefined,
): SettledIdsTracker | null {
  if (pages === undefined) {
    // Nothing fetched yet for this session — keep waiting (a stale tracker
    // from the previous session is dropped so its ids can't leak across).
    return tracker !== null && tracker.sessionId === sessionId ? tracker : null;
  }
  if (tracker === null || tracker.sessionId !== sessionId) {
    const ids = new Set<number>();
    for (const page of pages) {
      if (!page.ok) continue;
      for (const item of page.data.items) ids.add(item.id);
    }
    return { sessionId, ids, pageCount: pages.length };
  }
  if (pages.length > tracker.pageCount) {
    // Pages appended by fetchNextPage are older history → absorb as settled.
    for (const page of pages.slice(tracker.pageCount)) {
      if (!page.ok) continue;
      for (const item of page.data.items) tracker.ids.add(item.id);
    }
    tracker.pageCount = pages.length;
  }
  return tracker;
}
