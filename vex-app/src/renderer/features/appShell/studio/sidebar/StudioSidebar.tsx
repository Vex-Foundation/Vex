/**
 * THE STUDIO SIDEBAR, column 1 while `runtimeMode === "studio"`, in H3 cells
 * (our approved Studio plate, `?plate=studio-project` in the harness;
 * docs/design/H3-DESKTOP.md sections 1.4 and 4.9).
 *
 * Studio is a place in the app, not a second application, so its column IS
 * the chats column with Studio's own cells: the head (the logo cell and the
 * sidebar key) is the frame's header over it (`headless`; a standalone mount
 * draws its own 44px head row), and the account cell is the bottom row's.
 * Open, top to bottom:
 *
 *   NEW PROJECT    the 55 cell on the cell fill, where the agent column has
 *                  NEW CHAT: Studio's one way to make something
 *   Search files   the 48 cell; it opens ONE field over the projects and the
 *                  open project's files (below)
 *   the nav        FOLDED to its Studio row, with a chevron key that unfolds
 *                  the nine rows in place and folds them again (the fold is
 *                  this column's own state, `SidebarNav`'s `fold`). The
 *                  Studio row, pressed where it is current, returns to
 *                  Studio's start (the welcome); the Chat row is the way back
 *                  to the agent shell and its New chat
 *   PROJECTS       a 44 head, rows on the 36 pitch with a RUNNING tag while a
 *                  shell of the project's is live, "Show all N" under three
 *                  (`StudioProjectsSection`)
 *   EXPLORER       a 44 head with the new file, new folder, refresh and
 *                  collapse keys, the tree on a 30 pitch (`ExplorerTree`)
 *
 * ## The explorer is a PANE, not a box
 *
 * The body under the nav is a vertical `SplitPane`: the projects above, the
 * explorer pane below taking the rest, and a real separator between them whose
 * share is a persisted UI preference (`uiStore.studioRailExplorerShare`).
 *
 * The explorer is HIDDEN with the `hidden` attribute, not unmounted, while a
 * search shows results: unmounting the tree would release its explorer
 * session, drop its watcher and throw away every folder the user expanded.
 * Without ANY active project there is nothing to render, so it is absent.
 *
 * ## The rail is ICONS ONLY, and its files are a drawer
 *
 * Folded to the 76px rail, the column keeps one key per control, each the
 * rail's whole width in the open column's order: the Expand key (where the
 * column can open, from 1280 up), New project, Search, the nine nav keys.
 * Tooltips and accessible names carry the words. Under 1280 the column never
 * opens (docs/design/H3-DESKTOP.md section 4.12: no track changes there), so
 * the rail ends in a Projects and files key instead: it opens the same
 * projects and explorer as a 248 drawer over Vex's column (under the band
 * below 1024), and the drawer closes on a pick, on Escape and on the key.
 *
 * ## Search
 *
 * The Search row opens ONE field over two kinds of thing - project names and
 * the open project's files - with grouped results. The file half is a
 * MAIN-SIDE NAME INDEX over the whole project (`use-rail-file-index.ts`),
 * merged with the nodes the explorer has already loaded, so there is an honest
 * answer while the index builds. The index has a SESSION lifetime - walked
 * when the search opens, reused for every keystroke, released when it closes -
 * and its bounds and its age are stated on screen (`rail-search-model.ts`,
 * `StudioRailSearchResults.tsx`). As in the agent column, the field takes the
 * search cell's place with New project above it and the nav out of the way;
 * Escape clears a typed query first, then closes.
 */

