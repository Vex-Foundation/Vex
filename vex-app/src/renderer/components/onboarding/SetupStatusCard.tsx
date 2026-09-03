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
 *
 * ## It is a LIVE REGION, and it has to be its own
 *
 * These cards are the only thing that reports a pre-shell branch: Docker not
 * running, a compose bootstrap failing, a migration finishing. All of it
 * arrives while the user is watching a screen that changes under them without
 * any focus moving, so a sighted user sees the word change and nobody else is
 * told anything. The app-wide notification announcer is NOT the owner here -
 * it lives inside the shell, which does not exist yet on these screens.
 *
 * The role follows the tone, and the split is the component's own `isAlert`:
 * an alert tone (`warn` / `error`) is a failure the user has to act on and
 * interrupts (`alert`), while a calm tone is progress and waits its turn
 * (`status`). One rule, so no call site has to decide, and the visual rail and
 * the announcement can never disagree about which one this is.
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
  info: "text-ink-secondary",
  warn: "text-[var(--color-warning)]",
  error: "text-[var(--color-danger)]",
  muted: "text-ink-tertiary",
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
  // Alignment follows the tone, so no call site has to decide (owner review
  // 2026-07-27 — prose centers, alerts do not). A calm stanza is hero prose
  // and centers with the screen's header. An alert IS its left rail: the
  // 2px border is the alignment, and centering text against it would leave
  // the rail marking nothing.
  const isAlert = alertRail[tone] !== undefined;
  return (
    <div
      role={isAlert ? "alert" : "status"}
      className={cn(
        "flex flex-col gap-1",
        isAlert ? alertRail[tone] : "items-center text-center",
      )}
    >
      <span
        className={cn(
          "vex-micro font-semibold",
          wordInk[tone],
        )}
      >
        {word ?? defaultWord[tone]}
      </span>
      <span className="text-lg font-medium text-ink-primary">
        {title}
      </span>
      {detail ? (
        <span className="text-xs leading-relaxed text-ink-secondary">
          {detail}
        </span>
      ) : null}
      {children}
    </div>
  );
}
