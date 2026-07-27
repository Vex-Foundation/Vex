/**
 * SetupStatusCard — the status stanza for pre-shell branch bodies
 * (docker / compose / migrations), replacing the NOTARY StatusTile.
 *
 * Grammar: status is a colored mono WORD (never a dot, never a stamp)
 * above quiet sans copy. Calm tones (`ok` / `info` / `muted`) render
 * unboxed — content sits directly on the surface. Alert tones (`warn` /
 * `error`) speak the AMENDMENT A3 rail recipe: a left 2px color rail,
 * no fill, no rounded container (the boxed 45/12 recipe is retired
 * with the rest of the boxed composition).
 */

import { type JSX, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";

export type SetupStatusTone = "ok" | "info" | "warn" | "error" | "muted";

interface SetupStatusCardProps {
  readonly tone: SetupStatusTone;
  /** Colored mono status word; falls back to a per-tone default. */
  readonly word?: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly children?: ReactNode;
}

const defaultWord: Record<SetupStatusTone, string> = {
  ok: "Ready",
  info: "Note",
  warn: "Attention",
  error: "Failed",
  muted: "Waiting",
};

const wordInk: Record<SetupStatusTone, string> = {
  ok: "text-[var(--color-success)]",
  info: "text-[var(--color-text-secondary)]",
  warn: "text-[var(--color-warning)]",
  error: "text-[var(--color-danger)]",
  muted: "text-[var(--color-text-muted)]",
};

const alertRail: Partial<Record<SetupStatusTone, string>> = {
  warn: "border-l-2 border-[color-mix(in_oklab,var(--color-warning)_45%,transparent)] pl-3",
  error:
    "border-l-2 border-[color-mix(in_oklab,var(--color-danger)_45%,transparent)] pl-3",
};

export function SetupStatusCard({
  tone,
  word,
  title,
  detail,
  children,
}: SetupStatusCardProps): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-1", alertRail[tone])}>
      <span
        className={cn(
          "vex-micro font-semibold",
          wordInk[tone],
        )}
      >
        {word ?? defaultWord[tone]}
      </span>
      <span className="text-sm font-medium text-[var(--color-text-primary)]">
        {title}
      </span>
      {detail ? (
        <span className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          {detail}
        </span>
      ) : null}
      {children}
    </div>
  );
}
