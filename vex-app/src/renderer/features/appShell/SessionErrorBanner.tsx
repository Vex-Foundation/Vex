/**
 * Session-agnostic engine-error banner.
 *
 * Mounted by `SessionPanel` for EVERY session, mission or agent. The mission
 * paused_error alert lives inside `MissionControls`, which only renders when
 * `mode === "mission"` — so an agent-mode session that failed in the
 * background rendered nothing at all. Agent sessions are the point of this
 * banner.
 *
 * Everything shown here is a bounded code turned into fixed copy
 * (`shared/engine-error-copy.ts`). No provider text reaches this component,
 * because no layer beneath it carries any. The technical codes are rendered as
 * a small monospace trailer so a user can quote them in a bug report without
 * the banner reading like a stack trace.
 *
 * Dismissible, unlike the standing `MissionErrorAlert`: this is a "what just
 * happened" signal for a discrete failure, not a standing state. The durable
 * "your mission is paused and not monitoring anything" warning stays where it
 * is, driven by runtime state rather than by an event.
 */

import type { JSX } from "react";
import { engineErrorCopy, engineErrorRetryHint } from "@shared/engine-error-copy.js";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import { useEngineErrorStore } from "../../stores/engineErrorStore.js";

/**
 * What failed, in the user's terms. Scope frames the copy; it is not a cause.
 *
 * `memory` is EXCLUDED at the type level, not merely unlisted. Memory
 * maintenance always arrives session-less and this banner ignores null-session
 * events by contract, so a memory scope reaching here would mean the routing
 * broke. Stating that as `Exclude<…>` keeps the map exhaustive over the scopes
 * that CAN arrive — a new session-scoped scope still fails to compile here —
 * without inventing session copy for a failure that owns no session.
 */
type SessionScope = Exclude<EngineErrorEvent["scope"], "memory">;

const SCOPE_LABEL: Readonly<Record<SessionScope, string>> = {
  turn: "This turn failed",
  mission: "The mission run failed",
  wake: "A scheduled wake failed",
  compact: "A background job failed",
  approval: "Resuming after your decision failed",
};

/**
 * Total lookup. The `memory` arm is unreachable through the live channel (the
 * hook drops null-session events before they are stored), so it degrades to
 * neutral framing rather than asserting — a banner is not the place to throw.
 */
function scopeLabel(scope: EngineErrorEvent["scope"]): string {
  return scope === "memory" ? "Background work failed" : SCOPE_LABEL[scope];
}

/**
 * Bounded technical codes, for a bug report. Only fields the event actually
 * carried are shown, so the trailer is empty rather than full of "null" when
 * the provider told us nothing.
 */
function codeTrailer(event: EngineErrorEvent): string | null {
  const parts = [
    event.errorType,
    event.errorClass,
    event.statusCode === null ? null : `HTTP ${event.statusCode}`,
    event.causeCode,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function SessionErrorBanner({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element | null {
  const event = useEngineErrorStore((s) => s.bySessionId[sessionId]);
  const clear = useEngineErrorStore((s) => s.clear);

  if (event === undefined) return null;

  const copy = engineErrorCopy(event.category);
  const retryHint = engineErrorRetryHint(event.category, event.retryAfterSeconds);
  const codes = codeTrailer(event);

  return (
    <div
      role="alert"
      data-vex-area="session-error-banner"
      data-vex-category={event.category}
      className="mb-2 w-full rounded-lg border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 px-3 py-2"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.26em] text-destructive">
          {scopeLabel(event.scope)} — {copy.title}
        </p>
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={() => {
            clear(sessionId);
          }}
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive/70 hover:text-destructive"
        >
          Dismiss
        </button>
      </div>
      <p className="mt-1 text-xs text-destructive">{copy.body}</p>
      {retryHint !== null ? (
        <p className="mt-1 text-xs text-destructive">{retryHint}</p>
      ) : null}
      {codes !== null ? (
        <p className="mt-1 font-mono text-[10px] text-destructive/70">{codes}</p>
      ) : null}
    </div>
  );
}
