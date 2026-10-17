/**
 * SetupStatusCard — the status stanza for pre-shell branch bodies (the local
 * runtime's start, the container bootstrap screens, the migrations).
 *
 * Grammar (docs/design/V10-SPREAD.md section 1): status is shown by fill, a
 * swatch beside a mono WORD, above quiet sans copy. Calm tones (`ok` /
 * `info` / `muted`) sit on the page unboxed. Alert tones (`warn` / `error`)
 * are the risk callout: a 1.5px ink frame with a hatched edge, ink type,
 * never a status hue.
 *
 * ## It is a LIVE REGION, and it has to be its own
 *
 * These cards are the only thing that reports a pre-shell branch: the local
 * database failing to start, a disk too full for the embeddings model, a
 * migration finishing. All of it
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
import { Swatch, type SwatchState } from "../ui/swatch.js";

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

/** Status by fill. */
const toneSwatch: Record<SetupStatusTone, SwatchState> = {
  ok: "done",
  info: "idle",
  warn: "warning",
  error: "error",
  muted: "idle",
};

const alertRail: Partial<Record<SetupStatusTone, string>> = {
  warn: "vex-callout",
  error: "vex-callout",
};

export function SetupStatusCard({
  tone,
  word,
  title,
  detail,
  children,
}: SetupStatusCardProps): JSX.Element {
  // The frame follows the tone, so no call site has to decide: a calm
  // stanza is page prose, an alert is the callout. Both read from the
  // page's left edge, under the page title.
  const isAlert = alertRail[tone] !== undefined;
  return (
    <div
      role={isAlert ? "alert" : "status"}
      className={cn("flex flex-col gap-1", isAlert && alertRail[tone])}
    >
      <span
        className={cn("flex items-center gap-2 vex-micro", wordInk[tone])}
      >
        <Swatch state={toneSwatch[tone]} size={9} />
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
