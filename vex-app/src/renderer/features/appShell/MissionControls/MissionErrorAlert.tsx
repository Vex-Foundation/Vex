/**
 * `MissionErrorAlert` — the standing paused_error alert.
 *
 * Extracted from `MissionControls.tsx` when it gained real classification
 * logic: turning durable failure evidence into user-facing copy is its own
 * responsibility with its own reason to change (categories, wording, the
 * bounded code trailer), and it pushed the parent past the file-size limit.
 * Behaviour is unchanged by the move.
 */

import type { JSX } from "react";
import {
  classifyEngineFailure,
  classifyEngineRemedy,
} from "@shared/engine-error-classification.js";
import {
  engineErrorCopy,
  engineErrorRemedyHint,
} from "@shared/engine-error-copy.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";

/**
 * Standing paused_error alert (issue #42): while the recover-eligible pause
 * persists, the mission is silently NOT monitoring the market or positions —
 * that has to be visible, not inferred from an agent reply. Persistent,
 * state-driven UI: no timers, no dismissal. If a recovery settles and the
 * refetched runtime is still paused_error, this simply stays/reappears — the
 * visible-failure signal the operator needs.
 */
export function MissionErrorAlert({
  stopReason,
  lastError,
}: {
  readonly stopReason: string | null;
  readonly lastError: RuntimeStateDto["lastError"];
}): JSX.Element {
  // `provider_error` names the stop reason, not the cause — it covers both
  // inference and runtime errors, so the generic copy must not claim a
  // connection failure. The state is recoverable via the Recover button, so
  // never say "unrecoverable".
  //
  // `lastError` is the DURABLE evidence persisted with the paused run, so this
  // survives an app restart, when the live `EV.engine.error` event is long
  // gone. It is classified through the SAME classifier as the push event and
  // the chat IPC mapper — one vocabulary, one mapping table — and degrades to
  // the generic wording when the run paused before the evidence was written or
  // for a reason with nothing classifiable to say.
  const signals =
    lastError === undefined
      ? null
      : {
          errorType: lastError.errorType ?? null,
          errorClass: lastError.errorClass ?? null,
          statusCode: lastError.statusCode ?? null,
          causeCode: lastError.causeCode ?? null,
        };
  const classified = signals === null ? null : classifyEngineFailure(signals);
  const copy = classified === null ? null : engineErrorCopy(classified);
  // Same remedy vocabulary as the live push event - the durable evidence
  // carries the same bounded signals, so the paused card can also name the
  // one action that clears the failure.
  const remedyHint =
    signals === null ? null : engineErrorRemedyHint(classifyEngineRemedy(signals));

  const body =
    copy !== null
      ? copy.body
      : stopReason === "provider_error"
        ? "The mission paused after an inference or runtime error."
        : "The mission paused after an unexpected error.";

  // Bounded codes for a bug report — never prose. `errorMessage` and
  // `stop_summary` stay server-side by construction; the DTO has no field for
  // them.
  const codes =
    lastError === undefined
      ? null
      : [
          lastError.errorType,
          lastError.errorClass,
          lastError.statusCode === undefined ? undefined : `HTTP ${lastError.statusCode}`,
          lastError.causeCode,
        ]
          .filter((part): part is string => part !== undefined)
          .join(" · ");

  return (
    <div
      role="alert"
      data-vex-area="mission-error-alert"
      data-vex-category={classified ?? undefined}
      className="mb-2 w-full rounded-xl border border-[var(--vex-rule)] bg-danger-wash px-3 py-2"
    >
      <p className="vex-micro font-medium text-danger">
        {copy !== null ? `Mission paused - ${copy.title}` : "Mission paused - error"}
      </p>
      <p className="mt-1 text-xs text-[var(--vex-text-1)]">{body}</p>
      {remedyHint !== null ? (
        <p className="mt-1 text-xs font-medium text-[var(--vex-text-1)]">{remedyHint}</p>
      ) : null}
      <p className="mt-1 text-xs text-[var(--vex-text-2)]">
        The mission is not monitoring the market or your positions until you
        recover it.
      </p>
      {codes !== null && codes.length > 0 ? (
        <p className="mt-1 font-mono text-[10px] text-[var(--vex-text-3)]">{codes}</p>
      ) : null}
    </div>
  );
}

