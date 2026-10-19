/**
 * SetupStatusCard: the status stanza for the first run's branch bodies (the
 * local runtime's start, the database; `docs/design/R3-MINIMAL.md` sections
 * 1.6, 10.3 and 12).
 *
 * Grammar: a state is a fill and a word. A calm tone (`ok`, `info`, `warn`, `muted`) is a card on
 * the paper: a 1px rule frame, the title at the left and the state word at the right (swatch and
 * word), the detail under them. A failure (`error`) is the ink callout: a 1.5px ink frame with a
 * hatch band, the ink cross beside the title and the detail under it, never a hue.
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
 * `warn` and `error` are a state the user has to act on and interrupt
 * (`alert`), while a calm tone is progress and waits its turn (`status`).
 * One rule, so no call site has to decide, and the visual frame and the
 * announcement can never disagree about which one this is.
 */

import { type JSX, type ReactNode } from "react";

import { type SwatchState } from "../ui/swatch.js";
import { ErrorCallout } from "../ui/error-callout.js";
import { StateWord } from "../ui/state-word.js";

export type SetupStatusTone = "ok" | "info" | "warn" | "error" | "muted";

interface SetupStatusCardProps {
  readonly tone: SetupStatusTone;
  /** The state word; falls back to a per-tone default. */
  readonly word?: string;
  /** The fill beside the word; falls back to a per-tone default. */
  readonly state?: SwatchState;
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

/** State by fill. */
const toneSwatch: Record<SetupStatusTone, SwatchState> = {
  ok: "done",
  info: "idle",
  warn: "warning",
  error: "error",
  muted: "idle",
};

export function SetupStatusCard({
  tone,
  word,
  state,
  title,
  detail,
  children,
}: SetupStatusCardProps): JSX.Element {
  const isAlert = tone === "warn" || tone === "error";
  const role = isAlert ? "alert" : "status";

  if (tone === "error") {
    // The failure is the ink callout: the title says what failed, the detail is the cause.
    return (
      <ErrorCallout role={role} title={title} hint={detail ?? undefined} actions={children} />
    );
  }

  return (
    <div role={role} className="vex-fr-card" data-tone={tone}>
      <div className="vex-fr-card__head">
        <span className="vex-fr-card__title">{title}</span>
        <StateWord state={state ?? toneSwatch[tone]} word={word ?? defaultWord[tone]} />
      </div>
      {detail ? <p className="vex-fr-card__detail">{detail}</p> : null}
      {children}
    </div>
  );
}
