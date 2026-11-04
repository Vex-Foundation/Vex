/**
 * THE STAGE FRAME: the one frame every screen before the shell stands in
 * (docs/design/H3-DESKTOP.md section 4.9, approved as drawn on 2026-11-04;
 * the harness plates `?plate=stage-*`). It is the shell's own frame, on the
 * shell's seams, so the last screen hands over to the shell without a seam
 * moving:
 *
 *   header  the mark | the Vex key over her column | the screen's title cell
 *   body    where you are | Kimm on her stage | the screen's work
 *   bottom  the version (or a link) | the tagline | the screen's keys
 *
 * The header row is 76 and the bottom row 72 (sections 1.3 and 1.8); the
 * columns are 248, 30% of the window and the rest (section 1.2). Under 1024
 * the left column folds to the 76 rail and Kimm keeps her 30% column: there
 * is no band on these screens.
 *
 * WHAT THIS FRAME DRAWS AND WHAT IT LEAVES. The screen's own cells are here:
 * the mark, the title cell, the left column, the work column and the
 * bottom-left cell. Her column (the Vex key, Kimm and the tagline cell) is
 * NOT: `App` mounts it once (`StagePlate`, `PreShellStage.tsx`) over every
 * screen's empty middle column, so she never moves or restarts while the
 * screens change beside her. A screen's work column runs from the header to
 * the window's foot; the screen draws its own bottom row inside it
 * (`StageActs`), so a form can hold both its fields and its keys.
 *
 * THE LEFT COLUMN says where you are, drawn like the nav: the steps behind you
 * a green square and DONE, the one you are on the selected row's fill, the
 * steps ahead muted with an outline square. The title cell's second line says
 * "Step N of M". This replaces R3's crumb and horizontal stepper.
 *
 * Status here is H3's (section 2.2): a square of about 6px beside an ink word
 * in caps. Green done, red failed, the muted grey while something runs, an ink
 * square where the person is asked to act (a warning: Setup, Low), an outline
 * for nothing yet.
 *
 * Paint is `styles/global-css/stage.css`. Words are written in sentence case
 * and set in caps by the sheet where the label register applies.
 */

