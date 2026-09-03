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
 * ## A tab shows its NAME and its STATE, and nothing else at rest
 *
 * The strip used to carry three 12px icons beside every tab - split, split,
 * close - so three open terminals meant nine icons in a row over three tabs all
 * called `bash`. Nothing in that strip told one terminal from another, which is
 * the one job a tab strip has. It now follows the two surfaces the owner named:
 *
 *  - deepseek's `StateDot`: a 10px state slot per row, colour-only and
 *    `aria-hidden`, paired with the state IN WORDS for assistive technology
 *    (the repo's own `components/ui/state-dot.tsx` is that primitive);
 *  - VS Code's tabs: the close affordance appears on HOVER and on the active
 *    tab (`multiEditorTabsControl.ts`), the strip scrolls horizontally with an
 *    overflow affordance rather than squeezing tabs to nothing, and the split
 *    and kill actions belong to the panel that describes ONE terminal, not to
 *    every row of the list.
 *
 * Hover-revealed does not mean keyboard-hidden. The close button is always in
 * the tab order and becomes visible on `:focus-visible`, so a keyboard user
 * never chases a control that only a mouse can summon.
 *
 * ## A PREVIEW file tab looks different and says so
 *
 * The workspace model holds at most one preview file tab (see `addFileTab`),
 * and this strip renders it the way VS Code does: the title in ITALICS, plus
 * the word `Preview` in the accessible name, because italics are invisible to a
 * screen reader. Its two promotion gestures are VS Code's as well - a double
 * click on the tab, and an explicit "Keep" action beside it - and both call the
 * same `onPinTab`, which is optional: with no owner for it the strip draws no
 * promotion affordance rather than a control that does nothing.
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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { TerminalShellId, TerminalShellOption } from "@shared/schemas/terminal.js";
import {
  IconClose,
  IconFile,
  IconPlus,
  IconTerminal,
} from "../../../../components/icons/index.js";
import { StateDot, type StateDotState } from "../../../../components/ui/state-dot.js";
import { Tabs, TabsList, TabsTrigger } from "../../../../components/ui/tabs.js";
import { cn } from "../../../../lib/utils.js";
import type { WorkspaceFileTab, WorkspaceState, WorkspaceTab } from "../workspace/types.js";
import { isPreviewFileTab } from "../workspace/workspace-model.js";
import { TerminalPaneGroup } from "./TerminalPaneGroup.js";
import {
  EMPTY_WORKSPACE_ACTION_COPY,
  EMPTY_WORKSPACE_COPY,
  EMPTY_WORKSPACE_WATERMARK_ROWS,
  FILE_TAB_PREVIEW_STATE_COPY,
  RENAME_FIELD_LABEL,
  RENAME_HINT_COPY,
  TERMINAL_STATE_COPY,
  closeTabLabel,
  closeTerminalTooltip,
  keepTabOpenLabel,
  keepTabOpenTooltip,
  terminalTabTooltip,
} from "./terminal-copy.js";
import { prefersReducedMotion } from "./terminal-palette.js";
import {
  terminalGroupIsLive,
  terminalGroupRunState,
  type TerminalRunFacts,
  type TerminalTabRunState,
} from "./terminal-tab-model.js";
import type { TerminalRegistry } from "./terminal-registry.js";

/** Namespaces the primitive's generated ids so a second strip cannot collide. */
export const TERMINAL_TABS_ID_SCOPE = "studio-terminal";

/** Stable identity so the default does not remount consumers on every render. */
const EMPTY_LOST: ReadonlySet<string> = new Set<string>();
const EMPTY_EXITS: ReadonlyMap<string, never> = new Map<string, never>();
const EMPTY_SHELL_LABELS: ReadonlyMap<string, string> = new Map<string, string>();

/** Nothing lost, nothing exited, no restore: the state a fresh workspace is in. */
const IDLE_FACTS: TerminalRunFacts = {
  lostTerminalIds: EMPTY_LOST,
  exits: EMPTY_EXITS,
  restoring: false,
};

/**
 * Which dot each run state paints.
 *
 * `restoring` shares the `ongoing` chase with `running` on purpose: both are
 * work in flight, and the two are told apart by the word beside the dot rather
 * than by a fifth colour nobody could name on sight. `exited` is `done` (it
 * finished, nothing went wrong) and only a failure is `error`, which keeps the
 * red dot meaning "look at this" instead of "a shell closed".
 */
const DOT_BY_STATE: Readonly<Record<TerminalTabRunState, StateDotState>> = {
  running: "ongoing",
  restoring: "ongoing",
  exited: "done",
  error: "error",
};

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
  /**
   * The user renamed a tab. Separate from the shell's own title property,
   * which no longer names the tab: a person's name for a terminal outranks
   * whatever the program in it decided to call itself.
   */
  readonly onRenameTab: (tabId: string, title: string) => void;
  /**
   * KEEP a preview tab open, promoting it to a pinned one.
   *
   * OPTIONAL, and the option is not a shrug: when no owner answers it, this
   * strip renders NO promotion affordance at all rather than a dead "Keep open"
   * button and a double click that does nothing. A caller that opens every file
   * pinned (the behaviour before previews existed, which is still every
   * caller's default) never produces a preview tab, so there is nothing for the
   * control to act on either.
   *
   * The gestures it backs are VS Code's, from `multiEditorTabsControl.ts`: a
   * double click on the tab (`:1126-1150`, which pins an unpinned editor) and
   * an explicit action. The keyboard command is the same call, made by the
   * keyboard lane's owner rather than by this component.
   */
  readonly onPinTab?: (tabId: string) => void;
  /**
   * The SHELL reported what it is running. Keyed by terminal id and NOT by tab,
   * for the same reason the directory is: a group is several shells, and a fact
   * about one of them cannot be stored on the tab that holds them all.
   */
  readonly onShellTitle: (terminalId: string, title: string) => void;
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
   * Everything a tab's state dot depends on that the workspace model does not
   * hold: the host-loss set, the exits the panes reported, and whether a
   * restore is running. Defaults to "nothing has gone wrong", so a caller that
   * tracks none of it renders every live tab as running.
   */
  readonly runFacts?: TerminalRunFacts;
  /**
   * What the host says is RUNNING in each terminal, keyed by terminal id. The
   * tab is named `Terminal n`, so this is where the shell went: the tooltip and
   * the panel header's second line.
   */
  readonly shellLabelById?: ReadonlyMap<string, string>;
  /**
   * Which shell the next terminal opens with, and the catalogue behind the
   * picker. Passed THROUGH to each terminal panel's header rather than
   * rendered here: the strip is one control for the whole workspace, and the
   * header belongs to the panel it describes.
   */
  readonly shellId: TerminalShellId;
  readonly shells: readonly TerminalShellOption[];
  readonly onSelectShell: (shellId: TerminalShellId) => void;
  /**
   * What the EMPTY workspace's watermark lists.
   *
   * The seam this component was built with: the keyboard lane owns which
   * shortcuts exist and which of them an owner actually answers, so the rows
   * arrive from the caller rather than being spelled here. Omitted, the
   * surface's own keyless default stands - the two actions the mockup draws,
   * with no key column.
   */
  readonly watermarkRows?: readonly WatermarkRow[];
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
  onRenameTab,
  onPinTab,
  onShellTitle,
  onDisplayCwdChange,
  onPaneExit,
  renderFileTab,
  notice,
  runFacts = IDLE_FACTS,
  shellLabelById = EMPTY_SHELL_LABELS,
  shellId,
  shells,
  onSelectShell,
  watermarkRows,
}: TerminalTabsProps): JSX.Element {
  const activeTabId = state.activeTabId ?? "";
  const listRef = useRef<HTMLDivElement | null>(null);
  const overflow = useStripOverflow(listRef, state.tabs.length, activeTabId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        value={activeTabId}
        onValueChange={onSelectTab}
        idScope={TERMINAL_TABS_ID_SCOPE}
        className="min-h-0 shrink-0"
      >
        {/* The fades are painted by this wrapper, not by the scroller: an
            element that scrolls cannot hold a mask that stays put. */}
        <div className="relative">
          <TabsList
            ref={listRef}
            aria-label="Studio terminals and files"
            className="h-9 w-full justify-start gap-0 overflow-x-auto rounded-none border-x-0 border-t-0 border-b border-line-3 p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {state.tabs.map((tab) => (
              <TabRow
                key={tab.tabId}
                tab={tab}
                active={tab.tabId === state.activeTabId}
                runFacts={runFacts}
                shellLabelById={shellLabelById}
                onCloseTab={onCloseTab}
                onRenameTab={onRenameTab}
                {...(onPinTab === undefined ? {} : { onPinTab })}
              />
            ))}
            <button
              type="button"
              aria-label="New terminal"
              onClick={onNewTerminal}
              className="ml-1 shrink-0 rounded-md p-1.5 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <IconPlus size={14} />
            </button>
          </TabsList>
          {/* THE OVERFLOW AFFORDANCE. Twenty file tabs used to run off the edge
              with nothing to say they had: the strip scrolled, but only a user
              who tried scrolling found out. VS Code draws the same fade at both
              ends of its tabs container. Decoration only - the scroll itself is
              the tablist's, keyboard navigation reaches every tab, and the
              active tab is scrolled into view on selection. */}
          <div
            aria-hidden="true"
            data-overflow-start={overflow.atStart ? undefined : ""}
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface-1 to-transparent",
              overflow.atStart ? "opacity-0" : "opacity-100",
            )}
          />
          <div
            aria-hidden="true"
            data-overflow-end={overflow.atEnd ? undefined : ""}
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface-1 to-transparent",
              overflow.atEnd ? "opacity-0" : "opacity-100",
            )}
          />
        </div>
      </Tabs>

      {notice}

      <div className="relative min-h-0 flex-1">
        {state.tabs.length === 0 ? (
          <EmptyWorkspace
            onNewTerminal={onNewTerminal}
            {...(watermarkRows === undefined ? {} : { watermarkRows })}
          />
        ) : null}
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
                  lostTerminalIds={runFacts.lostTerminalIds}
                  shellLabel={
                    shellLabelById.get(
                      tab.panes.find((pane) => pane.paneId === tab.activePaneId)?.terminalId
                        ?? tab.panes[0]?.terminalId
                        ?? "",
                    ) ?? null
                  }
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
                  onSplit={(orientation) => {
                    onSplit(tab.tabId, orientation);
                  }}
                  // KILL is the header's action and it is not CLOSE. On a split
                  // tab it ends the one terminal the header describes and
                  // leaves the tab open; on a single-pane tab there is no such
                  // distinction to draw, and the model refuses to remove a
                  // group's last pane, so the tab itself closes - which the
                  // close path already ends the shell for.
                  onKill={() => {
                    if (tab.panes.length > 1) onClosePane(tab.tabId, tab.activePaneId);
                    else onCloseTab(tab.tabId);
                  }}
                  onRename={(title) => {
                    onRenameTab(tab.tabId, title);
                  }}
                  onShellTitle={onShellTitle}
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
 * Whether the strip is scrolled to each end, and keeping the active tab in view.
 *
 * Measured from the DOM rather than computed from tab widths, because the
 * widths depend on the rendered text and this component does not own the font.
 * The listener is passive and the observer is disconnected with the effect;
 * both are re-established when the tab count changes, which is the only time
 * the scroller's content can change size.
 */
