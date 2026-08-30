/**
 * StudioWorkspaceController - the React owner of one project's workspace.
 *
 * The division of labour here is the whole design, so it is worth stating
 * plainly. This component owns EFFECTS: the bridge calls, the debounce timer,
 * the restore on mount, the cleanup on unmount. It owns no RULES. Every
 * transition - what becomes active after a close, whether a new group is allowed,
 * how a split redistributes shares, how a stale selection is repaired - is a
 * call into `workspace/workspace-model.ts`, which is pure and table-tested.
 *
 * When a mutation is refused, the refusal is rendered BY NAME. `keep_alive_limit`
 * in particular is a refusal, never an eviction: Vex does not close a running
 * shell to make room for a new one, and a UI that silently did would destroy work
 * the user never asked to lose. Same doctrine as the host's own per-project and
 * global terminal bounds, applied one layer up.
 *
 * ## Restore, and why persistence is latched behind it
 *
 * On mount the controller reads the project's snapshot and rebuilds the state
 * through `fromSnapshot`, which preserves the persisted pane SHARES. Persistence
 * is debounced and does not start until that read has settled: an empty
 * workspace persisted in the frame before the restore landed would overwrite the
 * snapshot it was about to restore from.
 *
 * The reattach itself needs no code here. Each `XtermHost` attaches its own
 * terminal on mount and the host answers with a resync plus a replay, so a
 * reload restores the layout (this component) and the buffers (the hosts)
 * through two independent paths that cannot half-succeed into a broken screen.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { TerminalErrorCode } from "@shared/schemas/terminal.js";
import { cn } from "../../../../lib/utils.js";
import {
  createTerminal,
  killTerminal,
  persistTerminalWorkspace,
  readTerminalWorkspace,
} from "../../../../lib/api/terminal.js";
import {
  addPane,
  addTerminalGroup,
  closePane,
  closeTab,
  collectCleanups,
  emptyWorkspace,
  fromSnapshot,
  resizePanes,
  selectTab,
  setActivePane,
  setGroupOrientation,
  setTabTitle,
  toPersistedLayout,
} from "../workspace/workspace-model.js";
import type { WorkspaceMutation, WorkspaceState } from "../workspace/types.js";
import { TerminalTabs } from "./TerminalTabs.js";
import type { TerminalRegistry } from "./terminal-registry.js";

/**
 * How long a burst of layout changes coalesces before it is written.
 *
 * A splitter drag emits a mutation per pointer move; writing each one would put
 * a file write on the pointer path. Long enough to swallow a drag, short enough
 * that a crash loses at most this much layout - and the visibility handler below
 * flushes anyway, which is the case that actually matters.
 */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * The geometry a terminal is CREATED with, before anything has been measured.
 *
 * 80x24 is the universal terminal default, and it is correct here for a reason
 * beyond convention: the pane's real size is unknown until it has layout, and
 * `XtermHost` refits and re-sends the true size on its first frame. Guessing a
 * larger size would make the shell paint one frame at a geometry that never
 * existed.
 */
const CREATE_COLS = 80;
const CREATE_ROWS = 24;

/** Why nothing happened, in words the person reading it can act on. */
const REFUSAL_COPY: Partial<Record<TerminalErrorCode, string>> = {
  limit_project_terminals:
    "This project already has the maximum number of terminals. Close one to open another.",
  limit_global_terminals:
    "Vex has the maximum number of terminals open. Close one to open another.",
  host_unavailable:
    "The terminal service is not running and could not be restarted. Restart Vex to try again.",
  project_deleting: "This project is being deleted, so no new terminal can open.",
  create_timeout: "The terminal service did not answer in time. Try again.",
  snapshot_unavailable: "Vex could not read this project's saved terminal layout.",
};

const KEEP_ALIVE_COPY =
  "This project already has the maximum number of live terminal tabs. Close one to open another - Vex never closes a running shell for you.";

export interface StudioWorkspaceControllerProps {
  readonly projectId: string;
  readonly registry?: TerminalRegistry;
  readonly className?: string;
}