import { ProjectCleanupNotices } from "../projects/ProjectCleanupNotices.js";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { FileNode } from "@shared/schemas/files.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import {
  LineChevronDown,
  LineChevronUp,
  LineClose,
  LineFolder,
  LinePanelLeft,
  LinePlus,
  LineSearch,
} from "../../../../components/icons/line/index.js";
import { SplitPane } from "../../../../components/ui/split-pane.js";
import { Tooltip } from "../../../../components/ui/tooltip.js";
import { H3_BAND_HEIGHT } from "../../../../lib/shell-columns.js";
import { useQuietScrollbars } from "../../../../lib/useQuietScrollbars.js";
import { useScrollbarVisibility } from "../../../../lib/useScrollbarVisibility.js";
import { cn } from "../../../../lib/utils.js";
import { projectKeys, useProjects } from "../../../../lib/api/projects.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { setUpdateCardSlot } from "../../../updates/update-card-slot.js";
import { SidebarHomeSigil } from "../../SidebarHomeSigil.js";
import { SidebarProfile } from "../../SidebarProfile.js";
import { NavKey, SidebarNav } from "../../SessionRows/SidebarNav.js";
import {
  ExplorerHeader,
  explorerRegistry as windowExplorerRegistry,
  ExplorerTree,
  type ExplorerRegistry,
} from "../explorer/index.js";
import { openProjectCreator } from "../projects/index.js";
import { publishFileOpen } from "../workspace/file-open-intent.js";
import type { FileOpenMode } from "../workspace/types.js";
import {
  projectFileDriftLabel,
  STUDIO_DRIFT_SENTENCES,
  STUDIO_EXPLORER_SECTION,
  STUDIO_FILES_DRAWER_LABEL,
  STUDIO_NAV_FOLD_LABEL,
  STUDIO_NAV_UNFOLD_LABEL,
  STUDIO_NEW_PROJECT_LABEL,
  STUDIO_RAIL_SPLIT_LABEL,
  STUDIO_SEARCH_CLEAR_LABEL,
  STUDIO_SEARCH_CLOSE_LABEL,
  STUDIO_SEARCH_OPEN_LABEL,
  STUDIO_SEARCH_PLACEHOLDER,
  STUDIO_SEARCH_ROW_LABEL,
  STUDIO_SIDEBAR_COLLAPSE_LABEL,
  STUDIO_SIDEBAR_EXPAND_LABEL,
  STUDIO_SIDEBAR_LABEL,
} from "../studio-copy.js";
import { driftedArtifactPaths } from "./project-row-model.js";
import {
  deriveRailSearchResults,
  railSearchHitCount,
  RAIL_SEARCH_SCAN_MAX,
} from "./rail-search-model.js";
import { StudioProjectsSection } from "./StudioProjectsSection.js";
import { StudioRailSearchResults } from "./StudioRailSearchResults.js";
import { useRailFileIndex } from "./use-rail-file-index.js";


/** The listbox id the search field's `aria-controls` points at. */
const SEARCH_LISTBOX_ID = "studio-rail-search-results";

/** What the reader below answers with. */
interface LoadedFileRead {
  readonly nodes: readonly FileNode[];
  /** The model's read stopped at the cap; files past it were never examined. */
  readonly truncated: boolean;
}

/** Nothing loaded, and a STABLE identity so the snapshot never churns. */
const NO_NODES: LoadedFileRead = { nodes: [], truncated: false };

/* ------------------------------------------------------------------ *
 * The one thing this rail publishes to the rest of Studio
 * ------------------------------------------------------------------ */

/**
 * The mounted rail's "open the search and focus it", or null when no rail is
 * mounted.
 *
 * A REGISTERED HANDLE rather than a DOM query, unlike the explorer's focus,
 * and the difference is what each surface can be reached by. The explorer tree
 * is always rendered when it exists, so an element is there to focus; the
 * search FIELD does not exist until the search is open and the rail is wide,
 * so `Ctrl+P` has to change component state before there is anything to put a
 * caret in. That state has exactly one owner and this is the narrowest way to
 * ask it.
 *
 * Module-scope and single-slot because the shell mounts exactly one Studio
 * rail. The registration is identity-checked on the way out, like every other
 * single-slot registration in this feature, so a rail that unmounted after its
 * successor mounted cannot delete the successor's handle.
 */
let railSearchFocus: (() => void) | null = null;

function publishStudioRailSearchFocus(focus: () => void): () => void {
  railSearchFocus = focus;
  return () => {
    if (railSearchFocus === focus) railSearchFocus = null;
  };
}

/**
 * OPEN THE RAIL'S UNIFIED SEARCH AND FOCUS IT. `Ctrl+P`'s owner.
 *
 * Returns whether a rail was mounted to answer. `false` is an ordinary answer -
 * Studio is not the active shell - and the caller must be able to tell, so a
 * shortcut nothing answered leaves the keystroke alone instead of eating it.
 *
 * Studio's ONE search is the rail's: it spans projects and the loaded file
 * tree, which is the surface `Go to file` means here. There is no second quick
 * open to build, and building one would be a second answer to the same
 * question (see this file's header on the unified search).
 */
