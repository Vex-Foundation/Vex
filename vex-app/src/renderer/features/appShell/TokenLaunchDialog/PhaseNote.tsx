/**
 * The phase note — the one line under the form that says where the launch
 * stands, shared by every platform lane.
 *
 * It renders MAIN's own sentence verbatim in every terminal case. The lane
 * appends nothing: main knows the status, the hash and the redaction rules, and
 * a renderer-authored embellishment on a money outcome is how a surface starts
 * claiming more than it can prove.
 */

import type { JSX } from "react";
import { RE_REVIEW_NOTE } from "../token-launch/launch-display.js";
import type { DialogPhase } from "./phase.js";

export function PhaseNote({
  phase,
  onRePrice,
}: {
  readonly phase: DialogPhase;
  readonly onRePrice: () => void;
}): JSX.Element | null {
  if (phase.kind === "re_review") {
    return (
      <div className="flex flex-col items-start gap-2" role="alert">
        <p className="text-sm text-warning">{phase.message}</p>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          {RE_REVIEW_NOTE}
        </p>
        <button
          type="button"
          onClick={onRePrice}
          className="rounded-full border border-line-3 px-3 py-1 vex-doto-label vex-doto-label--wide uppercase text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          Review new price
        </button>
      </div>
    );
  }
  if (phase.kind === "refused") {
    return (
      <p className="text-sm text-danger" role="alert">
        {phase.message}
      </p>
    );
  }
  if (phase.kind === "done") {
    // Every completed submit used to render green. A REVERTED launch burned gas
    // and created nothing — painting it as a success is the lie this splits.
    if (phase.tone === "failure") {
      return (
        <p className="text-sm break-all text-danger" role="alert">
          {phase.message}
        </p>
      );
    }
    const className =
      phase.tone === "caution"
        ? "text-sm break-all text-warning"
        : "text-sm break-all text-success";
    return (
      <p className={className} role="status">
        {phase.message}
      </p>
    );
  }
  return null;
}
