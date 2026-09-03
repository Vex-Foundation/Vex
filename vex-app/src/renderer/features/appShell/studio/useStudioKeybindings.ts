/**
 * THE ONE PLACE STUDIO LISTENS FOR A SHORTCUT.
 *
 * Mounted once, by `StudioCenter`, for as long as Studio is the active shell.
 * It owns exactly one `keydown` listener and its removal; it owns no rules
 * (`keybindings.ts` is the table) and no actions (each intent is dispatched
 * into the owner that already performs it, through that owner's public
 * function). Nothing here reaches into a component.
 *
 * ## Studio intercepts exactly what it advertises, and only when it acts
 *
 * An intent with no handler is NOT intercepted: the resolver matched, the hook
 * finds nothing to call, and the event is left completely alone - not
 * defaultPrevented, not stopped. The same set drives the empty-workspace
 * watermark (`studioWatermarkRows` takes the bound intents), so the shortcuts a
 * user is shown and the shortcuts Studio takes are the same list by
 * construction. That is `editorGroupWatermark.ts:212-213` filtering its rows to
 * commands that exist, made into an invariant rather than a coincidence.
 *
 * A HANDLER RETURNS WHETHER IT ACTED, and that is the second half of the same
 * invariant. Binding an intent says an owner CAN answer it; it does not say one
 * is on screen right now. `Ctrl+W` with no workspace mounted, `Ctrl+Shift+E`
 * with the rail collapsed and no tree rendered - in both the honest outcome is
 * that Studio took nothing, so the keystroke travels on. Without the return
 * value the hook would have to `preventDefault` on the strength of the binding
 * alone and would silently eat keys nothing answered.
 *
 * ## What is wired, and the one intent that has no owner
 *
 * Every intent but one reaches an owner's public function: the uiStore's own
 * actions (rail, runtime mode), the project-dialog intent publisher, the
 * explorer's `focusStudioExplorer`, the rail's `focusStudioRailSearch`, and the
 * mounted workspace's `ProjectWorkspaceCommands` (new, split, close tab, keep
 * tab open, next and previous tab), reached through
 * `workspace/workspace-handles.ts` for the same reason the close gesture is -
 * the actions live in a per-project controller and this hook is mounted once,
 * by `StudioCenter`.
 *
 * `toggleTerminal` IS DELIBERATELY UNBOUND. It names a terminal PANEL that can
 * be shown and hidden, which is VS Code's layout and not Studio's: here the
 * workspace IS the terminal surface, its tabs hold terminals and files in one
 * strip, and there is nothing for `Ctrl+\`` to fold away. Wiring it to
 * something else - focus the terminal, open one - would be inventing product
 * behaviour under a label that promises a different one, so the row stays in
 * the table (the chord is reserved and proved against the menu) and out of the
 * watermark until a panel exists to toggle.
 *
 * ## WHERE THIS IS MOUNTED decides which half of the toggle can be heard
 *
 * `StudioCenter` mounts it, and `AppShell` renders `StudioCenter` only while
 * `runtimeMode === "studio"`. So the Studio-to-Agent half of
 * `toggleStudioAgent` is reachable today and the Agent-to-Studio half is not:
 * the listener is gone by the time the user is in an Agent session. The
 * handler answers both directions - it reads the mode rather than assuming one,
 * and its suite drives both - so the return direction needs no further rule,
 * only a mount in a seat that survives the mode switch. That seat is
 * `AppShell`'s, not this module's.
 *
 * ## Bubble phase, and never over a handled event
 *
 * The listener sits on `document` in the BUBBLE phase, so a surface that
 * handled the key first (the tree's own table, a dialog, an input) wins by
 * calling `preventDefault` or `stopPropagation`, exactly as it would against
 * any other document-level listener. A capture-phase listener would take the
 * key BEFORE those owners, which is how a global shortcut ends up eating the
 * character someone was typing.
 */

import { useEffect } from "react";
import { isDialogOnScreen } from "../../../components/ui/dialog.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { focusAgentComposer } from "../composer-focus.js";
import { openProjectCreator } from "./projects/index.js";
import { focusStudioExplorer } from "./explorer/index.js";
import { focusStudioRailSearch } from "./sidebar/StudioSidebar.js";
import { TERMINAL_WRAPPER_CLASS } from "./terminal/index.js";
import {
  peekProjectWorkspaceCommands,
  type ProjectWorkspaceCommands,
} from "./workspace/workspace-handles.js";
import {
  resolveStudioKeybinding,
  type StudioIntent,
  type StudioSurface,
} from "./keybindings.js";
import { studioPlatform, type StudioPlatform } from "./keybindings-labels.js";

/**
 * What answers an intent. A missing entry means the intent is unbound.
 *
 * The return says whether the handler ACTED. See the module note: an owner that
 * is bound but not on screen answers `false`, and the keystroke travels on.
 */
export type StudioKeybindingHandlers = Partial<Record<StudioIntent, () => boolean>>;

/**
 * The commands of the workspace the user is LOOKING AT, or null.
 *
 * The active project is the uiStore's fact and the commands are the mounted
 * controller's; joining them here rather than inside the registry keeps the
 * workspace module free of the shell's selection state. A hidden kept-alive
 * workspace publishes its commands too, and must never answer: a `Ctrl+W` in
 * one project may not close a tab in another.
 */
