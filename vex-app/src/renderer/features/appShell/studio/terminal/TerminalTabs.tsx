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
import {
  IconClose,
  IconPlus,
  IconSplitHorizontal,
  IconSplitVertical,
  IconTerminal,
} from "../../../../components/icons/index.js";
import { Tabs, TabsList, TabsTrigger } from "../../../../components/ui/tabs.js";
import { cn } from "../../../../lib/utils.js";
import type { WorkspaceState, WorkspaceTab } from "../workspace/types.js";
import { FileTabPlaceholder } from "../viewer/FileTabPlaceholder.js";
import { TerminalPaneGroup } from "./TerminalPaneGroup.js";
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
  readonly onPaneExit: (
    tabId: string,
    paneId: string,
    info: { exitCode: number; signal: number | null },
  ) => void;
  /** A refusal or a status line, rendered above the panels. */
  readonly notice?: ReactNode;
  /**
   * Terminals whose pty died with the host. Their panes render DEAD rather than
   * disappearing, because the snapshot still holds their output.
   */
  readonly lostTerminalIds?: ReadonlySet<string>;
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
  onPaneExit,
  notice,
  lostTerminalIds,
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
                  onPaneExit={(paneId, info) => {
                    onPaneExit(tab.tabId, paneId, info);
                  }}
                />
              ) : (
                // File tabs already have a place in the model's ONE ordered
                // strip; the viewer that fills them is B3c's, and it replaces
                // this component. Rendering it keeps the strip honest instead
                // of hiding the tab.
                <FileTabPlaceholder relativePath={tab.relativePath} />
              )}
            </div>
          );
        })}
      </div>
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
