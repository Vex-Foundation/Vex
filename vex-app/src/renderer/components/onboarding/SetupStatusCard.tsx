/**
 * SetupStatusCard: the status row for the first run's branch bodies (the
 * local runtime's start, the move of a previous release's data, the
 * database), in the stage's row grammar (docs/design/H3-DESKTOP.md sections
 * 2.2 and 4.9; the system check's rows on the plate `stage-system-check`).
 *
 * Grammar: one row cell across the work column, the title at the left and the
 * state at the right as H3's square and an ink word, the detail under them. A
 * failure (`error`) is the same row with the red square; nothing is a hue but
 * the square.
 *
 * ## It is a LIVE REGION, and it has to be its own
 *
 * These rows are the only thing that reports a pre-shell branch: the local
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
import { squareOfSwatch, StageStatus, type StageSquareKind } from "./StageFrame.js";

export type SetupStatusTone = "ok" | "info" | "warn" | "error" | "muted";

interface SetupStatusCardProps {
  readonly tone: SetupStatusTone;
  /** The state word; falls back to a per-tone default. */
  readonly word?: string;
  /** The fill the screen names, as R3 named it; its square is H3's (`squareOfSwatch`). */
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

/** H3's square per tone: green ready, ink for the person to act, red failed, an outline waiting. */
const toneSquare: Record<SetupStatusTone, StageSquareKind> = {
  ok: "done",
  info: "none",
  warn: "ink",
  error: "failed",
  muted: "none",
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
  const square = state === undefined ? toneSquare[tone] : squareOfSwatch(state);

  return (
    <div role={role} className="vex-fr-card" data-tone={tone}>
      <div className="vex-fr-card__head">
        <span className="vex-fr-card__title">{title}</span>
        <StageStatus kind={square} word={word ?? defaultWord[tone]} />
      </div>
      {detail ? <p className="vex-fr-card__detail">{detail}</p> : null}
      {children}
    </div>
  );
}
