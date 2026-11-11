/**
 * Single probe row on the System Check page, in the console's row grammar
 * (docs/design/H3-DESKTOP.md section 4.9; the plate `stage-system-check`).
 *
 * Layout: the label (15) with the detail under it in the figure face (13,
 * muted), and the state at the right as H3's status (section 2.2): a square
 * and an ink word in caps. While a probe is loading the word is "Checking"
 * beside the grey square; once resolved it is green for ok, ink for a warning
 * the person can act on (Setup, Low), red for a failure.
 *
 * The `data-step-status` attribute remains the stable selector across
 * refactors (e2e + unit tests rely on it). `badgeLabel` decouples the
 * visible word from the semantic `StepStatus` so screens can surface
 * contextual wording (Ready / Setup) without losing the underlying
 * state machine value. Word texts are pinned by tests:
 * Checking / OK / Warning / Failed.
 */

import { type JSX } from "react";

import { StageStatus, type StageSquareKind } from "../../components/onboarding/StageFrame.js";

export type StepStatus = "loading" | "ok" | "warn" | "fail";

interface StepRowProps {
  readonly label: string;
  readonly status: StepStatus;
  readonly detail: string | null;
  readonly badgeLabel?: string;
}

const defaultBadgeLabel: Record<StepStatus, string> = {
  loading: "Checking",
  ok: "OK",
  warn: "Warning",
  fail: "Failed",
};

/** H3's squares: grey while in flight, green ok, ink a warning, red a failure. */
const statusSquare: Record<StepStatus, StageSquareKind> = {
  loading: "running",
  ok: "done",
  warn: "ink",
  fail: "failed",
};

export function StepRow({
  label,
  status,
  detail,
  badgeLabel,
}: StepRowProps): JSX.Element {
  return (
    <li
      className="vex-fr-probe"
      data-step-status={status}
      data-live={status === "loading" ? "" : undefined}
    >
      <span className="vex-fr-probe__l">{label}</span>
      {detail ? <span className="vex-fr-probe__d vex-num">{detail}</span> : null}
      <StageStatus kind={statusSquare[status]} word={badgeLabel ?? defaultBadgeLabel[status]} />
    </li>
  );
}