export function focusStudioRailSearch(): boolean {
  const focus = railSearchFocus;
  if (focus === null) return false;
  focus();
  return true;
}


/** The drawer's id, for its key's `aria-controls`. */
const STUDIO_FILES_DRAWER_ID = "studio-files-drawer";

export interface StudioSidebarProps {
  /**
   * Open the project creator. OPTIONAL, and the default is the real publisher.
   * The prop stays for tests and for any future mount that wants to route the
   * request somewhere else.
   */
  readonly onCreateProject?: () => void;
  /** Rail state decided by the shell frame (breakpoint-aware). */
  readonly collapsed: boolean;
  readonly onToggleSidebar: () => void;
  /**
   * Whether the rail can open into the column. False under 1280, where the
   * rail ends in the Projects and files key and its drawer instead.
   */
  readonly expandable?: boolean;
  /** The drawer's top under the header: the band's height under 1024, else 0. */
  readonly drawerTop?: number;
  readonly activeProjectId: string | null;
  readonly onSelectProject: (projectId: string) => void;
  readonly onSelectWelcome: () => void;
  /** Test seam; production uses the window's registry. */
  readonly explorerRegistry?: ExplorerRegistry;
  /**
   * The frame draws this column's head and foot cells: the logo cell and
   * the sidebar key in its header (`ShellHeader`), the account cell in its
   * bottom row. The column holds only its body.
   */
  readonly headless?: boolean;
}

