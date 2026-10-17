/**
 * The master password's strength under its field (docs/design/R3-MINIMAL.md
 * section 10.3): four cells (the reached ones blue), then the rule at the
 * left and the verdict at the right as a fill and a word.
 *
 * Purely presentational: the zxcvbn estimate runs in
 * `useMasterPasswordStrength.ts`, and `blocked` mirrors the caller's own
 * submit gate (length >= PASSWORD_CREATE_MIN AND score >= the minimum); this
 * component never recomputes that policy. Words follow zxcvbn's 0 to 4 score:
 * 0 and 1 weak, 2 fair, 3 good, 4 strong.
 *
 * Status by fill: nothing typed is the outline, a check in flight the dot
 * screen, a password the gate still refuses the target, an accepted one
 * solid.
 */

import type { JSX } from "react";

import { StateWord } from "../../../../components/ui/state-word.js";
import type { SwatchState } from "../../../../components/ui/swatch.js";
import type { PasswordStrengthLabel } from "./useMasterPasswordStrength.js";

export interface PasswordStrengthProps {
  /** Current password length; nothing typed reaches no cell. */
  readonly length: number;
  /** True once the estimator has loaded and scored this value. */
  readonly ready: boolean;
  /** zxcvbn score, 0 (worst) to 4 (best). */
  readonly score: number;
  readonly label: PasswordStrengthLabel;
  /** True while the password does not yet satisfy the creation gate. */
  readonly blocked: boolean;
  readonly warning?: string | null;
  readonly suggestions?: ReadonlyArray<string>;
  /** Stable id, so the field can point `aria-describedby` here. */
  readonly id?: string;
}

const LABEL_TEXT: Record<PasswordStrengthLabel, string> = {
  weak: "Weak",
  fair: "Fair",
  good: "Good",
  strong: "Strong",
};

const CELLS = [1, 2, 3, 4] as const;

/** How many of the four cells a score reaches; anything typed reaches one. */
export function strengthCells(length: number, score: number): number {
  if (length === 0) return 0;
  return Math.min(4, Math.max(1, Math.round(score)));
}

export function PasswordStrength({
  length,
  ready,
  score,
  label,
  blocked,
  warning,
  suggestions,
  id,
}: PasswordStrengthProps): JSX.Element {
  const checking = !ready && length > 0;
  const word = checking ? "Checking…" : LABEL_TEXT[label];
  const fill: SwatchState =
    length === 0 ? "idle" : checking ? "listening" : blocked ? "warning" : "done";
  const reached = strengthCells(length, score);
  const feedback =
    blocked && length > 0 ? (warning ?? suggestions?.[0] ?? null) : null;

  return (
    <div id={id} className="flex flex-col gap-1.5" data-vex-password-strength>
      <div aria-hidden="true" className="vex-wz-meter">
        {CELLS.map((cell) => (
          <i key={cell} data-on={cell <= reached ? "" : undefined} />
        ))}
      </div>
      <p className="vex-wz-hint">
        <span>10 characters minimum. Must score at least &quot;Good&quot;.</span>
        <StateWord state={fill} word={word} className="text-ink-primary" />
      </p>
      {feedback ? (
        <p className="vex-wz-hint text-warning" role="status">
          {feedback}
        </p>
      ) : null}
    </div>
  );
}
