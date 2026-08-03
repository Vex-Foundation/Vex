/**
 * Manual portfolio refresh (Wave P) — the button beside the POSITION card's
 * Total figure.
 *
 * The portfolio refreshes itself: on a 300s periodic cycle, on a push the moment
 * a pending transaction terminalizes, and on an enqueued snapshot after each
 * terminalization. This button exists for the case none of those cover — the
 * user did something outside Vex, or simply wants to be sure — so it is
 * deliberately quiet: an icon in the card's trailing slot, not a call to action.
 *
 * THREE STATES, all honest:
 *   - in flight  → disabled, spinning, "Refreshing…";
 *   - throttled  → the server's own outcome, rendered with its retry hint. The
 *                  call is rate-limited in main at 30s because it spends
 *                  provider quota, and pretending it succeeded would teach the
 *                  user to keep clicking.
 *   - unavailable→ the refresh could not complete. The displayed portfolio is
 *                  still valid, only not newer, and the copy says exactly that.
 *
 * The button never renders the money it fetched — the query cache does, after
 * the invalidation below.
 */

import { useCallback, useState, type JSX } from "react";
import { usePortfolioRefresh } from "../../../lib/api/portfolio.js";

type RefreshFeedback =
  | { readonly kind: "idle" }
  | { readonly kind: "throttled"; readonly retryAfterSeconds: number }
  | { readonly kind: "unavailable" };

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
      if (outcome.status === "unavailable") setFeedback({ kind: "unavailable" });
    } finally {
      setInFlight(false);
    }
  }, [inFlight, refresh]);

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={inFlight}
        aria-label="Refresh portfolio"
        title="Refresh portfolio"
        className="rounded p-1 text-[var(--vex-text-3)] transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshIcon spinning={inFlight} />
      </button>
      {feedback.kind === "throttled" ? (
        <span className="text-[10px] tabular-nums text-[var(--vex-text-3)]">
          just refreshed — retry in {feedback.retryAfterSeconds}s
        </span>
      ) : null}
      {feedback.kind === "unavailable" ? (
        <span className="text-[10px] text-[var(--vex-warn-text)]">
          could not refresh — showing last known
        </span>
      ) : null}
    </div>
  );
}

function RefreshIcon({ spinning }: { readonly spinning: boolean }): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={spinning ? "animate-spin" : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