function useStripOverflow(
  listRef: RefObject<HTMLDivElement | null>,
  tabCount: number,
  activeTabId: string,
): { atStart: boolean; atEnd: boolean } {
  const [edges, setEdges] = useState({ atStart: true, atEnd: true });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    const measure = (): void => {
      // A 1px slack: fractional scroll offsets on a scaled display never reach
      // the exact end, and a fade that never fully clears reads as a defect.
      const atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
      setEdges({ atStart: list.scrollLeft <= 1, atEnd });
    };
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [listRef, tabCount]);

  useEffect(() => {
    const list = listRef.current;
    if (list === null || activeTabId === "") return;
    // Scanned rather than selected: a tab id is a generated string and building
    // a selector out of one needs escaping the environment may not provide.
    const tab = [...list.querySelectorAll<HTMLElement>("[data-tab-value]")].find(
      (candidate) => candidate.dataset["tabValue"] === activeTabId,
    );
    // jsdom implements neither, and a strip that cannot scroll is not a defect
    // worth throwing over.
    if (tab === undefined || typeof tab.scrollIntoView !== "function") return;
    tab.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      // The one animation this strip has, and the OS switch turns it off.
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [listRef, activeTabId]);

  return edges;
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
  watermarkRows,
}: {
  readonly onNewTerminal: () => void;
  readonly watermarkRows?: readonly WatermarkRow[];
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
      <EmptyWorkspaceWatermark
        {...(watermarkRows === undefined ? {} : { rows: watermarkRows })}
      />
    </div>
  );
}

