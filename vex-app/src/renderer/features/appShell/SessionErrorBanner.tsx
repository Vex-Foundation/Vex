/**
 * Session-agnostic engine-error card: the turn error row of
 * docs/design/H3-DESKTOP.md section 1.7 (`TurnErrorRow`, VEX Cloud's one row
 * for every kind): the red square and the category's title in the refusal
 * ink, then the words in ink 2 (whose failure it is, what the category means,
 * the sanitized real cause, the remedy, and the code trailer in the mono 11.5
 * muted), then the key strip, which holds Dismiss. It replaces R3's ink
 * callout.
 *
 * ONE ROW PER KIND. The kind is the classified category
 * (`shared/engine-error-copy.ts`): its title heads the row, its sentence
 * follows. The scope ("This turn failed", "The mission run failed") opens the
 * words, so the outcome leads and whose it is follows.
 *
 * Mounted by `SessionPanel` for EVERY session, mission or agent. The mission
 * paused_error alert lives inside `MissionControls`, which only renders when
 * `mode === "mission"` - so an agent-mode session that failed in the
 * background rendered nothing at all. Agent sessions are the point of this
 * card.
 *
 * ## What it is, after B2.2
 *
 * The CONTEXTUAL surface. The app-wide "a failure happened" signal is a
 * notification (raised by `engineErrorStore` on the same event), which
 * announces once, retains, and is re-readable in the notification center.
 * This row is where the failure is READ in place: the bounded codes turned
 * into fixed copy, the SANITIZED real cause as `detail`, the remedy action
 * hint (owner decree 2026-08-02) and the small monospace code trailer a user
 * quotes in a bug report.
 *
 * VEX Cloud draws the row as `role="alert"`. Desktop keeps B2.2's choice and
 * leaves the role off: the notification announcer already speaks each failure
 * once, and with both a screen reader would hear it twice (H3-DESKTOP.md
 * section 1.7).
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
import { TurnErrorRow } from "./TurnErrorRow.js";

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
    <TurnErrorRow
      area="session-error-banner"
      kind={event.category}
      title={copy.title}
      words={
        <>
          <span className="block">
            {sessionScopeLabel(event.scope)}. {copy.body}
          </span>
          {actionHint !== null ? (
            <span className="vex-turn-error__hint">{actionHint}</span>
          ) : null}
          {/* Sanitized REAL cause (decree 2026-08-02) - technical register. */}
          {event.detail !== null ? (
            <span className="vex-turn-error__detail">{event.detail}</span>
          ) : null}
          {codes !== null ? <span className="vex-turn-error__code">{codes}</span> : null}
        </>
      }
      keys={[
        {
          label: "Dismiss",
          ariaLabel: "Dismiss error",
          onPress: () => {
            clear(sessionId);
          },
        },
      ]}
    />
  );
}
