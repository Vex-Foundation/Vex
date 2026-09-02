/**
 * TerminalTabs - the Studio's tab strip and its KEEP-ALIVE content stack.
 *
 * ## The strip is the shared Tabs primitive; the content is not TabsContent
 *
 * `components/ui/tabs.tsx` gives the strip everything the WAI-ARIA tabs pattern
 * needs and this component must not re-implement: `role="tablist"`/`tab`,
 * `aria-selected`, `aria-controls`, roving tabindex, and Arrow/Home/End
 * navigation.
 *
 * The PANELS, though, are rendered here rather than through `TabsContent`, and
 * that is deliberate. `TabsContent` with `keepMounted` marks a dormant panel
 * `inert`, which is exactly right for a form or a scroll offset and exactly
 * wrong for a terminal: `inert` on the subtree an xterm lives in takes its
 * textarea out of the focus model, and a terminal you cannot focus after a tab
 * switch is a broken terminal. So the panels are a plain CSS-HIDDEN STACK - the
 * same "hide, never unmount" grammar `BookPanel.tsx` uses for the inspect
 * overlay - and they carry the tabpanel semantics themselves.
 *
 * Hiding with `hidden` (`display: none`) is what makes the refit on activation
 * MANDATORY: a `display: none` element measures 0x0, so `FitAddon` computed
 * nonsense for every frame a pane spent hidden. `XtermHost` refits whenever its
 * `visible` prop turns true; this component is what flips it.
 *
 * ## Close and split live BESIDE the trigger, not inside it
 *
 * A `<button>` cannot contain a `<button>`, and the primitive's keyboard
 * navigation finds its siblings through `parentElement.querySelectorAll('[role=tab]')`.
 * Wrapping each trigger with its close button in a div would satisfy HTML and
 * break the roving tabindex. So the per-tab controls are SIBLINGS of the trigger
 * inside the tablist, which keeps both the markup valid and the navigation
 * intact, and leaves every control reachable by keyboard in reading order.
 */

import type { JSX, ReactNode } from "react";
import type { TerminalShellId, TerminalShellOption } from "@shared/schemas/terminal.js";
import {
  IconClose,
  IconPlus,
  IconSplitHorizontal,
  IconSplitVertical,
  IconTerminal,
} from "../../../../components/icons/index.js";
import { Tabs, TabsList, TabsTrigger } from "../../../../components/ui/tabs.js";
import { cn } from "../../../../lib/utils.js";
import type { WorkspaceFileTab, WorkspaceState, WorkspaceTab } from "../workspace/types.js";
import { TerminalPaneGroup } from "./TerminalPaneGroup.js";
import { EMPTY_WORKSPACE_ACTION_COPY, EMPTY_WORKSPACE_COPY } from "./terminal-copy.js";
import type { TerminalRegistry } from "./terminal-registry.js";

/** Namespaces the primitive's generated ids so a second strip cannot collide. */
export const TERMINAL_TABS_ID_SCOPE = "studio-terminal";

/** Stable identity so the default does not remount consumers on every render. */
const EMPTY_LOST: ReadonlySet<string> = new Set<string>();

