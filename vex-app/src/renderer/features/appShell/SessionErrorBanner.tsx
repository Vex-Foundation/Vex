/**
 * Session-agnostic engine-error card: the turn error callout of
 * docs/design/R3-MINIMAL.md section 6, drawn with the kit's `ErrorCallout`
 * (1.5px ink frame, 8px hatch band, never red): the error fill and the scope
 * title ("This turn failed"), the cause line, the hint, the remedy, the code
 * trailer in the mono 11.5 muted, and Dismiss.
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
import { ErrorCallout } from "../../components/ui/error-callout.js";
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
    <ErrorCallout
      data-vex-area="session-error-banner"
      data-vex-category={event.category}
      className="vex-turn-error"
      title={sessionScopeLabel(event.scope)}
      cause={copy.title}
      hint={
        <>
          <span className="block">{copy.body}</span>
          {/* Sanitized REAL cause (decree 2026-08-02) - technical register. */}
          {event.detail !== null ? (
            <span className="mt-1 block break-words font-code text-[12px] leading-[1.5] text-ink-tertiary">
              {event.detail}
            </span>
          ) : null}
          {actionHint !== null ? (
            <span className="mt-1.5 block font-semibold text-ink-primary">
              {actionHint}
            </span>
          ) : null}
        </>
      }
      code={codes ?? undefined}
      dismissLabel="Dismiss error"
      onDismiss={() => {
        clear(sessionId);
      }}
    />
  );
}
