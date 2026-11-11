/**
 * TerminalPaneGroup - ONE tab's worth of terminals, split along one axis.
 *
 * The group is the seam between two owners that must not learn each other's
 * job: `components/ui/split-pane.tsx` owns the geometry of a split, and
 * `studio/workspace/workspace-model.ts` owns the shares as state. This component
 * hands the primitive the model's shares and hands the model back whatever the
 * primitive computed, through `resizePanes` - one array, positionally matched.
 *
 * It deliberately does NOT call the model's `resizePane` (the single-pane
 * variant). The primitive already resolved which neighbour a drag traded with,
 * including the end-pane inversion; re-deriving that at the state layer would be
 * a second implementation of the same rule, free to disagree with the first.
 *
 * IN H3 CELLS (our approved Studio plate, docs/design/H3-DESKTOP.md section
 * 4.9; terminal.css): the panel header over the panes; a split lays its panes
 * on a 1px rule, each under a 36 head with its state square, its process and
 * its close key, the active pane's head on the raised fill and the others on
 * the ground. The terminal's text is on the ground itself.
 */

import type { JSX } from "react";
import { LineClose } from "../../../../components/icons/line/index.js";
import { SplitPane } from "../../../../components/ui/split-pane.js";
import type { WorkspaceTerminalGroup } from "../workspace/types.js";
import { TerminalPanelHeader } from "./TerminalPanelHeader.js";
import { TerminalStateSquare } from "./TerminalStateSquare.js";
import { XtermHost } from "./XtermHost.js";
import { terminalShellLabel } from "./terminal-copy.js";
import type { TerminalRegistry } from "./terminal-registry.js";
import {
  terminalGroupRunState,
  terminalPaneRunState,
  type TerminalRunFacts,
} from "./terminal-tab-model.js";

const EMPTY_SHELL_LABELS: ReadonlyMap<string, string> = new Map<string, string>();

export interface TerminalPaneGroupProps {
  readonly group: WorkspaceTerminalGroup;
  /** Whether this group's TAB is the selected one. Drives the mandatory refit. */
  readonly visible: boolean;
  readonly registry?: TerminalRegistry;
  readonly onResizePanes: (relativeSizes: readonly number[]) => void;
  readonly onActivatePane: (paneId: string) => void;
  readonly onClosePane: (paneId: string) => void;
  /**
   * The SHELL said what it is running (an OSC title). It no longer names the
   * tab - a tab is `Terminal n` or whatever the user called it - so this feeds
   * the shell label the tooltip, the header's second line and a pane's head
   * show.
   */
  readonly onShellTitle: (terminalId: string, title: string) => void;
  /** The header's split action, for the tab this group is. */
  readonly onSplit: (orientation: "horizontal" | "vertical") => void;
  /** The header's kill action: end the shell this header describes. */
  readonly onKill: () => void;
  /** The header's rename action, committed by the user. */
  readonly onRename: (title: string) => void;
  /**
   * WHAT IS RUNNING in each pane, as the host reported it, keyed by terminal
   * id; a pane the host has not described yet is absent. The tab is named
   * `Terminal n`, so this is the header's second line and a pane head's name.
   */
  readonly shellLabelById?: ReadonlyMap<string, string>;
  /**
   * One shell reported where it now is. Routed to the WORKSPACE MODEL, which
   * owns the value: this component reads `pane.displayCwd` and holds no copy,
   * so the header a reattach seeds and the header a `cd` updates are the same
   * field. Keyed by terminal id, which is what the property event names.
   */
  readonly onDisplayCwdChange: (terminalId: string, displayCwd: string) => void;
  readonly onPaneExit: (paneId: string, info: { exitCode: number; signal: number | null }) => void;
  /**
   * Terminals whose pty died with the pty host.
   *
   * The pane is NOT unmounted for one: the xterm still holds the scrollback the
   * user was reading, and destroying it would take that away before they had
   * been told anything. It is covered with a dead overlay instead, which also
   * stops keystrokes from going into a shell that cannot receive them.
   */
  readonly lostTerminalIds?: ReadonlySet<string>;
  /**
   * What the panel's and the panes' squares are drawn from: the host-loss
   * set, the exits the panes reported and whether a restore is running.
   * Defaults to the lost set alone, as a fresh workspace has it.
   */
  readonly runFacts?: TerminalRunFacts;
}

