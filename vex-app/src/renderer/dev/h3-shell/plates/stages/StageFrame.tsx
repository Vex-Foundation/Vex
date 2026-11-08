/**
 * THE STAGE FRAME - the frame every plate in this folder stands in: our H3
 * proposal for the screens before the shell (plan row S8-03,
 * docs/design/H3-DESKTOP.md section 4.9). Static markup on the H3 tokens and
 * the shell's own classes; nothing here reads the app, and nothing here
 * ships (`plates/types.ts`).
 *
 * It is the shell's frame with the chats column given over to the way in:
 *
 *   header  the mark | the Vex key over her column | the screen's title cell
 *   body    where you are | Kimm on her stage | the screen's work
 *   bottom  the version (and a link) | the tagline | the screen's keys
 *
 * so when the last stage hands over, the shell stands on the same seams
 * (the column rule, section 1.2; the header and bottom rows, sections 1.3
 * and 1.8). Kimm is drawn from the harness's stand-in crops
 * (`standins/manifest.ts`), which never leave this directory.
 */

import type { JSX, ReactNode } from "react";
import { VexMark } from "../../../../components/common/VexMark.js";
import {
  LineArrowUp,
  LineChevronUp,
  LineClose,
} from "../../../../components/icons/line/index.js";
import { Keycaps } from "../../../../components/ui/keycaps.js";
import type { StudioPlatform } from "../../../../features/appShell/studio/keybindings-labels.js";
import { PortraitGlyph } from "../../../../features/vex/VexKeyPortrait.js";
import { VEX_TOGGLE_CHORD } from "../../../../features/vex/vex-toggle-shortcut.js";
import { KIMM_STANDINS, type KimmStandinSectionMood } from "../../standins/manifest.js";
import "./stages.css";

/** The release the plates show: the last one shipped (sample). */
export const PLATE_VERSION = "v0.4.3";

/**
 * A status square (section 2.2): green done, red failed, grey running, ink
 * waiting or here now, an ink outline for Vex at Ready, a muted outline where
 * nothing has happened yet.
 */
export type SquareKind = "done" | "failed" | "running" | "ink" | "outline" | "none";

export function Square({ kind }: { readonly kind: SquareKind }): JSX.Element {
  return <span aria-hidden className="vex-stg__sq" data-sq={kind} />;
}

/** A square and its word, the word in ink caps. */
export function Status({
  kind,
  word,
}: {
  readonly kind: SquareKind;
  readonly word: string;
}): JSX.Element {
  return (
    <span className="vex-stg__status">
      <Square kind={kind} />
      {word}
    </span>
  );
}

/** The suggestion cells' arrow: the up arrow turned to the right. */
export function Arrow({ className }: { readonly className?: string }): JSX.Element {
  return <LineArrowUp size={16} className={className ?? "vex-stg__row-arrow"} />;
}

/** One row of the left column. */
export interface StageStep {
  readonly name: string;
  /** Behind you, where you are, or ahead. */
  readonly at: "done" | "now" | "next";
  /** The square's kind; by default green behind, ink here, an outline ahead. */
  readonly square?: SquareKind;
  /** The word at the right, in ink caps: DONE behind you unless set. */
  readonly word?: string | null;
}

export interface StageVexKey {
  /** Her state's word (`features/vex/vex-state.ts`), sentence case. */
  readonly word: string;
  /** A timer after the word while she works, m:ss. */
  readonly timer?: string;
}

export interface StageFrameProps {
  /** The title cell's two lines: the screen, and where it is. */
  readonly title: string;
  readonly sub: string;
  readonly vex: StageVexKey;
  readonly where: {
    readonly head: string;
    readonly count: string;
    readonly steps: readonly StageStep[];
  };
  /** Which of her stand-in sections stands on the stage. */
  readonly kimm: KimmStandinSectionMood;
  /** The work column's content. */
  readonly children: ReactNode;
  /** The work column's cells in the bottom row. */
  readonly acts: ReactNode;
  /**
   * A link in the bottom row's left cell, beside the version, or (with
   * `footVersion: false`) in its place, as the wizard's footer has it today.
   */
  readonly footLink?: ReactNode;
  readonly footVersion?: boolean;
}

/** The window's platform, as the harness stamped it on <html> (`?os=`). */
function platform(): StudioPlatform {
  const os = document.documentElement.dataset["os"];
  return os === "win" ? "win32" : os === "linux" ? "linux" : "darwin";
}

