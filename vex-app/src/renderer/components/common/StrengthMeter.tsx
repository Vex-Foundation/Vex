/**
 * Real password-strength feedback for the master-password CREATION form
 * (`KeystoreStep`, the only consumer). Purely presentational — the zxcvbn
 * estimation itself runs in `wizard/steps/keystore/useMasterPasswordStrength.ts`
 * so this component stays easy to unit-test with plain props.
 *
 * `blocked` mirrors the caller's actual submit-gate decision (length >=
 * PASSWORD_CREATE_MIN AND zxcvbn score >= MIN_ACCEPTABLE_SCORE) — this
 * component does not recompute or duplicate that policy, it only renders it.
 *
 * Labels map zxcvbn's 0-4 score using its own scoring language ("too
 * guessable" / "very guessable" / "somewhat guessable" / "safely
 * unguessable" / "very unguessable"): 0-1 -> weak, 2 -> fair, 3 -> good,
 * 4 -> strong.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

export type PasswordStrengthLabel = "weak" | "fair" | "good" | "strong";

export interface StrengthMeterProps {
  /** Current password length — used only to decide whether to render anything at all. */
  readonly length: number;
  /** True once the zxcvbn estimator has finished loading and scored this value. */
  readonly ready: boolean;
  /** zxcvbn score, 0 (worst) to 4 (best). */
  readonly score: number;
  readonly label: PasswordStrengthLabel;
  /** True when the password does not yet satisfy the creation gate (length or score). */
  readonly blocked: boolean;
  readonly warning?: string | null;
  readonly suggestions?: ReadonlyArray<string>;
  readonly className?: string;
  /** Stable id so callers can wire `aria-describedby` from the related input. */
  readonly id?: string;
}

const LABEL_TEXT: Record<PasswordStrengthLabel, string> = {
  weak: "Weak",
  fair: "Fair",
  good: "Good",
  strong: "Strong",
};

const LABEL_COLOR: Record<PasswordStrengthLabel, string> = {
  weak: "bg-danger",
  fair: "bg-warning",
  good: "bg-success",
  strong: "bg-success",
};

const SCORE_WIDTH: ReadonlyArray<string> = [
  "w-[10%]",
  "w-[30%]",
  "w-1/2",
  "w-4/5",
  "w-full",
];

export function StrengthMeter({
  length,
  ready,
  score,
  label,
  blocked,
  warning,
  suggestions,
  className,
  id,
}: StrengthMeterProps): JSX.Element {
  const widthClass =
    length === 0 ? "w-0" : (SCORE_WIDTH[score] ?? SCORE_WIDTH[0]);
  // "Checking…" avoids telling the user a maybe-strong password is weak
  // while the estimator is still loading its dictionaries.
  const labelText = !ready && length > 0 ? "Checking…" : LABEL_TEXT[label];
  const feedbackText =
    blocked && length > 0 ? (warning ?? suggestions?.[0] ?? null) : null;

  return (
    <div id={id} className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-ink-tertiary">
          10 characters minimum. Must score at least &quot;Good&quot;.
        </span>
        <span className="vex-micro text-ink-tertiary">
          {labelText}
        </span>
      </div>
      {/* Empty track is the quiet skeleton well token — never an ink slab. */}
      <div
        aria-hidden
        className="h-1 w-full overflow-hidden rounded-full bg-surface-skeleton"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200 ease-out",
            LABEL_COLOR[label],
            widthClass
          )}
        />
      </div>
      {feedbackText ? (
        <p className="text-xs text-warning" role="status">
          {feedbackText}
        </p>
      ) : null}
    </div>
  );
}