/** One row of the watermark: an action, and the keys that reach it when there are any. */
export interface WatermarkRow {
  readonly action: string;
  readonly keys?: string;
}

/**
 * THE WATERMARK VS Code draws in an empty editor group.
 *
 * `editorGroupWatermark.ts` fills the empty surface with the commands that
 * matter and their shortcuts, which is the difference between a blank panel and
 * a panel that teaches. The `rows` prop is the seam, and it is now wired:
 * `StudioCenter` passes `studioWatermarkRows(studioPlatform, studioBoundIntents())`
 * down through the controller, so the list is exactly the shortcuts an owner
 * actually answers, spelled for this platform. The default below stands only
 * for a surface mounted without that caller - the actions the mockup draws,
 * with no key column, rather than a blank panel.
 *
 * It is `aria-hidden`: every row names an action that is already a real,
 * focusable control on this surface or in the strip above it, and announcing
 * the list would offer a screen-reader user a menu of things they cannot press.
 */
export function EmptyWorkspaceWatermark({
  rows = EMPTY_WORKSPACE_WATERMARK_ROWS,
}: {
  readonly rows?: readonly WatermarkRow[];
} = {}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <dl
      aria-hidden="true"
      data-vex-empty-watermark=""
      className="mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[11px] leading-4 text-ink-dimmed"
    >
      {rows.map((row) => (
        <div key={row.action} className="contents">
          <dt className="text-right">{row.action}</dt>
          <dd className="text-left font-mono">{row.keys ?? ""}</dd>
        </div>
      ))}
    </dl>
  );
}