/**
 * The Vex key as the shell draws it with her section open (section 1.6): the
 * portrait glyph on the open ground, her state, Hide Vex with its keycaps, the
 * up chevron. On the stage it means what it means in the shell: Hide Vex
 * folds her to the strip, and the choice is the one stored choice.
 */
function VexKeyCells({ vex }: { readonly vex: StageVexKey }): JSX.Element {
  const ready = vex.word === "Ready";
  return (
    <button type="button" className="vex-key" aria-label="Hide Vex">
      <span className="vex-key__portrait" data-open="">
        <PortraitGlyph />
      </span>
      <span className="vex-key__state">
        <span className="vex-key__line vex-key__status">
          <Square kind={ready ? "outline" : "ink"} />
          <span className="vex-key__word">{vex.word}</span>
          {vex.timer === undefined ? null : (
            <span className="vex-key__timer">{vex.timer}</span>
          )}
        </span>
        <span className="vex-key__line vex-key__action">
          <span className="vex-key__name">Hide Vex</span>
          <Keycaps chord={VEX_TOGGLE_CHORD} platform={platform()} decorative />
        </span>
      </span>
      <span className="vex-key__chevron">
        <LineChevronUp size={16} />
      </span>
    </button>
  );
}

function defaultSquare(at: StageStep["at"]): SquareKind {
  return at === "done" ? "done" : at === "now" ? "ink" : "none";
}

function WhereColumn({ where }: { readonly where: StageFrameProps["where"] }): JSX.Element {
  return (
    <nav aria-label={where.head} className="vex-stg__where">
      <div className="vex-stg__where-head">
        <span className="vex-eyebrow">{where.head}</span>
        <span className="vex-stg__count">{where.count}</span>
      </div>
      <ol className="vex-stg__steps">
        {where.steps.map((step) => {
          const word = step.word === undefined ? (step.at === "done" ? "Done" : null) : step.word;
          return (
            <li
              key={step.name}
              className="vex-stg__step"
              data-at={step.at}
              aria-current={step.at === "now" ? "step" : undefined}
            >
              <Square kind={step.square ?? defaultSquare(step.at)} />
              <span className="vex-stg__step-name">{step.name}</span>
              {word === null ? null : <span className="vex-stg__step-word">{word}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Kimm on her stage: the column's whole height, her corner key over her. */
function KimmStage({ mood }: { readonly mood: KimmStandinSectionMood }): JSX.Element {
  const art = KIMM_STANDINS.sections[mood];
  return (
    <section aria-label="Vex" className="vex-stg__kimm" data-vex-stg-kimm={mood}>
      <img
        alt=""
        src={art.src}
        width={art.width}
        height={art.height}
        className="vex-stg__art"
        draggable={false}
      />
      <button type="button" className="vex-stg__corner">
        Hide Vex
        <LineClose size={16} />
      </button>
    </section>
  );
}

export function StageFrame({
  title,
  sub,
  vex,
  where,
  kimm,
  children,
  acts,
  footLink,
  footVersion = true,
}: StageFrameProps): JSX.Element {
  return (
    <main className="vex-stg" data-vex-stg="">
      <div className="vex-stg__cell vex-stg__head vex-stg__head--logo vex-drag">
        <VexMark size={24} />
      </div>
      <div className="vex-stg__cell vex-stg__head vex-stg__head--vex">
        <VexKeyCells vex={vex} />
      </div>
      <header className="vex-stg__cell vex-stg__head vex-stg__head--title vex-drag">
        <h1 className="vex-stg__title">{title}</h1>
        <p className="vex-stg__sub">{sub}</p>
      </header>

      <WhereColumn where={where} />
      <KimmStage mood={kimm} />
      <div className="vex-stg__work">{children}</div>

      <div className="vex-stg__cell vex-stg__foot">
        {footLink ?? null}
        {footVersion ? <span className="vex-stg__version">{PLATE_VERSION}</span> : null}
      </div>
      <div className="vex-stg__cell vex-stg__tagline vex-drag">
        <p className="vex-tagline">
          <span className="vex-tagline__text">
            <span className="vex-tagline__lead">An AI trading agent,</span>{" "}
            <span className="vex-tagline__rest">on your computer.</span>
          </span>
        </p>
      </div>
      <div className="vex-stg__cell vex-stg__acts">{acts}</div>
    </main>
  );
}
