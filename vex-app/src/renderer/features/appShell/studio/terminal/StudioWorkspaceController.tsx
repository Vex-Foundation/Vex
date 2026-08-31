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
import type { FileNode } from "@shared/schemas/files.js";
import type { TerminalErrorCode } from "@shared/schemas/terminal.js";
import { cn } from "../../../../lib/utils.js";
import {
  createTerminal,
  killTerminal,
  onTerminalsLost,
  persistTerminalWorkspace,
  readTerminalWorkspace,
} from "../../../../lib/api/terminal.js";
import {
  addFileTab,
  addPane,
  addTerminalGroup,
  canAddTerminalGroup,
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
import { useFileOpenIntentStore } from "../workspace/file-open-intent.js";
import { publishProjectTerminals } from "../workspace/project-terminals.js";
import { STUDIO_FILE_TABS_MAX } from "../workspace/types.js";
import type {
  WorkspaceMutation,
  WorkspaceRefusalReason,
  WorkspaceState,
} from "../workspace/types.js";
import { TerminalTabs } from "./TerminalTabs.js";
import { FileViewer } from "../viewer/index.js";
import { terminalRegistry, type TerminalRegistry } from "./terminal-registry.js";

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

/**
 * What a refused mutation SAYS, per reason.
 *
 * A lookup rather than a chain of ternaries because `WorkspaceMutation` gained
 * a second bound in B4b and the two read identically in code while meaning
 * different things to a user. Every member of the union has an entry, so a
 * refusal can never fall through to a reason code printed at the user.
 */
const MUTATION_REFUSAL_COPY: Readonly<Record<WorkspaceRefusalReason, string>> = {
  keep_alive_limit: KEEP_ALIVE_COPY,
  file_tab_limit:
    `This project already has ${String(STUDIO_FILE_TABS_MAX)} files open. Close one to open another; Vex never closes a tab for you.`,
  unknown_tab: "That tab is no longer open.",
  unknown_pane: "That pane is no longer open.",
  last_pane:
    "That is the last pane in this tab. Close the tab itself to close it.",
};

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
  /**
   * Terminals that died with an unexpectedly terminated pty host.
   *
   * Their panes are marked dead rather than removed: the snapshot on disk still
   * holds their scrollback, so the honest offer is a revive, and silently
   * emptying the workspace would take a recoverable state away from the user
   * before they were told it existed.
   */
  const [lostTerminalIds, setLostTerminalIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [restoring, setRestoring] = useState(false);
  // The registry a closed tab's terminals are DISPOSED through. The prop exists
  // so a test can supply its own; the shared one is the window's.
  const activeRegistry = registry ?? terminalRegistry;

  // The latest state, for handlers that must run at teardown - where the state
  // captured by a closure is whatever it was when the effect was created.
  const stateRef = useRef(state);
  stateRef.current = state;
  const hydratedRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * THE WORKSPACE GENERATION. Bumped whenever the workspace this controller is
   * showing is replaced - a project switch, a remount, a StrictMode
   * double-effect.
   *
   * Every async open and every restore captures it and rechecks it at
   * publication. Without it a create issued for project A could land after the
   * user moved to project B and insert A's terminal into B's layout, and a slow
   * restore could overwrite terminals opened after it started.
   */
  const generationRef = useRef(0);

  /**
   * The project this controller is CURRENTLY showing.
   *
   * Read by the stale-restore compensation, which needs to distinguish two very
   * different reasons a restore can be stale. See the restore effect.
   */
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  /**
   * Opens that have been admitted but whose pty does not exist yet.
   *
   * Counted so the keep-alive bound is decided against the world INCLUDING
   * them: four groups plus two in-flight opens is six, and the model must
   * refuse the second of those two rather than admit both against a count of
   * four.
   */
  const pendingOpensRef = useRef(0);

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
      setNotice(MUTATION_REFUSAL_COPY[result.reason]);
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
    generationRef.current += 1;
    const generation = generationRef.current;
    hydratedRef.current = false;
    // The ref is written alongside every setState so a teardown or a mutation
    // that lands before the next render still sees the current workspace.
    stateRef.current = emptyWorkspace(projectId);
    setState(stateRef.current);

    const opened = projectId;
    setLostTerminalIds(new Set());

    void (async () => {
      const result = await readTerminalWorkspace(opened);
      // A restore that landed after the workspace was replaced describes one
      // nobody is looking at any more. Applying it would show the previous
      // project's terminals under the new project's name - and, because the
      // open REVIVES rather than only reads, would also overwrite whatever the
      // user has opened since with a layout built before any of it existed.
      //
      // ## Discarding it is not enough, and the two stale cases differ
      //
      // The claim that used to stand here - that the discarded terminals were
      // "reachable through the project's next open" - was false: the next open
      // revived ANOTHER set from the same snapshot, so every discard leaked a
      // full workspace of running shells no pane referenced.
      //
      // Main now owns that: an open is single-flight and idempotent per window
      // and project, so a StrictMode double restore JOINS one revive and both
      // continuations name the SAME live terminals. That is precisely why this
      // compensation must ask WHICH KIND of stale it is:
      //
      //  - SAME PROJECT (a remount, StrictMode, a double effect): the newer
      //    mount holds these exact ids. Killing them here would kill the live
      //    workspace the user is looking at.
      //  - DIFFERENT PROJECT (the user switched while this was in flight):
      //    nothing in this window will ever reference them. They are ours to
      //    end, and leaving them is what "an invisible running shell" means.
      if (generation !== generationRef.current) {
        if (
          opened !== projectIdRef.current
          && result.ok
          && result.data.ok
          && result.data.value !== null
        ) {
          for (const entry of result.data.value.terminals) {
            void killTerminal(entry.terminalId);
          }
        }
        return;
      }
      if (result.ok && result.data.ok && result.data.value !== null) {
        stateRef.current = fromSnapshot(result.data.value);
        setState(stateRef.current);
      }
      hydratedRef.current = true;
    })();

    return () => {
      // Invalidate on the way out as well as on the way in, so an unmount -
      // including StrictMode's - cancels the restore rather than letting it
      // publish into a controller that is gone.
      generationRef.current += 1;
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

  /**
   * Mirror this project's terminal ids into the project index.
   *
   * The Studio centre needs them at exactly one moment: the user closing this
   * kept-alive workspace, which happens WHILE this component is still mounted
   * and which the teardown below deliberately does not handle. See
   * `workspace/project-terminals.ts` for why the index exists at all.
   */
  useEffect(() => {
    const terminalIds: string[] = [];
    for (const tab of state.tabs) {
      if (tab.kind !== "terminalGroup") continue;
      for (const pane of tab.panes) terminalIds.push(pane.terminalId);
    }
    publishProjectTerminals(projectId, terminalIds);
  }, [projectId, state]);

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

  /* ---------------- host loss ---------------- */

  /**
   * The pty host died and took every shell with it.
   *
   * Nothing consumed this signal before, and the result was a workspace that
   * went on drawing live tabs over dead processes and accepting keystrokes into
   * them - permanently, because the per-terminal `exit` that would have said
   * otherwise died with the port that carried it.
   *
   * Only the ids this workspace actually shows are recorded, so a crash that
   * cost another project's terminals does not put a banner over this one.
   */
  useEffect(() => {
    return onTerminalsLost((terminalIds) => {
      const mine = new Set<string>();
      for (const tab of stateRef.current.tabs) {
        if (tab.kind !== "terminalGroup") continue;
        for (const pane of tab.panes) {
          if (terminalIds.includes(pane.terminalId)) mine.add(pane.terminalId);
        }
      }
      if (mine.size === 0) return;
      setLostTerminalIds((current) => new Set([...current, ...mine]));
    });
  }, []);

  /**
   * Revive the workspace from the last snapshot, after a host loss.
   *
   * Goes through the SAME open every mount uses, so it inherits main's
   * single-flight and its host-generation fence: the remembered open from
   * before the crash is invalid by construction, and this produces exactly one
   * fresh set of ptys rather than racing the mount effect into two.
   */
  const handleRestoreLost = useCallback((): void => {
    if (restoring) return;
    setRestoring(true);
    const generation = generationRef.current;
    const opened = projectIdRef.current;
    void (async () => {
      try {
        const result = await readTerminalWorkspace(opened);
        if (generation !== generationRef.current) return;
        if (!result.ok || !result.data.ok) {
          setNotice("Vex could not restore this project's terminals. Try again.");
          return;
        }
        if (result.data.value === null) {
          setNotice("There is no saved terminal workspace left to restore.");
          stateRef.current = emptyWorkspace(opened);
          setState(stateRef.current);
          setLostTerminalIds(new Set());
          return;
        }
        stateRef.current = fromSnapshot(result.data.value);
        setState(stateRef.current);
        setLostTerminalIds(new Set());
        setNotice(null);
      } finally {
        setRestoring(false);
      }
    })();
  }, [restoring]);

  /* ---------------- actions ---------------- */

  /**
   * Open a terminal. ADMISSIBILITY FIRST, THEN THE PTY.
   *
   * ## The order is the fix
   *
   * This used to create the pty and then ask the model whether it could be
   * placed. Every way that question could be answered "no" produced an
   * INVISIBLE RUNNING SHELL: a refused fifth group, a split into a tab the user
   * closed while the create was in flight, a create that landed after the user
   * switched projects. The terminal existed, held a slot against the host's
   * bounds and a lease against its project, and no pane referenced it - so
   * nothing could ever close it.
   *
   * So the model decides first. A refusal now costs a notice and nothing else.
   *
   * ## The publication fence
   *
   * Admissibility is decided before an await and acted on after one, so it must
   * be RECHECKED at publication - and the recheck has to cover more than the
   * count. The generation covers "is this still the same workspace" (a project
   * switch, a remount); the tab lookup covers "does the destination still
   * exist" (the user closed it mid-split).
   *
   * A stale completion KILLS ITS OWN PTY. It is the only holder of that id -
   * nothing else ever saw it - so discarding without killing is precisely how
   * the invisible shell was created.
   */
  const openTerminal = useCallback(
    async (
      into: { readonly kind: "tab" } | { readonly kind: "pane"; readonly tabId: string },
    ): Promise<void> => {
      const generation = generationRef.current;

      // ---- admissibility, before anything exists ----
      if (into.kind === "tab") {
        if (!canAddTerminalGroup(stateRef.current, pendingOpensRef.current)) {
          setNotice(KEEP_ALIVE_COPY);
          return;
        }
      } else if (
        stateRef.current.tabs.find((tab) => tab.tabId === into.tabId) === undefined
      ) {
        // Splitting a tab that is not there is not a refusal to report; it is a
        // gesture whose target has gone.
        return;
      }

      pendingOpensRef.current += 1;
      let result;
      try {
        result = await createTerminal({
          projectId,
          cols: CREATE_COLS,
          rows: CREATE_ROWS,
        });
      } finally {
        pendingOpensRef.current -= 1;
      }

      if (!result.ok) {
        if (generation === generationRef.current) {
          setNotice("Vex could not reach the terminal service.");
        }
        return;
      }
      if (!result.data.ok) {
        if (generation === generationRef.current) {
          setNotice(
            REFUSAL_COPY[result.data.code] ??
              `The terminal service refused: ${result.data.code}.`,
          );
        }
        return;
      }
      const { terminalId, shellName } = result.data.value;

      // ---- the fence ----
      const stale =
        generation !== generationRef.current
        || (into.kind === "pane"
          && stateRef.current.tabs.find((tab) => tab.tabId === into.tabId) === undefined);
      if (stale) {
        // Nothing references this terminal and nothing ever will. It is ours to
        // end, and leaving it is what "an invisible running shell" means.
        void killTerminal(terminalId);
        return;
      }

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

  /* ---------------- opening a file ---------------- */

  /**
   * Put a file in the strip.
   *
   * The TITLE is `node.name`, which main already minted as the entry's own
   * name - deriving a basename here would be a second, weaker answer to a
   * question the wire has already answered. The TOKEN travels with the tab
   * because it, not the path, is what reads the file; see `WorkspaceFileTab`.
   *
   * No admissibility question to ask first, unlike `openTerminal`: a file tab
   * holds no pty, no lease and no host slot, so `addFileTab` cannot refuse and
   * there is no invisible resource a late completion could strand.
   */
  const openFile = useCallback(
    (node: FileNode): void => {
      apply((current) =>
        addFileTab(current, {
          kind: "file",
          tabId: newId("file"),
          title: node.name,
          relativePath: node.path,
          nodeId: node.nodeId,
          dirty: false,
        }),
      );
    },
    [apply],
  );

  /**
   * Take whatever the explorer parked for THIS project.
   *
   * Consume-once and project-keyed, so StrictMode's second effect pass finds an
   * empty slot and a file chosen just before a project switch is dropped rather
   * than opened in the wrong workspace. See `workspace/file-open-intent.ts`.
   */
  const parkedFileOpen = useFileOpenIntentStore((store) => store.intent);
  useEffect(() => {
    if (parkedFileOpen === null) return;
    const taken = useFileOpenIntentStore
      .getState()
      .consumeFileOpenIntent(parkedFileOpen.intentId, projectId);
    if (taken === null) return;
    openFile(taken.node);
  }, [openFile, parkedFileOpen, projectId]);

  const handleSplit = useCallback(
    (tabId: string, orientation: "horizontal" | "vertical"): void => {
      apply((current) => setGroupOrientation(current, tabId, orientation));
      void openTerminal({ kind: "pane", tabId });
    },
    [apply, openTerminal],
  );

  /**
   * End a terminal for good: kill the pty AND destroy the xterm.
   *
   * BOTH HALVES, and the second is the one that was missing. The registry keeps
   * terminals outside React on purpose - `release` never disposes, so a
   * StrictMode remount or a tab switch cannot destroy a live shell - which
   * means a closed tab's xterm instance, its scrollback, its theme observer,
   * its DOM wrapper and its WebGL context were retained for the life of the
   * window, by a registry no surviving component could name. `dispose` is the
   * explicit verb for exactly this caller: the user closed it.
   */
  const endTerminal = useCallback(
    (terminalId: string): void => {
      void killTerminal(terminalId);
      activeRegistry.dispose(terminalId);
    },
    [activeRegistry],
  );

  const handleCloseTab = useCallback(
    (tabId: string): void => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.tabId === tabId);
      if (tab !== undefined) {
        // CLOSING: the user closed this tab, so its ptys are killed rather than
        // left running for a grace period nobody will come back through.
        const plan = collectCleanups([tab], "closing");
        for (const terminalId of plan.killTerminalIds) endTerminal(terminalId);
      }
      apply((current) => closeTab(current, tabId));
    },
    [apply, endTerminal],
  );

  const handleClosePane = useCallback(
    (tabId: string, paneId: string): void => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.kind === "terminalGroup") {
        const pane = tab.panes.find((candidate) => candidate.paneId === paneId);
        // Only when the model will actually remove it: `closePane` refuses the
        // last pane of a group, and killing a terminal whose pane survives the
        // refusal would leave the pane rendering a shell that no longer exists.
        if (pane !== undefined && tab.panes.length > 1) endTerminal(pane.terminalId);
      }
      apply((current) => closePane(current, tabId, paneId));
    },
    [apply, endTerminal],
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface-base", className)}>
      <TerminalTabs
        state={state}
        lostTerminalIds={lostTerminalIds}
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
        renderFileTab={(tab, isActive) => (
          // The viewer needs the project, and `TerminalTabs` does not have one.
          // A render prop keeps the tab strip ignorant of the files domain
          // rather than threading `projectId` into a terminal component.
          <FileViewer projectId={projectId} tab={tab} active={isActive} />
        )}
        onPaneExit={() => {
          // An exited pty leaves its pane and its scrollback in place: the exit
          // code is what the user came back to read, and closing the pane for
          // them would take it away. `XtermHost` renders the exit line.
        }}
        notice={
          lostTerminalIds.size > 0 ? (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-2 border-b border-line-3 bg-warning-wash px-3 py-2 text-[12px] leading-4 text-ink-primary"
            >
              <span className="flex-1">
                {`The terminal service stopped and ${String(lostTerminalIds.size)} `
                  + `${lostTerminalIds.size === 1 ? "shell" : "shells"} ended with it. `
                  + "Their saved output can be restored."}
              </span>
              <button
                type="button"
                onClick={handleRestoreLost}
                disabled={restoring}
                className="rounded px-1 font-medium text-accent-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
              >
                {restoring ? "Restoring..." : "Restore terminals"}
              </button>
            </div>
          ) : notice === null ? null : (
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
