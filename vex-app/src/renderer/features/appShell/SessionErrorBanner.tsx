/**
 * Session-agnostic engine-error card, above the composer.
 *
 * Mounted by `SessionPanel` for EVERY session, mission or agent. The mission
 * paused_error alert lives inside `MissionControls`, which only renders when
 * `mode === "mission"` - so an agent-mode session that failed in the
 * background rendered nothing at all. Agent sessions are the point of this
 * card.
 *
 * ## What it is, after B2.2
 *
 * The CONTEXTUAL surface, and only that. The app-wide "a failure happened"
 * signal is now a notification (raised by `engineErrorStore` on the same
 * event), which announces once, retains, and is re-readable in the
 * notification center. This card is where the failure is READ in place: the
 * bounded codes turned into fixed copy (`shared/engine-error-copy.ts`), the
 * SANITIZED real cause as `detail`, the remedy action hint (owner decree
 * 2026-08-02) and the small monospace code trailer a user quotes in a bug
 * report. All of that is more than one notification message can carry, which
 * is why the card stayed rather than being folded away.
 *
 * `role="alert"` is deliberately GONE with the migration. The notification
 * announcer speaks each failure once, from the model event; leaving a live
 * role on this card as well would speak the same failure twice for anyone
 * with a screen reader open, and a card that renders whenever its session is
 * on screen would also re-announce on every remount.
 *
 * Dismissible, unlike the standing `MissionErrorAlert`: this is a "what just
 * happened" signal for a discrete failure, not a standing state. Dismissing
 * here also closes the notification, and dismissing the notification clears
 * this - `engineErrorStore` owns that binding. The durable "your mission is
 * paused and not monitoring anything" warning stays where it is, driven by
 * runtime state rather than by an event.
 */

import type { JSX } from "react";
import { engineErrorCopy } from "@shared/engine-error-copy.js";
import {
  engineErrorActionHint,
  engineErrorCodeTrailer,
  sessionScopeLabel,
} from "../../stores/engine-error-notice.js";
import { useEngineErrorStore } from "../../stores/engineErrorStore.js";

export function SessionErrorBanner({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element | null {
  const event = useEngineErrorStore((s) => s.bySessionId[sessionId]);
  const clear = useEngineErrorStore((s) => s.clear);

  if (event === undefined) return null;

  const copy = engineErrorCopy(event.category);
  const actionHint = engineErrorActionHint(event);
  const codes = engineErrorCodeTrailer(event);

  return (
    <div
      data-vex-area="session-error-banner"
      data-vex-category={event.category}
      className="mb-2 w-full rounded-xl border border-[var(--vex-rule)] bg-danger-wash px-3 py-2"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="vex-micro font-medium text-danger">
          {sessionScopeLabel(event.scope)} - {copy.title}
        </p>
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={() => {
            clear(sessionId);
          }}
          className="vex-micro text-[var(--vex-text-3)] transition-colors hover:text-danger"
        >
          Dismiss
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--vex-text-1)]">{copy.body}</p>
      {/* Sanitized REAL cause (decree 2026-08-02) - technical register, mono. */}
      {event.detail !== null ? (
        <p className="mt-1 break-words font-mono text-[11px] leading-4 text-[var(--vex-text-2)]">
          {event.detail}
        </p>
      ) : null}
      {actionHint !== null ? (
        <p className="mt-1 text-xs font-medium text-[var(--vex-text-1)]">{actionHint}</p>
      ) : null}
      {codes !== null ? (
        <p className="mt-1 font-mono text-[10px] text-[var(--vex-text-3)]">{codes}</p>
      ) : null}
    </div>
  );
}