export function StudioSidebar({
  onCreateProject = openProjectCreator,
  collapsed,
  onToggleSidebar,
  expandable = true,
  drawerTop = H3_BAND_HEIGHT,
  activeProjectId,
  onSelectProject,
  onSelectWelcome,
  explorerRegistry,
  headless = false,
}: StudioSidebarProps): JSX.Element {
  const query = useProjects();
  const queryClient = useQueryClient();

  // The open column renders its sections; closed, the icon rail.
  const wide = !collapsed;

  const explorerShare = useUiStore((state) => state.studioRailExplorerShare);
  const setExplorerShare = useUiStore((state) => state.setStudioRailExplorerShare);

  const columnRef = useRef<HTMLElement | null>(null);
  const { quiet, onPointerEnter, onPointerLeave } = useQuietScrollbars(columnRef);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollbarVisibility(listScrollRef);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [activeHit, setActiveHit] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect((): void => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // The nav's fold (the plate: folded to its Studio row). Launch-ephemeral:
  // every Studio entry starts folded.
  const [navFolded, setNavFolded] = useState(true);

  // THE DRAWER, under 1024 only: the rail cannot open there, so its Projects
  // and files key opens the projects and the explorer over the centre's left
  // edge. Leaving the band (the rail can open again) closes it.
  const drawerAllowed = collapsed && !expandable;
  const [drawerRequested, setDrawerRequested] = useState(false);
  const drawerOpen = drawerAllowed && drawerRequested;
  useEffect((): void => {
    if (!drawerAllowed) setDrawerRequested(false);
  }, [drawerAllowed]);
  const drawerKeyRef = useRef<HTMLButtonElement | null>(null);
  const closeDrawer = useCallback((): void => {
    setDrawerRequested(false);
  }, []);
  // Escape closes the drawer wherever the focus is in it, and gives the
  // focus back to the key that opened it.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setDrawerRequested(false);
      drawerKeyRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // The bounded project list's own toggle. The SPLIT's share is the persisted
  // preference.
  const [showAllProjects, setShowAllProjects] = useState(false);

  const allProjects: readonly ProjectDto[] = useMemo(
    () => (query.data !== undefined && query.data.ok ? query.data.data : []),
    [query.data],
  );
  // A failed projects read is its OWN state, and both shapes of failure reach
  // it: a settled `ok: false` Result, and a REJECTED call that leaves no
  // Result at all (the preload bridge throwing, the window tearing down
  // mid-call). The second used to fall through to the `[]` above and paint
  // "No projects yet." - the sidebar telling the user they own nothing when
  // what actually happened is that Vex could not look (rule 08: failure is not
  // emptiness). A failed REFETCH that still has a good earlier list is
  // deliberately not this state: those rows are real and stay on screen, which
  // is why the derivation asks "is there a usable payload" rather than
  // `query.isError` alone.
  const readFailed =
    query.data === undefined ? query.isError : !query.data.ok;
  // Derived from the same rows the list renders, so a failed read gives no
  // active project and the EXPLORER section below is absent rather than
  // titled with a name nothing confirmed.
  const activeProject =
    activeProjectId === null
      ? null
      : (allProjects.find((project) => project.id === activeProjectId) ?? null);

  const activeRegistry = explorerRegistry ?? windowExplorerRegistry;
  const searching = searchOpen && searchText.trim().length > 0;

  // The files half of the search reads the OPEN project's loaded nodes. Only
  // while a query is live: a rail with no search open does not walk the tree.
  const loadedFiles = useLoadedFileNodes(
    activeRegistry,
    searching ? activeProjectId : null,
  );
  // The project-wide half. Its session opens with the search and closes with
  // it, so the walk happens once per opening rather than once per keystroke.
  const indexedFiles = useRailFileIndex(activeProjectId, searching, searchText);
  const results = useMemo(
    () =>
      deriveRailSearchResults(
        allProjects,
        loadedFiles.nodes,
        searchText,
        loadedFiles.truncated,
        indexedFiles,
      ),
    [allProjects, loadedFiles, searchText, indexedFiles],
  );
  const hitCount = railSearchHitCount(results);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchText("");
    setActiveHit(-1);
  }, []);
  const clearSearch = useCallback((): void => {
    setSearchText("");
    setActiveHit(-1);
    searchInputRef.current?.focus();
  }, []);

  // The Search key on a collapsed rail expands it first - a search field has
  // no room on the rail. Under 1024 the rail cannot open, so the key opens
  // the field the only way it can: by asking the frame, which keeps the rail.
  const toggleSearch = useCallback((): void => {
    if (collapsed) {
      onToggleSidebar();
      setSearchOpen(true);
      return;
    }
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  }, [collapsed, searchOpen, onToggleSidebar, closeSearch]);

  /**
   * `Ctrl+P`'s owner: OPEN the search and put the caret in it. Never close it.
   *
   * Deliberately not `toggleSearch`. The magnifier is a toggle because a
   * pointer press on an open search means "put this away"; `Go to file` means
   * one thing only, and a second press that closed the field would make the
   * shortcut a coin flip depending on state the user cannot see from the
   * keyboard. When the field is already open this re-focuses and SELECTS, so a
   * second press starts a fresh query over the old text rather than appending
   * to it - VS Code's Quick Open behaves the same way.
   *
   * The collapsed branch mirrors the magnifier's, and it is the only place the
   * rail is expanded: a search field has no room on the rail. The
   * `searchOpen` effect above lands the focus in that case, because the input
   * does not exist yet at this point.
   */
  const focusSearch = useCallback((): void => {
    if (collapsed) {
      onToggleSidebar();
      setSearchOpen(true);
      return;
    }
    if (!searchOpen) {
      setSearchOpen(true);
      return;
    }
    const input = searchInputRef.current;
    input?.focus();
    input?.select();
  }, [collapsed, onToggleSidebar, searchOpen]);

  useEffect(() => publishStudioRailSearchFocus(focusSearch), [focusSearch]);

  /**
   * Park a file for the workspace, in the mode the GESTURE asked for.
   *
   * `mode` defaults to `"pinned"`, which is what every route but the tree's
   * single click means: a search hit the user picked out of a list is a file
   * they chose, not one they browsed past. Only `ExplorerTree` passes
   * `"preview"`, and only for a single click. A pick closes the drawer.
   */
  const handleOpenFile = useCallback(
    (node: FileNode, mode: FileOpenMode = "pinned"): void => {
      if (activeProjectId === null) return;
      publishFileOpen(activeProjectId, node, mode);
      closeDrawer();
    },
    [activeProjectId, closeDrawer],
  );

  /** A project picked in the column or the drawer; the drawer closes on it. */
  const selectProject = useCallback(
    (projectId: string): void => {
      onSelectProject(projectId);
      closeDrawer();
    },
    [onSelectProject, closeDrawer],
  );

  const moveActiveHit = useCallback(
    (direction: "next" | "previous" | "first" | "last"): void => {
      if (hitCount === 0) {
        setActiveHit(-1);
        return;
      }
      setActiveHit((current) => {
        if (direction === "first") return 0;
        if (direction === "last") return hitCount - 1;
        if (direction === "next") return current + 1 >= hitCount ? 0 : current + 1;
        return current <= 0 ? hitCount - 1 : current - 1;
      });
    },
    [hitCount],
  );

  const openHit = useCallback(
    (index: number): void => {
      const project = results.projects[index];
      if (project !== undefined) {
        closeSearch();
        selectProject(project.id);
        return;
      }
      const node = results.files[index - results.projects.length];
      if (node === undefined) return;
      closeSearch();
      handleOpenFile(node);
    },
    [closeSearch, handleOpenFile, selectProject, results],
  );

  // Enter with nothing highlighted opens the FIRST hit, which is what a user
  // who typed a name and pressed Enter is asking for.
  const activateHit = useCallback((): void => {
    openHit(activeHit < 0 ? 0 : activeHit);
  }, [activeHit, openHit]);

  const retry = useCallback((): void => {
    void query.refetch();
    void queryClient.invalidateQueries({ queryKey: projectKeys.pendingCleanups() });
  }, [query, queryClient]);

  // The header's actions act on the session the TREE holds. `peek` reads it
  // without taking a reference, which is what keeps the header a sibling of the
  // tree rather than a second owner of its lifetime.
  const refreshExplorer = useCallback((): void => {
    if (activeProjectId === null) return;
    activeRegistry.peek(activeProjectId)?.refreshNow();
  }, [activeRegistry, activeProjectId]);
  const collapseExplorer = useCallback((): void => {
    if (activeProjectId === null) return;
    activeRegistry.peek(activeProjectId)?.collapseAll();
  }, [activeRegistry, activeProjectId]);

  /**
   * The header's New file / New folder, which create WHERE THE USER IS.
   *
   * VS Code's `explorer.newFile` reads the explorer's context before it opens
   * the name box (`fileActions.ts:931-938`): the selected directory takes the
   * new entry, a selected file gives it to its parent, and only an empty
   * selection means the root. Creating at the root with a folder selected -
   * which is what these two used to do - put `inner.ts` beside `src` for a
   * user who had just clicked `src` (live test 2026-09-03, I-4).
   *
   * The rule itself lives on the SESSION (`createParentId`), so the header and
   * the row menu cannot answer it differently, and both go through
   * `beginCreate` like every other create - the session opens the name box,
   * validates against the siblings, and commits - so the header gains a route
   * to the write and never a second way of performing it.
   */
  const createInExplorer = useCallback(
    (kind: "file" | "directory"): void => {
      if (activeProjectId === null) return;
      const session = activeRegistry.peek(activeProjectId);
      if (session === null) return;
      void session.beginCreate(session.createParentId(session.getFocusedRowId()), kind);
    },
    [activeRegistry, activeProjectId],
  );
  const createExplorerFile = useCallback((): void => {
    createInExplorer("file");
  }, [createInExplorer]);
  const createExplorerFolder = useCallback((): void => {
    createInExplorer("directory");
  }, [createInExplorer]);

  // The project owns the drift fact (it is read from disk on every project
  // read); the tree only decorates the file it names.
  const driftedPaths = useMemo((): ReadonlyMap<string, string> => {
    if (activeProject === null) return new Map();
    const labelled = new Map<string, string>();
    for (const [path, state] of driftedArtifactPaths(activeProject)) {
      const sentence = STUDIO_DRIFT_SENTENCES[state];
      if (sentence === undefined) continue;
      labelled.set(path, projectFileDriftLabel(fileNameOf(path), sentence));
    }
    return labelled;
  }, [activeProject]);

  // The Studio row, pressed where it is the current one (no page over
  // Studio), returns to Studio's start: the welcome.
  const onCurrentNav = useCallback(
    (destination: string): void => {
      if (destination === "studio") {
        onSelectWelcome();
        closeDrawer();
      }
    },
    [onSelectWelcome, closeDrawer],
  );

  const projectsRegion = (
    <div
      ref={listScrollRef}
      // `overflow-x-clip`: a bare `overflow-y-auto` computes overflow-x to
      // `auto`, so a row that overshoots would draw a horizontal bar.
      className="vex-scroll vex-scroll-overlay vex-st-pane min-h-0 flex-1 overflow-y-auto overflow-x-clip"
      data-vex-rail-pane="projects"
      data-rail-control
    >
      <StudioProjectsSection
        projects={allProjects}
        activeProjectId={activeProjectId}
        isLoading={query.isLoading}
        hasError={readFailed}
        onRetry={retry}
        onSelect={selectProject}
        showAll={showAllProjects}
        onShowAllChange={setShowAllProjects}
      />

      <ProjectCleanupNotices showReadError={!query.isPending && !readFailed} />
    </div>
  );

  const explorerPane =
    activeProject === null ? null : (
      <div className="vex-st-xpane flex h-full min-h-0 flex-col" data-vex-rail-pane="explorer">
        {/* EXPLORER, the pane's 44 head, with its keys at the right; the
          * rows follow on the 30 pitch with no frame around them. The open
          * project's name is the header's title cell. */}
        <ExplorerHeader
          title={STUDIO_EXPLORER_SECTION}
          onRefresh={refreshExplorer}
          onCollapseAll={collapseExplorer}
          onCreateFile={createExplorerFile}
          onCreateFolder={createExplorerFolder}
        />
        <ExplorerTree
          projectId={activeProject.id}
          onOpenFile={handleOpenFile}
          registry={activeRegistry}
          driftedPaths={driftedPaths}
          className="min-h-0 flex-1"
        />
      </div>
    );

  // The projects and the explorer, split by the draggable rule: the open
  // column's body, and the drawer's.
  const projectsAndFiles =
    explorerPane !== null ? (
      <SplitPane
        orientation="vertical"
        sizes={[1 - explorerShare, explorerShare]}
        onResize={(next) => {
          const share = next[1];
          if (share !== undefined) setExplorerShare(share);
        }}
        minPaneSize={96}
        separatorLabel={() => STUDIO_RAIL_SPLIT_LABEL}
        className="min-h-0 flex-1"
      >
        {projectsRegion}
        {explorerPane}
      </SplitPane>
    ) : (
      projectsRegion
    );

  const newProjectKey = (
    <NavKey
      icon={<LinePlus className="vex-ls-nrow__i" />}
      label={STUDIO_NEW_PROJECT_LABEL}
      rail={!wide}
      onClick={() => onCreateProject()}
      className="vex-ls-nrow--new"
    />
  );

  const searchKey = (
    <NavKey
      icon={<LineSearch className="vex-ls-nrow__i" />}
      label={STUDIO_SEARCH_ROW_LABEL}
      ariaLabel={STUDIO_SEARCH_OPEN_LABEL}
      rail={!wide}
      onClick={toggleSearch}
      className="vex-ls-nrow--search"
    />
  );

  // The chevron key beside the Studio row: unfolds the nine rows in place,
  // and folds them back.
  const navFoldKey = (
    <Tooltip label={navFolded ? STUDIO_NAV_UNFOLD_LABEL : STUDIO_NAV_FOLD_LABEL}>
      <button
        type="button"
        aria-label={navFolded ? STUDIO_NAV_UNFOLD_LABEL : STUDIO_NAV_FOLD_LABEL}
        aria-expanded={!navFolded}
        onClick={() => setNavFolded((folded) => !folded)}
        className="vex-ls-nav__fold"
        data-vex-nav-fold=""
      >
        {navFolded ? <LineChevronDown size={16} /> : <LineChevronUp size={16} />}
      </button>
    </Tooltip>
  );

  return (
    <aside
      ref={columnRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label={STUDIO_SIDEBAR_LABEL}
      className={cn("vex-sidebar vex-ls vex-st", quiet && "vex-quiet-bars")}
      data-vex-area="studio-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
      data-rail={collapsed || undefined}
    >
      {headless ? null : wide ? (
        <header className="vex-ls-head vex-drag vex-lights-start">
          <SidebarHomeSigil sidebarOpen />
          <Tooltip label="Collapse sidebar" side="bottom">
            <button
              type="button"
              aria-label={STUDIO_SIDEBAR_COLLAPSE_LABEL}
              aria-expanded
              onClick={onToggleSidebar}
              className="vex-ls-ikey"
            >
              <LinePanelLeft />
            </button>
          </Tooltip>
        </header>
      ) : (
        // The rail's head row is the frame's paper cap; the mark sits on it
        // where the OS draws no traffic lights.
        <div className="vex-ls-railhead vex-no-drag">
          <SidebarHomeSigil sidebarOpen={false} />
        </div>
      )}

      {wide ? (
        <div className="vex-ls-body">
          {newProjectKey}
          {searchOpen ? (
            <div className="vex-ls-find vex-st-find">
              <StudioSearchField
                value={searchText}
                onChange={(value) => {
                  setSearchText(value);
                  setActiveHit(-1);
                }}
                onClose={closeSearch}
                onClear={clearSearch}
                inputRef={(el) => {
                  searchInputRef.current = el;
                }}
                listboxId={SEARCH_LISTBOX_ID}
                activeOptionId={activeHit < 0 ? null : searchOptionId(activeHit)}
                expanded={searching && hitCount > 0}
                onMove={moveActiveHit}
                onActivate={activateHit}
              />
            </div>
          ) : (
            <>
              {searchKey}
              <SidebarNav
                rail={false}
                // Missions from Studio lands on the agent shell with the
                // Mission filter set; the agent sidebar owns its own search.
                onMissions={() => undefined}
                fold={{ folded: navFolded, destination: "studio", toggle: navFoldKey }}
                onCurrent={onCurrentNav}
              />
            </>
          )}

          {searching ? (
            <StudioRailSearchResults
              results={results}
              listboxId={SEARCH_LISTBOX_ID}
              activeIndex={activeHit}
              optionId={searchOptionId}
              onOpenProject={(projectId) => {
                closeSearch();
                selectProject(projectId);
              }}
              onOpenFile={(node) => {
                closeSearch();
                handleOpenFile(node);
              }}
              fileSearchAvailable={activeProjectId !== null}
            />
          ) : null}

          {/* HIDDEN, never unmounted, while the search shows results:
            * unmounting the tree would release the explorer session and lose
            * every folder the user expanded. */}
          <div className="vex-st-body flex min-h-0 flex-1 flex-col" hidden={searching}>
            {projectsAndFiles}
          </div>
        </div>
      ) : (
        <div className="vex-ls-body">
          {/* The rail's cells, the open column's in the same order, each 76
            * wide: the Expand key where the column can open, New project,
            * Search, the nine nav keys; under 1024 the Projects and files
            * key at the end instead. */}
          {expandable ? (
            <Tooltip label={STUDIO_SIDEBAR_EXPAND_LABEL}>
              <button
                type="button"
                aria-label={STUDIO_SIDEBAR_EXPAND_LABEL}
                aria-expanded={false}
                onClick={onToggleSidebar}
                className="vex-ls-nrow vex-ls-nrow--expand"
              >
                <LinePanelLeft className="vex-ls-nrow__i" />
              </button>
            </Tooltip>
          ) : null}
          {newProjectKey}
          {searchKey}
          <SidebarNav rail onMissions={() => undefined} onCurrent={onCurrentNav} />
          <ProjectCleanupNotices
            collapsed
            onExpand={expandable ? onToggleSidebar : () => setDrawerRequested(true)}
            showReadError={!query.isPending && !readFailed}
          />
          {expandable ? null : (
            <Tooltip label={STUDIO_FILES_DRAWER_LABEL}>
              <button
                ref={drawerKeyRef}
                type="button"
                aria-label={STUDIO_FILES_DRAWER_LABEL}
                aria-expanded={drawerOpen}
                aria-controls={drawerOpen ? STUDIO_FILES_DRAWER_ID : undefined}
                onClick={() => setDrawerRequested((open) => !open)}
                className="vex-ls-nrow vex-ls-nrow--files"
                data-open={drawerOpen || undefined}
              >
                <LineFolder className="vex-ls-nrow__i" />
              </button>
            </Tooltip>
          )}
        </div>
      )}

      {/* THE DRAWER: the projects and the explorer, 248 wide over the
        * centre's left edge, from under the band to the window's foot. */}
      {drawerOpen ? (
        <section
          id={STUDIO_FILES_DRAWER_ID}
          aria-label={STUDIO_FILES_DRAWER_LABEL}
          className="vex-ls vex-st vex-st-drawer"
          data-vex-area="studio-files-drawer"
          style={{ top: drawerTop }}
        >
          <div className="vex-st-body flex min-h-0 flex-1 flex-col">{projectsAndFiles}</div>
        </section>
      ) : null}

      {/* The update card stands here, above the account row, as in the agent
        * sidebar; the rail has no room for it, so the card floats clear. */}
      {wide ? (
        <div ref={setUpdateCardSlot} className="vex-upd-slot" data-vex-area="update-slot" />
      ) : null}

      {/* The account row: the frame's bottom row draws it under this column
        * (its account cell) when the header draws the head. */}
      {headless ? null : (
        <footer className="vex-ls-foot" data-rail-foot>
          <SidebarProfile sidebarOpen={wide} />
        </footer>
      )}
    </aside>
  );
}

