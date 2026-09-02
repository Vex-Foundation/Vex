/**
 * THE ONE PLACE STUDIO LISTENS FOR A SHORTCUT.
 *
 * Mounted once, by `StudioCenter`, for as long as Studio is the active shell.
 * It owns exactly one `keydown` listener and its removal; it owns no rules
 * (`keybindings.ts` is the table) and no actions (each intent is dispatched
 * into the owner that already performs it, through that owner's public
 * function). Nothing here reaches into a component.
 *
 * ## Studio intercepts exactly what it advertises
 *
 * An intent with no handler is NOT intercepted: the resolver matched, the hook
 * finds nothing to call, and the event is left completely alone - not
 * defaultPrevented, not stopped. The same set drives the empty-workspace
 * watermark (`studioWatermarkRows` takes the bound intents), so the shortcuts a
 * user is shown and the shortcuts Studio takes are the same list by
 * construction. That is `editorGroupWatermark.ts:212-213` filtering its rows to
 * commands that exist, made into an invariant rather than a coincidence.
 *
 * ## What is wired today, and what waits on its owner
 *
 * Three intents have a reachable public owner and are bound here: the rail
 * toggle and the runtime mode (the uiStore's own actions) and the project
 * creator (`openProjectCreator`, the intent publisher the sidebar and the
 * centre already share). The rest name owners that do not expose a public
 * command yet - the workspace controller's terminal actions, the explorer's
 * focus, the rail's search - and are deliberately left unbound rather than
 * reached for through the DOM. When an owner publishes its function, that
 * intent is one entry in the map below and the watermark grows a row with no
 * other change.
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
import { useUiStore } from "../../../stores/uiStore.js";
import { openProjectCreator } from "./projects/index.js";
import { TERMINAL_WRAPPER_CLASS } from "./terminal/index.js";
import {
  resolveStudioKeybinding,
  type StudioIntent,
  type StudioSurface,
} from "./keybindings.js";
import { studioPlatform, type StudioPlatform } from "./keybindings-labels.js";

/** What answers an intent. A missing entry means the intent is unbound. */
export type StudioKeybindingHandlers = Partial<Record<StudioIntent, () => void>>;

/**
 * The intents whose owners are reachable today, and how.
 *
 * Module-level constants rather than a hook-built object: each reads the store
 * at DISPATCH time through `getState()`, so none of them closes over a stale
 * value and the map's identity never changes.
 */
const DEFAULT_HANDLERS: StudioKeybindingHandlers = {
  toggleRail: () => {
    const store = useUiStore.getState();
    store.setSidebarOpen(!store.sidebarOpen);
  },
  agentMode: () => {
    useUiStore.getState().setRuntimeMode("agent");
  },
  newProject: openProjectCreator,
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
 * Whether a modal dialog is on screen.
 *
 * `dialog[open]` is the state the native element itself reports, which is the
 * only honest source: Studio's dialogs are native `<dialog>` elements opened
 * with `showModal()`, and a React flag would be a second copy of a fact the DOM
 * already holds.
 */
function anyDialogOpen(doc: Document): boolean {
  return doc.querySelector("dialog[open]") !== null;
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
        dialogOpen: anyDialogOpen(document),
        platform,
      });
      if (intent === null) return;
      const handler = resolved[intent];
      // Unbound: leave the event completely alone. See the module note.
      if (handler === undefined) return;
      // Bound: the browser's own meaning for this chord (Ctrl+P prints,
      // Ctrl+B bolds in a contenteditable) must not also happen.
      event.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [handlers, platform]);
}
