/**
 * THE STUDIO CENTRE, as our H3 plate draws it (S8-01, for S8-05): the chat
 * column while Studio is open. Like a page (docs/design/H3-DESKTOP.md
 * section 1.9) it runs from the header to the window's foot: Studio has no
 * composer, so there is no bottom row under it.
 *
 *   the tabs row      56: a cell per tab (a terminal's state square and its
 *                     name; a file tab in mono, italic while it is the
 *                     preview), the + key cell for a new terminal, and at the
 *                     right the shell the next terminal runs (SHELL zsh, a
 *                     chevron), where H3's page tabs put "Updated 12:41"
 *   the panel header  56: the tab's name over the active pane's process and
 *                     directory in mono; then its state in words (RUNNING,
 *                     EXITED 0) and four square key cells: split right, split
 *                     down, rename, kill
 *   the panes         the terminal's text on the ground, in mono. A split
 *                     lays its panes on a 1px rule, each under a 36 head with
 *                     its process and a close key; the active pane's head
 *                     takes the raised fill, the others stay on the ground
 *
 * No blue: Studio has no primary key (blue fills only the one primary key,
 * section 2.4), and no status colour outside a state square, except the
 * green and red a program prints in its own output.
 *
 * Static markup over the plate's sample (`studio-sample.ts`): no terminal,
 * shell or file is read.
 */

import type { JSX } from "react";
import {
  LineChevronDown,
  LineClose,
  LineEdit,
  LineFile,
  LinePlus,
  LineSplitHorizontal,
  LineSplitVertical,
  LineTrash,
} from "../../../../components/icons/line/index.js";
import { StateSquare as Square } from "../../../../components/ui/state-square.js";
import { TerminalStateSquare } from "../../../../features/appShell/studio/terminal/TerminalStateSquare.js";
import type { TerminalTabRunState } from "../../../../features/appShell/studio/terminal/terminal-tab-model.js";
import type { SampleTab, TermLine } from "./studio-sample.js";

/** A terminal state's square: the product's own (docs/design/H3-DESKTOP.md section 2.2). */
function StateSquare({ state }: { readonly state: TerminalTabRunState }): JSX.Element {
  return <TerminalStateSquare state={state} />;
}

function Tabs({ tabs }: { readonly tabs: readonly SampleTab[] }): JSX.Element {
  return (
    <div className="vex-plate-studio__tabs">
      {/* The strip scrolls sideways when the tabs outgrow it; + and the shell cell stay. */}
      <div className="vex-plate-studio__strip" role="tablist" aria-label="Terminals and files">
        {tabs.map((tab, index) =>
          tab.kind === "terminal" ? (
            <span
              key={tab.title}
              role="tab"
              aria-selected={index === 0}
              className="vex-plate-studio__tab"
              data-selected={index === 0 ? "" : undefined}
            >
              <StateSquare state={tab.state ?? "running"} />
              <span>{tab.title}</span>
              {index === 0 ? (
                <span aria-hidden className="vex-plate-studio__tab-close">
                  <LineClose size={14} />
                </span>
              ) : null}
            </span>
          ) : (
            <span
              key={tab.title}
              role="tab"
              aria-selected={false}
              className="vex-plate-studio__tab vex-plate-studio__tab--file"
              data-preview={tab.preview === true ? "" : undefined}
            >
              <LineFile size={14} />
              <span className="vex-plate-studio__file">{tab.title}</span>
            </span>
          ),
        )}
      </div>
      <span className="vex-plate-studio__plus" title="New terminal">
        <LinePlus size={16} />
      </span>
      <span className="vex-plate-studio__fill" />
      <span className="vex-plate-studio__shell" title="Shell for the next terminal">
        <span className="vex-plate-studio__shell-label">Shell</span>
        <span className="vex-plate-studio__shell-value">zsh</span>
        <LineChevronDown size={14} />
      </span>
    </div>
  );
}

function PanelHeader({
  name,
  where,
  state,
}: {
  readonly name: string;
  readonly where: string;
  readonly state: string;
}): JSX.Element {
  return (
    <div className="vex-plate-studio__panel">
      <div className="vex-plate-studio__id">
        <span className="vex-plate-studio__name">{name}</span>
        <span className="vex-plate-studio__where">{where}</span>
      </div>
      <span className="vex-plate-studio__state">
        <Square state="ongoing" size={6} />
        <span>{state}</span>
      </span>
      <span className="vex-plate-studio__key" title="Split right">
        <LineSplitVertical size={16} />
      </span>
      <span className="vex-plate-studio__key" title="Split down">
        <LineSplitHorizontal size={16} />
      </span>
      <span className="vex-plate-studio__key" title="Rename">
        <LineEdit size={16} />
      </span>
      <span className="vex-plate-studio__key" title="Kill the shell">
        <LineTrash size={16} />
      </span>
    </div>
  );
}

function Term({ lines, cursor }: { readonly lines: readonly TermLine[]; readonly cursor: boolean }): JSX.Element {
  const last = lines.length - 1;
  return (
    <pre className="vex-plate-studio__term" aria-label="Terminal output (sample)">
      {/* A plate's fixed sample: a line's and a run's index are their identity. */}
      {lines.map((line, row) => (
        <span key={row}>
          {line.map(([role, text], run) => (
            <span key={run} data-t={role}>
              {text}
            </span>
          ))}
          {cursor && row === last ? <span aria-hidden className="vex-plate-studio__cursor" /> : null}
          {row === last ? null : "\n"}
        </span>
      ))}
    </pre>
  );
}

export interface StudioPane {
  readonly process: string;
  readonly lines: readonly TermLine[];
  /** The pane's shell sits at its prompt: the cursor is drawn at the end. */
  readonly idle: boolean;
}

export interface StudioCentreProps {
  readonly tabs: readonly SampleTab[];
  /** The active pane's process and directory, the panel header's second line. */
  readonly where: string;
  /** The active pane first. One pane, or two laid side by side. */
  readonly panes: readonly [StudioPane] | readonly [StudioPane, StudioPane];
}

export function StudioCentrePlate({ tabs, where, panes }: StudioCentreProps): JSX.Element {
  const split = panes.length > 1;
  const name = tabs[0]?.title ?? "";
  return (
    <div className="vex-plate-studio" data-vex-plate-part="studio-centre">
      <Tabs tabs={tabs} />
      <PanelHeader name={name} where={where} state="Running" />
      <div className="vex-plate-studio__panes">
        {panes.map((pane, index) => (
          <div
            key={pane.process + String(index)}
            className="vex-plate-studio__pane"
            data-active={index === 0 ? "" : undefined}
          >
            {split ? (
              <div className="vex-plate-studio__pane-head">
                <StateSquare state="running" />
                <span>{pane.process}</span>
                <span aria-hidden className="vex-plate-studio__pane-close">
                  <LineClose size={14} />
                </span>
              </div>
            ) : null}
            <Term lines={pane.lines} cursor={pane.idle} />
          </div>
        ))}
      </div>
    </div>
  );
}