/**
 * THE SEARCH FIELD, in the left sidebar's own shape (docs/design/R3-MINIMAL.md
 * section 4): 38 high, a 1px blue border on the field background, the
 * magnifier in blue, 14. A combobox over the grouped results: the input keeps
 * DOM focus and names the active option through `aria-activedescendant`, so a
 * keystroke that re-derives the list cannot drop focus.
 *
 * Two controls, two names: the clear key (only while there is text) empties
 * the query; the Esc key closes the search, as Escape does on an empty query.
 */
function StudioSearchField({
  value,
  onChange,
  onClose,
  onClear,
  inputRef,
  listboxId,
  activeOptionId,
  expanded,
  onMove,
  onActivate,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onClear: () => void;
  readonly inputRef: (el: HTMLInputElement | null) => void;
  readonly listboxId: string;
  readonly activeOptionId: string | null;
  readonly expanded: boolean;
  readonly onMove: (direction: "next" | "previous" | "first" | "last") => void;
  readonly onActivate: () => void;
}): JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (value.length > 0) onClear();
      else onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove("next");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove("previous");
    } else if (event.key === "Home" && expanded) {
      event.preventDefault();
      onMove("first");
    } else if (event.key === "End" && expanded) {
      event.preventDefault();
      onMove("last");
    } else if (event.key === "Enter") {
      event.preventDefault();
      onActivate();
    }
  };
  return (
    <div className="vex-ls-search">
      <LineSearch className="vex-ls-search__i" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={STUDIO_SEARCH_PLACEHOLDER}
        aria-label={STUDIO_SEARCH_PLACEHOLDER}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-autocomplete="list"
        {...(activeOptionId === null ? {} : { "aria-activedescendant": activeOptionId })}
        autoComplete="off"
        spellCheck={false}
        className="vex-ls-search__input"
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label={STUDIO_SEARCH_CLEAR_LABEL}
          onClick={onClear}
          className="vex-st-search__clear"
        >
          <LineClose size={14} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={STUDIO_SEARCH_CLOSE_LABEL}
        title={STUDIO_SEARCH_CLOSE_LABEL}
        onClick={onClose}
        className="vex-ls-search__kbd vex-st-search__esc"
      >
        Esc
      </button>
    </div>
  );
}