import type { JSX, ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { VexMark } from "../common/VexMark.js";
import type { SwatchState } from "../ui/swatch.js";

/**
 * A status square (section 2.2): green done, red failed, grey running, an ink
 * square for the person to act or for where you are, an ink outline for Vex at
 * rest, a muted outline where nothing has happened yet.
 */
export type StageSquareKind = "done" | "failed" | "running" | "ink" | "outline" | "none";

export function StageSquare({ kind }: { readonly kind: StageSquareKind }): JSX.Element {
  return <span aria-hidden="true" className="vex-pre-sq" data-sq={kind} />;
}

/** A square and its word, the word in ink caps. */
export function StageStatus({
  kind,
  word,
  className,
}: {
  readonly kind: StageSquareKind;
  readonly word: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <span className={cn("vex-pre-status", className)} data-sq={kind}>
      <StageSquare kind={kind} />
      {word}
    </span>
  );
}

/**
 * R3's fills as H3's squares, for the rows that still name a fill: solid done
 * is green, the ink cross red, anything in flight grey, a warning, a target or
 * a concern ink (the person is asked to act), the empty outline nothing yet.
 */
export function squareOfSwatch(state: SwatchState): StageSquareKind {
  switch (state) {
    case "done":
      return "done";
    case "error":
      return "failed";
    case "ongoing":
    case "listening":
    case "thinking":
      return "running";
    case "warning":
    case "awaiting":
    case "concerned":
      return "ink";
    case "idle":
    case "draft":
    case "sleeping":
      return "none";
  }
}

/** One row of the left column. */
export interface StageStep {
  /** Stable key, and `data-stage-step` for tests. */
  readonly id: string;
  readonly label: string;
  /** Behind you, where you are, or ahead. */
  readonly at: "done" | "now" | "next";
  /** The square; by default green behind, ink here, an outline ahead. */
  readonly square?: StageSquareKind;
  /** The word at the right: DONE behind you unless set; none here or ahead. */
  readonly word?: string | null;
  /** A screen's own test seams on the row (the wizard's `data-vex-wizard-step`). */
  readonly attrs?: Readonly<Record<`data-${string}`, string>>;
}

/** Where you are: the column's head (its name and "n/N") and its steps. */
export interface StageWhere {
  readonly label: string;
  readonly steps: readonly StageStep[];
}

function defaultSquare(at: StageStep["at"]): StageSquareKind {
  return at === "done" ? "done" : at === "now" ? "ink" : "none";
}

/** "Step 3 of 7": the current step's place, or the count of steps done. */
export function stageStepCount(where: StageWhere): { readonly at: number; readonly of: number } {
  const now = where.steps.findIndex((step) => step.at === "now");
  const done = where.steps.filter((step) => step.at === "done").length;
  return { at: now === -1 ? done : now + 1, of: where.steps.length };
}

function WhereColumn({ where }: { readonly where: StageWhere }): JSX.Element {
  const count = stageStepCount(where);
  return (
    <nav aria-label={where.label} className="vex-pre__where">
      <div className="vex-pre__where-head">
        <span className="vex-pre__where-name">{where.label}</span>
        <span className="vex-pre__count vex-num">{`${String(count.at)}/${String(count.of)}`}</span>
      </div>
      <ol className="vex-pre__steps">
        {where.steps.map((step) => {
          const word = step.word === undefined ? (step.at === "done" ? "Done" : null) : step.word;
          return (
            <li
              key={step.id}
              className="vex-pre__step"
              data-stage-step={step.id}
              data-state={step.at}
              aria-current={step.at === "now" ? "step" : undefined}
              {...step.attrs}
            >
              <StageSquare kind={step.square ?? defaultSquare(step.at)} />
              <span className="vex-pre__step-name">{step.label}</span>
              {word === null ? null : <span className="vex-pre__step-word">{word}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface StageFrameProps {
  /** `data-vex-screen`, the stable e2e and test selector. */
  readonly screen: string;
  /** The title cell's first line: the screen, or the step you are on. */
  readonly title: ReactNode;
  /** Its second line: where it is ("First run · Step 1 of 4"). */
  readonly sub: ReactNode;
  /**
   * The title is the screen's heading (an h1) unless the work column carries
   * its own (the unlock's greeting, a wizard step's title).
   */
  readonly heading?: boolean;
  readonly where: StageWhere;
  /** The bottom-left cell's link (the logs folder, the privacy page). */
  readonly foot?: ReactNode;
  /** The version in the bottom-left cell; the wizard's steps show the link alone. */
  readonly footVersion?: boolean;
  /** Extra attributes for the frame's root (the wizard's mood, a phase). */
  readonly rootProps?: Readonly<Record<`data-${string}`, string | undefined>>;
  /** The work column: `StageBody` and its rows, then the screen's `StageActs`. */
  readonly children: ReactNode;
}

/** The release the bottom-left cell shows. */
export function StageVersion(): JSX.Element {
  return (
    <span data-vex-version-stamp="" className="vex-pre__version vex-num">
      {`v${__VEX_APP_VERSION__}`}
    </span>
  );
}

export function StageFrame({
  screen,
  title,
  sub,
  heading = true,
  where,
  foot,
  footVersion = true,
  rootProps,
  children,
}: StageFrameProps): JSX.Element {
  const TitleTag = heading ? "h1" : "p";
  return (
    <main
      data-vex-onboarding="true"
      data-vex-gate="true"
      data-vex-screen={screen}
      className="vex-pre"
      {...rootProps}
    >
      <div className="vex-pre__logo vex-drag">
        <VexMark size={24} />
      </div>
      <header className="vex-pre__title vex-drag vex-overlay-end">
        <TitleTag className="vex-pre__name">{title}</TitleTag>
        <p className="vex-pre__sub">{sub}</p>
      </header>
      <WhereColumn where={where} />
      <div className="vex-pre__work">{children}</div>
      <div className="vex-pre__foot">
        {foot ?? null}
        {footVersion ? <StageVersion /> : null}
      </div>
    </main>
  );
}

/** The work column's scrolling body, above its bottom row. */
export function StageBody({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return <div className={cn("vex-pre__body", className)}>{children}</div>;
}

/** The screen's lead as the work column's first row, ruled off under it. */
export function StageLead({ children }: { readonly children: ReactNode }): JSX.Element {
  return <p className="vex-pre-row vex-pre-row--first">{children}</p>;
}

/**
 * The work column's bottom row, on the decision row's seams (section 1.8): a
 * key cell at the left, the screen's other way on in the middle, its one blue
 * key at the right edge, where SEND stands in a chat.
 */
export function StageActs({
  children,
  className,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return <div className={cn("vex-pre-acts", className)}>{children}</div>;
}

/** An empty cell that takes the bottom row's room between its keys. */
export function StageGap(): JSX.Element {
  return <div aria-hidden="true" className="vex-pre-gap" />;
}

/** The status strip over the bottom row (section 1.8): 31 high, cells of caps. */
export function StageStrip({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="vex-pre-strip">{children}</div>;
}