export interface TerminalTabsProps {
  readonly state: WorkspaceState;
  readonly registry?: TerminalRegistry;
  readonly onSelectTab: (tabId: string) => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onNewTerminal: () => void;
  readonly onSplit: (tabId: string, orientation: "horizontal" | "vertical") => void;
  readonly onResizePanes: (tabId: string, relativeSizes: readonly number[]) => void;
  readonly onActivatePane: (tabId: string, paneId: string) => void;
  readonly onClosePane: (tabId: string, paneId: string) => void;
  readonly onTitleChange: (tabId: string, title: string) => void;
  /**
   * One terminal reported its directory. NO `tabId` is passed on: a terminal id
   * identifies a pane on its own, and the workspace model resolves it - a
   * second identifier here would only be another chance to name the wrong pane.
   */
  readonly onDisplayCwdChange: (terminalId: string, displayCwd: string) => void;
  readonly onPaneExit: (
    tabId: string,
    paneId: string,
    info: { exitCode: number; signal: number | null },
  ) => void;
  /**
   * How a FILE tab's panel is filled.
   *
   * REQUIRED, not optional. An optional render prop would leave a code path in
   * which a file tab renders nothing at all - a tab in the strip with an empty
   * panel behind it - and the caller would find out by looking. The viewer is
   * the workspace's to supply because `projectId` lives there and not here.
   *
   * `isActive` is passed through rather than derived by the callee: this
   * component owns which panel is on screen, and the viewer needs it to decide
   * whether to hold a highlight request.
   */
  readonly renderFileTab: (tab: WorkspaceFileTab, isActive: boolean) => ReactNode;
  /** A refusal or a status line, rendered above the panels. */
  readonly notice?: ReactNode;
  /**
   * Terminals whose pty died with the host. Their panes render DEAD rather than
   * disappearing, because the snapshot still holds their output.
   */
  readonly lostTerminalIds?: ReadonlySet<string>;
  /**
   * Which shell the next terminal opens with, and the catalogue behind the
   * picker. Passed THROUGH to each terminal panel's header rather than
   * rendered here: the strip is one control for the whole workspace, and the
   * header belongs to the panel it describes.
   */
  readonly shellId: TerminalShellId;
  readonly shells: readonly TerminalShellOption[];
  readonly onSelectShell: (shellId: TerminalShellId) => void;
}