/** Stable per-index DOM id, so `aria-activedescendant` always resolves. */
function searchOptionId(index: number): string {
  return `${SEARCH_LISTBOX_ID}-option-${String(index)}`;
}

/** The last segment of a project-relative POSIX path. */
function fileNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The open project's loaded file nodes, tracked through the session's own
 * revision counter.
 *
 * A READER, never an owner: it `peek`s the session the tree already holds
 * rather than acquiring one, so a search cannot start a watcher or keep a
 * project alive. With no project (or no live query) it subscribes to nothing
 * and answers with the same empty array every time, which is what
 * `useSyncExternalStore` needs to avoid an infinite re-render.
 */
function useLoadedFileNodes(
  registry: ExplorerRegistry,
  projectId: string | null,
): LoadedFileRead {
  const session = projectId === null ? null : registry.peek(projectId) ?? null;
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      if (session === null) return () => undefined;
      return session.subscribeRevision(onChange);
    },
    [session],
  );
  const revision = useSyncExternalStore(
    subscribe,
    () => session?.getRevision() ?? 0,
    () => 0,
  );
  return useMemo(
    () =>
      session === null ? NO_NODES : session.model.loadedNodes(RAIL_SEARCH_SCAN_MAX),
    // The revision IS the dependency: the model mutates in place, so nothing
    // else here changes when a folder finishes listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, revision],
  );
}
