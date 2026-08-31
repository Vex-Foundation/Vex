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

interface CauseCopy {
  /** Rendered as `Mission paused - <title>`, so it completes that sentence. */
  readonly title: string;
  readonly body: string;
}

/**
 * Copy for the stop reasons that NAME their own cause (M3, M4).
 *
 * These two pauses carry no provider or runtime evidence - nothing failed at
 * the provider - so `classifyEngineFailure` has nothing to classify and both
 * would otherwise land on "an unexpected error". That is the one thing rule 08
 * forbids for a state the system understands exactly.
 *
 * Keyed by stop reason, which is a CLOSED engine union: an unknown key simply
 * falls through to the classifier, so a future cause degrades to today's
 * behaviour rather than to a crash.
 *
 * Both bodies keep the honest uncertainty rule 90 requires. Neither pause can
 * promise that the work already dispatched did nothing, so both send the
 * operator to the transcript BEFORE recovering instead of implying the run is
 * safe to resume blind.
 */
const CAUSE_COPY: Readonly<Record<string, CauseCopy>> = {
  restart_orphan: {
    title: "interrupted by a restart",
    body:
      "Vex restarted while this run was executing, so the run was parked instead of left"
      + " running with nothing driving it. Steps that were already in flight may or may not"
      + " have completed - review the transcript before recovering.",
  },
  tool_call_loop: {
    title: "repeated the same tool call",
    body:
      "The mission called the same tool with the same result over and over without making"
      + " progress, so it was stopped rather than left looping. Review the transcript before"
      + " recovering; earlier steps may have completed.",
  },
};

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

  // CAUSE-SPECIFIC COPY WINS over the classifier and over the generic arms.
  // `restart_orphan` and `tool_call_loop` are NAMED causes with a known story:
  // the classifier reads provider/runtime evidence, which these two pauses do
  // not have (nothing failed at the provider), so without this arm both landed
  // on "an unexpected error" - the one thing rule 08 forbids for a state the
  // system understands perfectly well.
  const causeCopy = CAUSE_COPY[stopReason ?? ""] ?? null;
  const body =
    causeCopy !== null
      ? causeCopy.body
      : copy !== null
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
        {causeCopy !== null
          ? `Mission paused - ${causeCopy.title}`
          : copy !== null
            ? `Mission paused - ${copy.title}`
            : "Mission paused - error"}
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

