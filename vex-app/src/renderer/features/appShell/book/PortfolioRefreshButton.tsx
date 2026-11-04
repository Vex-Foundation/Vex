/**
 * Manual portfolio refresh (Wave P): the Portfolio page's refresh key. H3
 * moves a page's keys out of the title bar into the page's own tabs row, at
 * the right beside "Updated {time}" (docs/design/H3-DESKTOP.md section 4.8),
 * so the key is a square cell of that row, the height of the row, with the
 * line refresh icon (`.vex-pg-key`, book.css). It renders where the page puts
 * it: it no longer portals into the title bar's page-key slot
 * (`pageKeysSlot.tsx`), so the key, its in-flight state and its outcome line
 * all sit together on the page. Its outcome line hangs under the key.
 *
 * The portfolio refreshes itself: on a 300s periodic cycle, on a push the moment
 * a pending transaction terminalizes, and on an enqueued snapshot after each
 * terminalization. This key exists for the case none of those cover (the
 * user did something outside Vex, or simply wants to be sure), so it is
 * deliberately quiet: an icon key, not a call to action.
 *
 * THREE STATES, all honest:
 *   - in flight: disabled and busy;
 *   - throttled: the server's own outcome, rendered with its retry hint. The
 *     call is rate-limited in main at 30s because it spends provider quota,
 *     and pretending it succeeded would teach the user to keep clicking;
 *   - unavailable: the refresh could not complete. The displayed portfolio is
 *     still valid, only not newer, and the copy says exactly that.
 *
 * The key never renders the money it fetched: the query cache does, after
 * the invalidation below, and the row's "Updated" stamp moves with the
 * re-read's own fetch time.
 */

import { useCallback, useState, type JSX } from "react";
import { LineRefresh } from "../../../components/icons/line/index.js";
import { usePortfolioRefresh } from "../../../lib/api/portfolio.js";

type RefreshFeedback =
  | { readonly kind: "idle" }
  | { readonly kind: "throttled"; readonly retryAfterSeconds: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "partial" };

export function PortfolioRefreshButton(): JSX.Element {
  const { refresh } = usePortfolioRefresh();
  const [inFlight, setInFlight] = useState(false);
  const [feedback, setFeedback] = useState<RefreshFeedback>({ kind: "idle" });

  const onClick = useCallback(async () => {
    if (inFlight) return;
    setInFlight(true);
    setFeedback({ kind: "idle" });
    try {
      const outcome = await refresh();
      if (outcome.status === "throttled") {
        setFeedback({
          kind: "throttled",
          retryAfterSeconds: Math.ceil((outcome.retryAfterMs ?? 0) / 1000),
        });
        return;
      }
      if (outcome.status === "partial") setFeedback({ kind: "partial" });
      if (outcome.status === "unavailable") setFeedback({ kind: "unavailable" });
    } finally {
      setInFlight(false);
    }
  }, [inFlight, refresh]);

  return (
    <span className="vex-pf-refresh">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={inFlight}
        aria-busy={inFlight || undefined}
        aria-label="Refresh portfolio"
        title="Refresh portfolio"
        className="vex-pg-key"
        data-vex-page-key="refresh"
      >
        <LineRefresh size={16} />
      </button>
      {feedback.kind !== "idle" ? (
        <span
          role={feedback.kind === "throttled" ? undefined : "status"}
          className="vex-pf-fb"
        >
          {feedback.kind === "throttled"
            ? `Just refreshed. Retry in ${feedback.retryAfterSeconds}s.`
            : feedback.kind === "partial"
              ? "Some chains could not refresh. Showing last known balances."
              : "Could not refresh. Showing last known balances."}
        </span>
      ) : null}
    </span>
  );
}