function TabRow({
  tab,
  active,
  runFacts,
  shellLabelById,
  onCloseTab,
  onRenameTab,
  onPinTab,
}: {
  readonly tab: WorkspaceTab;
  readonly active: boolean;
  readonly runFacts: TerminalRunFacts;
  readonly shellLabelById: ReadonlyMap<string, string>;
  readonly onCloseTab: (tabId: string) => void;
  readonly onRenameTab: (tabId: string, title: string) => void;
  readonly onPinTab?: (tabId: string) => void;
}): JSX.Element {
  const isGroup = tab.kind === "terminalGroup";
  // PREVIEW is a property of the tab, not of this component's memory: the model
  // owns "at most one preview per workspace" and the strip only reads it.
  const preview = isPreviewFileTab(tab);
  const canPin = preview && onPinTab !== undefined;
  const [renaming, setRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const runState = isGroup ? terminalGroupRunState(tab, runFacts) : null;
  const live = isGroup && terminalGroupIsLive(tab, runFacts);
  const shellLabel = isGroup
    ? shellLabelById.get(
        tab.panes.find((pane) => pane.paneId === tab.activePaneId)?.terminalId
          ?? tab.panes[0]?.terminalId
          ?? "",
      ) ?? null
    : null;

  const endRename = useCallback((commit: string | null): void => {
    setRenaming(false);
    if (commit !== null && commit.trim() !== "") onRenameTab(tab.tabId, commit.trim());
    // FOCUS COMES BACK. The field is removed from the DOM by this state change,
    // and focus left on a removed node drops the user to the document body.
    // `queueMicrotask` runs after React has put the trigger back.
    queueMicrotask(() => {
      triggerRef.current?.focus();
    });
  }, [onRenameTab, tab.tabId]);

  if (renaming) {
    return (
      <RenameField
        initial={tab.title}
        onEnd={endRename}
      />
    );
  }

  return (
    <>
      <TabsTrigger
        ref={triggerRef}
        value={tab.tabId}
        // The hover group is the TRIGGER's, and the close button reads it
        // through `peer-hover`, because the two are siblings rather than nested
        // (a button cannot contain a button; see the module header).
        className={cn(
          "peer h-full shrink-0 gap-1.5 rounded-none border-r border-line-3 px-3",
          active ? "bg-interactive-active text-ink-primary" : null,
        )}
        title={
          runState === null
            ? tab.title
            : terminalTabTooltip(tab.title, shellLabel, runState)
        }
        // DOUBLE CLICK means two different things on the two kinds of tab, and
        // both are the surface's own convention: a terminal tab is RENAMED (the
        // inline field below), a preview file tab is KEPT. VS Code pins on
        // double click for exactly this reason - the gesture that says "I am
        // staying here" is the one that stops the tab being throwaway
        // (`multiEditorTabsControl.ts:1126-1150`).
        onDoubleClick={
          isGroup
            ? () => {
                setRenaming(true);
              }
            : canPin
              ? () => {
                  onPinTab?.(tab.tabId);
                }
              : undefined
        }
        // MIDDLE CLICK CLOSES, on every tab, as VS Code's strip does
        // (`multiEditorTabsControl.ts:1051-1066`, AUXCLICK button 1). React's
        // `onAuxClick` is the same event; the button check is what keeps a
        // right click out, since auxclick fires for that too.
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onCloseTab(tab.tabId);
        }}
      >
        {isGroup ? <IconTerminal size={12} /> : <IconFile size={12} />}
        {/* The dot is colour-only and `aria-hidden`; the word after the title
            is what a screen reader gets, and it comes AFTER so the tab's
            accessible name reads "Terminal 1 Running" rather than opening with
            a status nobody asked about yet. */}
        {runState === null ? null : <StateDot state={DOT_BY_STATE[runState]} size={8} />}
        {/* ITALIC IS THE PREVIEW SIGNAL, and it is only half of it: italics say
            nothing to a screen reader, so the state word below carries the same
            fact in the accessible name. VS Code paints the identical
            distinction (`multiEditorTabsControl.ts:1730`). */}
        <span className={cn("max-w-40 truncate", preview ? "italic" : null)}>
          {tab.title}
        </span>
        {runState === null ? null : (
          <span className="sr-only">{TERMINAL_STATE_COPY[runState]}</span>
        )}
        {preview ? <span className="sr-only">{FILE_TAB_PREVIEW_STATE_COPY}</span> : null}
      </TabsTrigger>
      {canPin ? (
        <button
          type="button"
          aria-label={keepTabOpenLabel(tab.title)}
          title={keepTabOpenTooltip(tab.title)}
          onClick={() => {
            onPinTab?.(tab.tabId);
          }}
          className={cn(
            // Same hover-revealed, never-keyboard-hidden grammar as close: it
            // stays in the layout, in the tab order and in the accessibility
            // tree, and paints on hover of either sibling, on the active tab
            // and on its own focus ring.
            "shrink-0 rounded px-1 py-0.5 text-[10px] leading-4 text-ink-tertiary transition-opacity duration-[var(--vex-duration-fast)]",
            "opacity-0 peer-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100",
            active ? "opacity-100" : null,
            "hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          Keep
        </button>
      ) : null}
      <button
        type="button"
        aria-label={closeTabLabel(tab.title)}
        title={isGroup ? closeTerminalTooltip(tab.title, live) : undefined}
        onClick={() => {
          onCloseTab(tab.tabId);
        }}
        className={cn(
          // HOVER-REVEALED, NEVER KEYBOARD-HIDDEN. `opacity-0` keeps the button
          // in the layout, in the tab order and in the accessibility tree; it
          // paints on hover of either sibling, on the active tab, and on its own
          // focus ring, so a keyboard user always sees what they are on.
          "mr-2 shrink-0 rounded p-1 text-ink-tertiary transition-opacity duration-[var(--vex-duration-fast)]",
          "opacity-0 peer-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100",
          active ? "opacity-100" : null,
          "hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        <IconClose size={12} />
      </button>
    </>
  );
}

/**
 * The inline rename field, in the tab's own place.
 *
 * VS Code renames in place too (`explorerViewer.ts`'s input box, and the
 * terminal tab's own `RenameActiveTab`), and in place is what makes the rename
 * obviously about THIS tab rather than about a dialog's idea of one. Enter
 * commits, Escape cancels, and a blur commits: leaving the field is not a
 * decision to discard what was typed, and a rename is not destructive.
 */
function RenameField({
  initial,
  onEnd,
}: {
  readonly initial: string;
  readonly onEnd: (commit: string | null) => void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      onEnd(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onEnd(null);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // The strip's roving tabindex moves on arrows. While a field is open the
      // arrows belong to the caret in it.
      event.stopPropagation();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={RENAME_FIELD_LABEL}
      title={RENAME_HINT_COPY}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        onEnd(value);
      }}
      className="mx-1 h-6 w-32 shrink-0 self-center rounded border border-line-input bg-surface-2 px-1.5 text-[13px] leading-5 text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    />
  );
}