export function TerminalPaneGroup({
  group,
  visible,
  registry,
  onResizePanes,
  onActivatePane,
  onClosePane,
  onShellTitle,
  onSplit,
  onKill,
  onRename,
  shellLabelById = EMPTY_SHELL_LABELS,
  onDisplayCwdChange,
  onPaneExit,
  lostTerminalIds,
  runFacts,
}: TerminalPaneGroupProps): JSX.Element {
  const multiple = group.panes.length > 1;
  const facts: TerminalRunFacts = runFacts ?? {
    lostTerminalIds: lostTerminalIds ?? new Set<string>(),
    exits: new Map(),
    restoring: false,
  };

  // The header describes the ACTIVE pane - the one the user is typing into.
  // With one pane that is the only pane; with several it follows the same
  // `activePaneId` the raised head below is drawn from, so the header and the
  // head can never name different shells.
  //
  // THE DIRECTORY IS READ FROM THE MODEL, never remembered here. This component
  // used to keep its own `Map<terminalId, displayCwd>` fed only by the property
  // stream, which meant a reattached terminal - a renderer reload, a project
  // switch-back - had a header saying the directory was not known yet until the
  // user typed `cd`, because the property that would have filled the map had
  // been emitted in a previous life of this component. The pane carries the
  // seed main obtained from the host, so the header is right on the first frame.
  const activePane =
    group.panes.find((pane) => pane.paneId === group.activePaneId) ?? group.panes[0];
  const activeLabel = activePane?.displayCwd ?? null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <TerminalPanelHeader
        title={group.title}
        displayCwd={activeLabel}
        shellLabel={
          activePane === undefined ? null : (shellLabelById.get(activePane.terminalId) ?? null)
        }
        state={terminalGroupRunState(group, facts)}
        onSplit={onSplit}
        onKill={onKill}
        onRename={onRename}
      />
      <div className="min-h-0 flex-1">
        <SplitPane
          orientation={group.orientation}
          sizes={group.panes.map((pane) => pane.relativeSize)}
          onResize={onResizePanes}
          separatorLabel={(index) =>
            `Resize terminal ${String(index + 1)} in ${group.title}`
          }
          className="vex-ws-panes h-full w-full"
        >
          {group.panes.map((pane, index) => {
            const lost = lostTerminalIds?.has(pane.terminalId) === true;
            const active = pane.paneId === group.activePaneId;
            return (
            <div
              key={pane.paneId}
              // THE PANE is the ground. The active pane of a split is named by
              // its head on the raised fill, never by a frame round the
              // terminal: a fill there would change how the output reads.
              data-active={multiple && active ? "" : undefined}
              className="vex-ws-pane relative flex h-full w-full flex-col"
            >
              {multiple ? (
                <div className="vex-ws-pane__head" data-vex-pane-head="">
                  <TerminalStateSquare state={terminalPaneRunState(pane.terminalId, facts)} />
                  <span className="vex-ws-pane__name">
                    {terminalShellLabel(shellLabelById.get(pane.terminalId) ?? null)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Close terminal ${String(index + 1)} in ${group.title}`}
                    title={`Close terminal ${String(index + 1)} in ${group.title}`}
                    onClick={() => {
                      onClosePane(pane.paneId);
                    }}
                    className="vex-ws-pane__close"
                  >
                    <LineClose size={14} />
                  </button>
                </div>
              ) : null}
              <div className="relative flex min-h-0 flex-1 flex-col">
                <XtermHost
                  terminalId={pane.terminalId}
                  launchShellName={pane.launchShellName ?? null}
                  visible={visible}
                  {...(registry === undefined ? {} : { registry })}
                  onTitleChange={(title) => {
                    onShellTitle(pane.terminalId, title);
                  }}
                  onDisplayCwdChange={(displayCwd) => {
                    onDisplayCwdChange(pane.terminalId, displayCwd);
                  }}
                  onActivate={() => {
                    onActivatePane(pane.paneId);
                  }}
                  onExit={(info) => {
                    onPaneExit(pane.paneId, info);
                  }}
                />
                {lost ? (
                  <div
                    // The overlay is the ENFORCEMENT, not a label: it sits over the
                    // terminal so a keystroke cannot reach a textarea whose pty no
                    // longer exists, while the scrollback stays readable behind it.
                    role="status"
                    className="absolute inset-0 flex items-end justify-center bg-surface-base/60 p-3 text-[13px] text-ink-secondary"
                  >
                    {/* A flat panel: the field and a 1px ink border. It is a
                        utility the theme defines; an earlier `bg-surface-raised`
                        named a token that does not exist, so that utility
                        emitted NOTHING and this notice floated over the terminal
                        with no plate under it. */}
                    <span className="border border-rule-ink bg-surface-field px-3 py-1.5 text-ink-primary">
                      This shell ended when the terminal service stopped.
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            );
          })}
        </SplitPane>
      </div>
    </div>
  );
}
