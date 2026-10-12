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
 *   - in flight  → disabled, the pixel loader;
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
import { PxIcon } from "../../../components/icons/index.js";
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
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={inFlight}
        aria-label="Refresh portfolio"
        title="Refresh portfolio"
        className="vex-bk__key disabled:cursor-not-allowed disabled:opacity-50"
        style={{ minWidth: 20, height: 20 }}
      >
        <PxIcon name={inFlight ? "loading" : "refresh"} />
      </button>
      {feedback.kind !== "idle" ? (
        <span
          role={feedback.kind === "throttled" ? undefined : "status"}
          className="vex-bs__fb"
        >
          {feedback.kind === "throttled"
            ? `just refreshed - retry in ${feedback.retryAfterSeconds}s`
            : feedback.kind === "partial"
              ? "some chains could not refresh - showing last known balances"
              : "could not refresh - showing last known"}
        </span>
      ) : null}
    </span>
  );
}
