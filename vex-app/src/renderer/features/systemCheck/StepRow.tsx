/**
 * Single probe row on the System Check page (`docs/design/R3-MINIMAL.md section 10.3`).
 *
 * Layout: the label (15 / 500) with the detail under it in the figure face (12.5, muted), and the
 * state word at the right (13.5): a fill and a word. While a probe is loading the word is
 * "Checking" on the dot screen and the row reads blue; once resolved it prints a swatch (solid =
 * ok, target = warn, ink cross = fail) beside the word. The fill is never a hue.
 *
 * The `data-step-status` attribute remains the stable selector across
 * refactors (e2e + unit tests rely on it). `badgeLabel` decouples the
 * visible word from the semantic `StepStatus` so screens can surface
 * contextual wording (Ready / Setup) without losing the underlying
 * state machine value. Word texts are pinned by tests:
 * Checking / OK / Warning / Failed.
 */

import { type JSX } from "react";

import { StateWord } from "../../components/ui/state-word.js";
import { type SwatchState } from "../../components/ui/swatch.js";

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

/** Status by fill: the dot screen while it is in flight, solid, the target, the ink cross. */
const statusSwatch: Record<StepStatus, SwatchState> = {
  loading: "ongoing",
  ok: "done",
  warn: "warning",
  fail: "error",
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
      <StateWord state={statusSwatch[status]} word={badgeLabel ?? defaultBadgeLabel[status]} />
    </li>
  );
}