export function StudioWorkspaceController({
  projectId,
  registry,
  className,
}: StudioWorkspaceControllerProps): JSX.Element {
  const [state, setState] = useState<WorkspaceState>(() => emptyWorkspace(projectId));
  const [notice, setNotice] = useState<string | null>(null);

  // The latest state, for handlers that must run at teardown - where the state
  // captured by a closure is whatever it was when the effect was created.
  const stateRef = useRef(state);
  stateRef.current = state;
  const hydratedRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Apply a model mutation. The ONE place a refusal becomes visible, so no
   * caller can drop one on the floor by forgetting to check `ok`.
   */
  const apply = useCallback((mutate: (current: WorkspaceState) => WorkspaceMutation): void => {
    // Applied against the REF, not through a functional updater: the updater
    // would have to raise the refusal notice, and a state updater that fires a
    // side effect runs twice under StrictMode. Writing the ref forward also lets
    // two `apply` calls in one tick compose, which a split (orientation, then
    // pane) relies on.
    const result = mutate(stateRef.current);
    if (!result.ok) {
      setNotice(
        result.reason === "keep_alive_limit"
          ? KEEP_ALIVE_COPY
          : `That could not be done: ${result.reason}.`,
      );
      return;
    }
    stateRef.current = result.state;
    setState(result.state);
  }, []);

  const flushPersist = useCallback((): void => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!hydratedRef.current) return;
    void persistTerminalWorkspace(toPersistedLayout(stateRef.current));
  }, []);

  /* ---------------- restore ---------------- */

  useEffect(() => {
    let current = true;
    hydratedRef.current = false;
    // The ref is written alongside every setState so a teardown or a mutation
    // that lands before the next render still sees the current workspace.
    stateRef.current = emptyWorkspace(projectId);
    setState(stateRef.current);

    void (async () => {
      const result = await readTerminalWorkspace(projectId);
      // A read that landed after the project changed describes a workspace
      // nobody is looking at any more, and applying it would show the previous
      // project's terminals under the new project's name.
      if (!current) return;
      if (result.ok && result.data.ok && result.data.value !== null) {
        stateRef.current = fromSnapshot(result.data.value);
        setState(stateRef.current);
      }
      hydratedRef.current = true;
    })();

    return () => {
      current = false;
    };
  }, [projectId]);

  /* ---------------- persistence ---------------- */

  useEffect(() => {
    if (!hydratedRef.current) return undefined;
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      void persistTerminalWorkspace(toPersistedLayout(stateRef.current));
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [state]);

  useEffect(() => {
    const onVisibility = (): void => {
      // HIDDEN is the last moment the renderer is reliably alive: a window close
      // or a machine sleep may not give us another one, and the debounce window
      // is exactly the layout a user would lose.
      if (document.visibilityState === "hidden") flushPersist();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushPersist]);

  /* ---------------- teardown ---------------- */

  useEffect(() => {
    return () => {
      // The LAYOUT is this component's to save; the ATTACHMENTS are not.
      //
      // The obvious teardown - walk `collectCleanups(tabs, "unmounting")` and
      // detach each terminal - is wrong here, and the suite caught it doing
      // exactly one detach too many per terminal. When this controller unmounts,
      // React unmounts every `XtermHost` with it, and each host detaches the one
      // attachment it owns. Detaching again from here would give a single handle
      // two owners, which is how a cleanup ends up racing itself the moment the
      // two paths stop agreeing. The intent the model names as "unmounting" is
      // still what happens - the shells survive their grace period and replay on
      // return - it is just performed by the owner of each attachment.
      flushPersist();
    };
  }, [flushPersist]);

  /* ---------------- actions ---------------- */

  const openTerminal = useCallback(
    async (
      into: { readonly kind: "tab" } | { readonly kind: "pane"; readonly tabId: string },
    ): Promise<void> => {
      const result = await createTerminal({
        projectId,
        cols: CREATE_COLS,
        rows: CREATE_ROWS,
      });
      if (!result.ok) {
        setNotice("Vex could not reach the terminal service.");
        return;
      }
      if (!result.data.ok) {
        setNotice(
          REFUSAL_COPY[result.data.code] ??
            `The terminal service refused: ${result.data.code}.`,
        );
        return;
      }
      const { terminalId, shellName } = result.data.value;
      setNotice(null);

      const paneId = newId("pane");
      if (into.kind === "tab") {
        apply((current) =>
          addTerminalGroup(current, {
            kind: "terminalGroup",
            tabId: newId("group"),
            title: shellName,
            orientation: "horizontal",
            panes: [{ paneId, terminalId, relativeSize: 1 }],
            activePaneId: paneId,
          }),
        );
        return;
      }

      apply((current) =>
        addPane(current, into.tabId, {
          paneId,
          terminalId,
          // IGNORED by the model, which decides the share itself: the caller
          // cannot know the group's current proportions.
          relativeSize: 0,
        }),
      );
    },
    [apply, projectId],
  );

  const handleNewTerminal = useCallback((): void => {
    void openTerminal({ kind: "tab" });
  }, [openTerminal]);

  const handleSplit = useCallback(
    (tabId: string, orientation: "horizontal" | "vertical"): void => {
      apply((current) => setGroupOrientation(current, tabId, orientation));
      void openTerminal({ kind: "pane", tabId });
    },
    [apply, openTerminal],
  );

  const handleCloseTab = useCallback(
    (tabId: string): void => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.tabId === tabId);
      if (tab !== undefined) {
        // CLOSING: the user closed this tab, so its ptys are killed rather than
        // left running for a grace period nobody will come back through.
        const plan = collectCleanups([tab], "closing");
        for (const terminalId of plan.killTerminalIds) void killTerminal(terminalId);
      }
      apply((current) => closeTab(current, tabId));
    },
    [apply],
  );

  const handleClosePane = useCallback(
    (tabId: string, paneId: string): void => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.kind === "terminalGroup") {
        const pane = tab.panes.find((candidate) => candidate.paneId === paneId);
        if (pane !== undefined) void killTerminal(pane.terminalId);
      }
      apply((current) => closePane(current, tabId, paneId));
    },
    [apply],
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface-base", className)}>
      <TerminalTabs
        state={state}
        {...(registry === undefined ? {} : { registry })}
        onSelectTab={(tabId) => {
          apply((current) => selectTab(current, tabId));
        }}
        onCloseTab={handleCloseTab}
        onNewTerminal={handleNewTerminal}
        onSplit={handleSplit}
        onResizePanes={(tabId, sizes) => {
          apply((current) => resizePanes(current, tabId, sizes));
        }}
        onActivatePane={(tabId, paneId) => {
          apply((current) => setActivePane(current, tabId, paneId));
        }}
        onClosePane={handleClosePane}
        onTitleChange={(tabId, title) => {
          apply((current) => setTabTitle(current, tabId, title));
        }}
        onPaneExit={() => {
          // An exited pty leaves its pane and its scrollback in place: the exit
          // code is what the user came back to read, and closing the pane for
          // them would take it away. `XtermHost` renders the exit line.
        }}
        notice={
          notice === null ? null : (
            <div
              role="status"
              className="flex shrink-0 items-start gap-2 border-b border-line-3 bg-warning-wash px-3 py-2 text-[12px] leading-4 text-ink-primary"
            >
              <span className="flex-1">{notice}</span>
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                }}
                className="rounded px-1 text-ink-tertiary hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Dismiss
              </button>
            </div>
          )
        }
      />
    </div>
  );
}

let idCounter = 0;

/**
 * A workspace-local id.
 *
 * `crypto.randomUUID` where it exists, a counter otherwise. These ids are
 * PERSISTED as group ids, so they must be stable for the life of a workspace,
 * but they never leave the renderer and name nothing outside it - so uniqueness
 * within this window is the whole requirement.
 */
function newId(prefix: string): string {
  idCounter += 1;
  const unique =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${String(Date.now())}-${String(idCounter)}`;
  return `${prefix}-${unique}`;
}
