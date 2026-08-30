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
import { IconClose } from "../../../../components/icons/index.js";
import { SplitPane } from "../../../../components/ui/split-pane.js";
import { cn } from "../../../../lib/utils.js";
import type { WorkspaceTerminalGroup } from "../workspace/types.js";
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
  readonly onTitleChange: (title: string) => void;
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
}

export function TerminalPaneGroup({
  group,
  visible,
  registry,
  onResizePanes,
  onActivatePane,
  onClosePane,
  onTitleChange,
  onPaneExit,
  lostTerminalIds,
}: TerminalPaneGroupProps): JSX.Element {
  const multiple = group.panes.length > 1;

  return (
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
            onTitleChange={onTitleChange}
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
              <span className="rounded border border-line-3 bg-surface-raised px-2 py-1">
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
  );
}