function activeWorkspaceCommands(): ProjectWorkspaceCommands | null {
  const projectId = useUiStore.getState().activeProjectId;
  return projectId === null ? null : peekProjectWorkspaceCommands(projectId);
}

/** Run one workspace command, or report that no workspace answered. */
function onActiveWorkspace(
  run: (commands: ProjectWorkspaceCommands) => boolean,
): boolean {
  const commands = activeWorkspaceCommands();
  return commands === null ? false : run(commands);
}

/**
 * The intents' owners, and how each is reached.
 *
 * Module-level constants rather than a hook-built object: each resolves its
 * owner at DISPATCH time - `getState()` for the store, a registry peek for the
 * workspace - so none of them closes over a stale value and the map's identity
 * never changes.
 */
const DEFAULT_HANDLERS: StudioKeybindingHandlers = {
  newTerminal: () => onActiveWorkspace((commands) => commands.newTerminal()),
  splitTerminal: () => onActiveWorkspace((commands) => commands.splitActiveTerminal()),
  focusExplorer: focusStudioExplorer,
  goToFile: focusStudioRailSearch,
  toggleRail: () => {
    const store = useUiStore.getState();
    store.setSidebarOpen(!store.sidebarOpen);
    return true;
  },
  closeTab: () => onActiveWorkspace((commands) => commands.closeActiveTab()),
  keepTabOpen: () => onActiveWorkspace((commands) => commands.pinActiveTab()),
  nextTab: () => onActiveWorkspace((commands) => commands.selectTabAtOffset(1)),
  previousTab: () => onActiveWorkspace((commands) => commands.selectTabAtOffset(-1)),
  toggleStudioAgent: () => {
    const store = useUiStore.getState();
    if (store.runtimeMode === "studio") {
      store.setRuntimeMode("agent");
      // AND FOCUS LANDS. The chord removes the whole Studio column, so without
      // this the user who pressed it arrives in the Agent shell with focus on
      // `document.body` - measured on the built app. The composer is not
      // mounted yet at this instant; the seam latches the request and the
      // composer consumes it when it mounts. See `focusAgentComposer`.
      focusAgentComposer();
      return true;
    }
    // THE RETURN DIRECTION. Nothing is focused for it here: the Studio column
    // is not mounted yet at this instant, and every Studio surface that lands
    // focus after a mount does it under `studioFocusPermission` - the workspace
    // through its armed landing, the welcome through `focusStudioWelcome` -
    // which is the owner of that question and needs no help from a keystroke.
    store.setRuntimeMode("studio");
    return true;
  },
  newProject: () => {
    openProjectCreator();
    return true;
  },
};

/** The intents a handler map answers. The watermark shows exactly these. */
export function studioBoundIntents(
  handlers: StudioKeybindingHandlers = DEFAULT_HANDLERS,
): ReadonlySet<StudioIntent> {
  const bound = new Set<StudioIntent>();
  for (const [intent, handler] of Object.entries(handlers)) {
    if (handler !== undefined) bound.add(intent as StudioIntent);
  }
  return bound;
}

/**
 * Which Studio surface an element sits in.
 *
 * Innermost first: a terminal and a viewer both live INSIDE a workspace, and a
 * workspace answer for a focused terminal would apply the wrong `when`. Each
 * selector names a marker its own owner already renders - the terminal
 * registry's wrapper class, the viewer's surface attribute, the sidebar's area
 * name, the centre's per-project attribute - so this reads other features'
 * public markers and never their internals.
 */
export function studioSurfaceOf(element: Element | null): StudioSurface {
  if (element === null) return "none";
  if (element.closest(`.${TERMINAL_WRAPPER_CLASS}`) !== null) return "terminal";
  if (element.closest('[data-vex-key-surface="viewer"]') !== null) return "viewer";
  if (element.closest('[data-vex-area="studio-sidebar"]') !== null) return "rail";
  if (element.closest("[data-vex-studio-workspace]") !== null) return "workspace";
  return "none";
}

/**
 * Bind the Studio keyboard table for as long as this component is mounted.
 *
 * @param handlers - overrides merged over the wired defaults. Production passes
 * nothing; a test passes fakes to observe the dispatch. IDENTITY-STABLE: it is
 * an effect dependency, so a fresh object literal per render rebinds the
 * listener on every commit.
 * @param platform - the platform whose modifier applies. Defaults to this
 * window's; a test states it so all three are provable.
 */
export function useStudioKeybindings(
  handlers?: StudioKeybindingHandlers,
  platform: StudioPlatform = studioPlatform,
): void {
  useEffect(() => {
    const resolved: StudioKeybindingHandlers = { ...DEFAULT_HANDLERS, ...handlers };
    const onKeyDown = (event: KeyboardEvent): void => {
      // Someone nearer the key already dealt with it.
      if (event.defaultPrevented) return;
      const intent = resolveStudioKeybinding(event, {
        surface: studioSurfaceOf(document.activeElement),
        dialogOpen: isDialogOnScreen(document),
        platform,
      });
      if (intent === null) return;
      const handler = resolved[intent];
      // Unbound: leave the event completely alone. See the module note.
      if (handler === undefined) return;
      // Bound, but its owner may not be on screen. Only a handler that ACTED
      // earns the interception; one that declined leaves the key exactly as an
      // unbound one does.
      if (!handler()) return;
      // Taken: the browser's own meaning for this chord (Ctrl+P prints, Ctrl+B
      // bolds in a contenteditable) must not also happen.
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [handlers, platform]);
}