export function TerminalTabs({
  state,
  registry,
  onSelectTab,
  onCloseTab,
  onNewTerminal,
  onSplit,
  onResizePanes,
  onActivatePane,
  onClosePane,
  onTitleChange,
  onDisplayCwdChange,
  onPaneExit,
  renderFileTab,
  notice,
  lostTerminalIds,
  shellId,
  shells,
  onSelectShell,
}: TerminalTabsProps): JSX.Element {
  const activeTabId = state.activeTabId ?? "";
  const lost = lostTerminalIds ?? EMPTY_LOST;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        value={activeTabId}
        onValueChange={onSelectTab}
        idScope={TERMINAL_TABS_ID_SCOPE}
        className="min-h-0 shrink-0"
      >
        <TabsList
          aria-label="Studio terminals and files"
          className="h-9 w-full justify-start gap-0 overflow-x-auto rounded-none border-x-0 border-t-0 border-b border-line-3 p-0"
        >
          {state.tabs.map((tab) => (
            <TabRow
              key={tab.tabId}
              tab={tab}
              active={tab.tabId === state.activeTabId}
              onCloseTab={onCloseTab}
              onSplit={onSplit}
            />
          ))}
          <button
            type="button"
            aria-label="New terminal"
            onClick={onNewTerminal}
            className="ml-1 rounded-md p-1.5 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <IconPlus size={14} />
          </button>
        </TabsList>
      </Tabs>

      {notice}

      <div className="relative min-h-0 flex-1">
        {state.tabs.length === 0 ? <EmptyWorkspace onNewTerminal={onNewTerminal} /> : null}
        {state.tabs.map((tab) => {
          const isActive = tab.tabId === state.activeTabId;
          return (
            <div
              key={tab.tabId}
              role="tabpanel"
              id={`tabpanel-${TERMINAL_TABS_ID_SCOPE}-${tab.tabId}`}
              aria-labelledby={`tab-${TERMINAL_TABS_ID_SCOPE}-${tab.tabId}`}
              data-tab-id={tab.tabId}
              // CSS-hidden, NEVER unmounted: a remount would throw away the
              // scrollback and force a full replay on every tab switch.
              hidden={!isActive}
              className="absolute inset-0 min-h-0"
            >
              {tab.kind === "terminalGroup" ? (
                <TerminalPaneGroup
                  group={tab}
                  visible={isActive}
                  lostTerminalIds={lost}
                  shellId={shellId}
                  shells={shells}
                  onSelectShell={onSelectShell}
                  {...(registry === undefined ? {} : { registry })}
                  onResizePanes={(sizes) => {
                    onResizePanes(tab.tabId, sizes);
                  }}
                  onActivatePane={(paneId) => {
                    onActivatePane(tab.tabId, paneId);
                  }}
                  onClosePane={(paneId) => {
                    onClosePane(tab.tabId, paneId);
                  }}
                  onTitleChange={(title) => {
                    onTitleChange(tab.tabId, title);
                  }}
                  onDisplayCwdChange={onDisplayCwdChange}
                  onPaneExit={(paneId, info) => {
                    onPaneExit(tab.tabId, paneId, info);
                  }}
                />
              ) : (
                renderFileTab(tab, isActive)
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What the panel area shows when the workspace holds NO tabs.
 *
 * ## When this is on screen at all
 *
 * Opening a project auto-creates its first terminal, so a fresh project does
 * not land here. What remains are the two cases the auto-open deliberately does
 * not cover: a restore Vex could not READ (spawning a shell over a layout that
 * may exist is how a good snapshot gets overwritten by an empty one), and a user
 * who closed every tab. Both used to render an unlabelled black rectangle, which
 * reads as a broken surface rather than an empty one and offers nothing to do
 * about it.
 *
 * ## Why it is not a live region
 *
 * The `notice` slot immediately above already announces the failure that can
 * lead here, as `alert` or `status`. Announcing the same fact twice is noise,
 * and this panel carries no news of its own: it is a destination, reachable by
 * keyboard through its one button, which is what rule 08 asks of it. Its action
 * is named differently from the strip's `+` for the same reason - two controls
 * with one accessible name cannot be told apart by name.
 */
function EmptyWorkspace({
  onNewTerminal,
}: {
  readonly onNewTerminal: () => void;
}): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      {/* The glyphs are `aria-hidden` at the source, per the icon gate. */}
      <IconTerminal size={20} className="text-ink-tertiary" />
      <p className="max-w-xs text-[12px] leading-4 text-ink-tertiary">
        {EMPTY_WORKSPACE_COPY}
      </p>
      <button
        type="button"
        onClick={onNewTerminal}
        className="inline-flex items-center gap-1.5 rounded-md border border-line-3 px-2.5 py-1.5 text-[12px] leading-4 font-medium text-ink-primary hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <IconPlus size={12} />
        {EMPTY_WORKSPACE_ACTION_COPY}
      </button>
    </div>
  );
}

function TabRow({
  tab,
  active,
  onCloseTab,
  onSplit,
}: {
  readonly tab: WorkspaceTab;
  readonly active: boolean;
  readonly onCloseTab: (tabId: string) => void;
  readonly onSplit: (tabId: string, orientation: "horizontal" | "vertical") => void;
}): JSX.Element {
  const isGroup = tab.kind === "terminalGroup";
  return (
    <>
      <TabsTrigger
        value={tab.tabId}
        className={cn(
          "h-full gap-1.5 rounded-none border-r border-line-3 px-3",
          active ? "bg-interactive-active text-ink-primary" : null,
        )}
      >
        {isGroup ? <IconTerminal size={12} /> : null}
        <span className="max-w-40 truncate">{tab.title}</span>
      </TabsTrigger>
      {isGroup ? (
        <>
          <button
            type="button"
            aria-label={`Split ${tab.title} side by side`}
            onClick={() => {
              onSplit(tab.tabId, "horizontal");
            }}
            className="rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <IconSplitHorizontal size={12} />
          </button>
          <button
            type="button"
            aria-label={`Split ${tab.title} top and bottom`}
            onClick={() => {
              onSplit(tab.tabId, "vertical");
            }}
            className="rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <IconSplitVertical size={12} />
          </button>
        </>
      ) : null}
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={() => {
          onCloseTab(tab.tabId);
        }}
        className="mr-2 rounded p-1 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <IconClose size={12} />
      </button>
    </>
  );
}
