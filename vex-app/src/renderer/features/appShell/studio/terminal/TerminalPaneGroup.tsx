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
 */

import type { JSX } from "react";
import type { TerminalShellId, TerminalShellOption } from "@shared/schemas/terminal.js";
import { IconClose } from "../../../../components/icons/index.js";
import { SplitPane } from "../../../../components/ui/split-pane.js";
import { cn } from "../../../../lib/utils.js";
import type { WorkspaceTerminalGroup } from "../workspace/types.js";
import { TerminalPanelHeader } from "./TerminalPanelHeader.js";
import { XtermHost } from "./XtermHost.js";
import type { TerminalRegistry } from "./terminal-registry.js";

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
   * the shell label the tooltip and the header's second line show.
   */
  readonly onShellTitle: (terminalId: string, title: string) => void;
  /** The header's split action, for the tab this group is. */
  readonly onSplit: (orientation: "horizontal" | "vertical") => void;
  /** The header's kill action: end the shell this header describes. */
  readonly onKill: () => void;
  /** The header's rename action, committed by the user. */
  readonly onRename: (title: string) => void;
  /**
   * WHAT IS RUNNING in the active pane, as the host reported it, or `null`
   * before it has said. The tab is named `Terminal n`, so this is the header's
   * second line rather than its title.
   */
  readonly shellLabel: string | null;
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
  /** Which shell the NEXT terminal opens with, and the rows to pick from. */
  readonly shellId: TerminalShellId;
  readonly shells: readonly TerminalShellOption[];
  readonly onSelectShell: (shellId: TerminalShellId) => void;
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
  shellLabel,
  onDisplayCwdChange,
  onPaneExit,
  lostTerminalIds,
  shellId,
  shells,
  onSelectShell,
}: TerminalPaneGroupProps): JSX.Element {
  const multiple = group.panes.length > 1;

  // The header describes the ACTIVE pane - the one the user is typing into.
  // With one pane that is the only pane; with several it follows the same
  // `activePaneId` the focus ring below is drawn from, so the header and the
  // ring can never name different shells.
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
        shellLabel={shellLabel}
        shellId={shellId}
        shells={shells}
        onSelectShell={onSelectShell}
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
          className="h-full w-full"
        >
          {group.panes.map((pane, index) => {
            const lost = lostTerminalIds?.has(pane.terminalId) === true;
            return (
            <div
              key={pane.paneId}
              className={cn(
                "relative h-full w-full",
                // The ACTIVE pane is named by a hairline, not by a fill: a filled
                // active pane would sit on top of the terminal's own background and
                // change how the output reads.
                multiple && pane.paneId === group.activePaneId
                  ? "ring-1 ring-accent-primary ring-inset"
                  : null,
              )}
            >
              <XtermHost
                terminalId={pane.terminalId}
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
                  className="absolute inset-0 flex items-end justify-center bg-surface-base/60 p-3 text-[12px] text-ink-secondary"
                >
                  {/* `bg-surface-2`, not the `bg-surface-raised` that used to
                      be here: there is no `--color-surface-raised` in the
                      theme, so that utility emitted NOTHING and this notice
                      floated over the terminal with no plate under it. */}
                  <span className="rounded border border-line-3 bg-surface-2 px-2 py-1">
                    This shell ended when the terminal service stopped.
                  </span>
                </div>
              ) : null}
              {multiple ? (
                <button
                  type="button"
                  aria-label={`Close terminal ${String(index + 1)} in ${group.title}`}
                  onClick={() => {
                    onClosePane(pane.paneId);
                  }}
                  className="absolute top-1 right-1 rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <IconClose size={12} />
                </button>
              ) : null}
            </div>
            );
          })}
        </SplitPane>
      </div>
    </div>
  );
}
