/**
 * The Studio sidebar - column 1 while `runtimeMode === "studio"`.
 *
 * It MIRRORS `features/appShell/SessionsList.tsx` element for element rather
 * than inventing a second rail language: the same `<aside>` glass surface, the
 * same header (home sigil left, search and collapse right), the same collapse
 * choreography, the same quiet scrollbars, the same `VexTokenCardCompact` and
 * `SidebarProfile` foot. Only the CONTENT between them is different, which is
 * exactly the difference a user should perceive when the mode changes.
 *
 * ## The collapsed rail is ICONS ONLY
 *
 * deepseek's `SidebarRoot` states the contract this follows: collapsing the
 * column leaves one icon per control and nothing else, with tooltips and
 * accessible names carrying the words (`SidebarRoot.tsx:130-170`); VS Code's
 * activity bar is the same rule. The rail used to render the PROJECTS
 * disclosure at 56px, which bled its chevron and the first letters of its title
 * ("Pro") into the spine. Collapsed now renders the icon rows and the
 * icon-shaped New Project key; every section title, chevron, count and
 * placeholder sentence is wide-only.
 *
 * ## The explorer is a PANE, not a box
 *
 * VS Code's explorer is a view pane that takes the view's height
 * (`explorerView.ts:293-296`: `layoutBody(height)` hands the whole height to
 * the tree). Ours did the opposite - a fixed 256px window inside a scrolling
 * rail, which is half empty on a small project and a keyhole on a real one. The
 * list region is now a vertical `SplitPane`: the PROJECTS list above, the
 * explorer pane below taking the rest, and a real separator between them whose
 * share is a persisted UI preference (`uiStore.studioRailExplorerShare`).
 *
 * The EXPLORER section is HIDDEN with the `hidden` attribute, not unmounted,
 * whenever a project is active: unmounting the tree would release its explorer
 * session, drop its watcher and throw away every folder the user expanded.
 * Without ANY active project there is nothing to render, so it is absent -
 * there is no session to preserve in that case. The same rule is why a live
 * SEARCH hides the body rather than replacing it.
 *
 * ## Search
 *
 * ONE field over two kinds of thing - project names and the files the open
 * project's explorer has already loaded - with grouped results, the shape
 * deepseek's `WorkspaceBrowser` search uses. The bounds are stated on screen
 * (`rail-search-model.ts`), because the file half is NOT a project-wide index:
 * a folder the user never opened was never listed and cannot be searched from
 * the renderer. A main-side name index is a later stage.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import type { FileNode } from "@shared/schemas/files.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import {
  IconClose,
  IconFolderOpen,
  IconHome,
  IconPanelLeft,
  IconPlus,
  IconSearch,
  IconSettings,
  IconThemeDark,
  IconThemeLight,
} from "../../../../components/icons/index.js";
import { RailRow, RailSearchField } from "../../../../components/ui/rail-list.js";
import { DisclosureRow } from "../../../../components/ui/disclosure-row.js";
import { SplitPane } from "../../../../components/ui/split-pane.js";
import { useCollapseChoreography } from "../../../../lib/useCollapseChoreography.js";
import { useQuietScrollbars } from "../../../../lib/useQuietScrollbars.js";
import { useScrollbarVisibility } from "../../../../lib/useScrollbarVisibility.js";
import { cn } from "../../../../lib/utils.js";
import { useProjects } from "../../../../lib/api/projects.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { SidebarHomeSigil } from "../../SidebarHomeSigil.js";
import { SidebarProfile } from "../../SidebarProfile.js";
import { SidebarIconButton } from "../../SessionRows.js";
import { RuntimeModeToggle } from "../../RuntimeModeToggle.js";
import { VexTokenCardCompact } from "../../market/VexTokenCardCompact.js";
import {
  ExplorerHeader,
  explorerRegistry as windowExplorerRegistry,
  ExplorerTree,
  type ExplorerRegistry,
} from "../explorer/index.js";
import { openProjectCreator } from "../projects/index.js";
import { publishFileOpen } from "../workspace/file-open-intent.js";
import {
  projectFileDriftLabel,
  STUDIO_DRIFT_SENTENCES,
  STUDIO_EXPLORER_SECTION,
  STUDIO_PROJECTS_SECTION,
  STUDIO_NEW_PROJECT_LABEL,
  STUDIO_RAIL_SETTINGS_LABEL,
  STUDIO_RAIL_SPLIT_LABEL,
  STUDIO_SEARCH_CLEAR_LABEL,
  STUDIO_SEARCH_CLOSE_LABEL,
  STUDIO_SEARCH_OPEN_LABEL,
  STUDIO_SEARCH_PLACEHOLDER,
  STUDIO_SIDEBAR_COLLAPSE_LABEL,
  STUDIO_SIDEBAR_EXPAND_LABEL,
  STUDIO_SIDEBAR_LABEL,
  studioThemeToggleLabel,
  STUDIO_WELCOME_ROW_LABEL,
} from "../studio-copy.js";
import { driftedArtifactPaths } from "./project-row-model.js";
import {
  deriveRailSearchResults,
  railSearchHitCount,
  RAIL_SEARCH_SCAN_MAX,
} from "./rail-search-model.js";
import { StudioProjectsSection } from "./StudioProjectsSection.js";
import { StudioRailSearchResults } from "./StudioRailSearchResults.js";

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

export interface StudioSidebarProps {
  /**
   * Open the project creator.
   *
   * OPTIONAL, and the default is now the real publisher rather than "no key":
   * B4a left the key absent because the creator did not exist and a control
   * wired to nothing would have been a lie. B4b built it, so the honest default
   * is the key that opens it. The prop stays for tests and for any future mount
   * that wants to route the request somewhere else.
   */
  readonly onCreateProject?: () => void;
  /** Rail state decided by the shell frame (breakpoint-aware). */
  readonly collapsed: boolean;
  /** Rendered track width from the concession solve. */
  readonly width: number;
  readonly onToggleSidebar: () => void;
  readonly activeProjectId: string | null;
  readonly onSelectProject: (projectId: string) => void;
  readonly onSelectWelcome: () => void;
  /** Test seam; production uses the window's registry. */
  readonly explorerRegistry?: ExplorerRegistry;
}

export function StudioSidebar({
  onCreateProject = openProjectCreator,
  collapsed,
  width,
  onToggleSidebar,
  activeProjectId,
  onSelectProject,
  onSelectWelcome,
  explorerRegistry,
}: StudioSidebarProps): JSX.Element {
  const query = useProjects();

  const { wide, fading, railIn, frozenWidth } = useCollapseChoreography(
    collapsed,
    width,
  );

  const runtimeMode = useUiStore((state) => state.runtimeMode);
  const setRuntimeMode = useUiStore((state) => state.setRuntimeMode);
  const theme = useUiStore((state) => state.theme);
  const setThemePreference = useUiStore((state) => state.setThemePreference);
  const setShellRoute = useUiStore((state) => state.setShellRoute);
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

  // Section open state is COMPONENT-LOCAL on purpose: it is a disclosure, not a
  // geometry the user drags. The SPLIT's share is the persisted preference.
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(true);
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
  const results = useMemo(
    () =>
      deriveRailSearchResults(
        allProjects,
        loadedFiles.nodes,
        searchText,
        loadedFiles.truncated,
      ),
    [allProjects, loadedFiles, searchText],
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

  // The magnifier on a collapsed rail expands it first - a search field has no
  // room on the 56px spine. Same rule as the sessions rail.
  const toggleSearch = useCallback((): void => {
    if (collapsed) {
      onToggleSidebar();
      setSearchOpen(true);
      return;
    }
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  }, [collapsed, searchOpen, onToggleSidebar, closeSearch]);

  const handleOpenFile = useCallback(
    (node: FileNode): void => {
      if (activeProjectId === null) return;
      publishFileOpen(activeProjectId, node);
    },
    [activeProjectId],
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
        onSelectProject(project.id);
        return;
      }
      const node = results.files[index - results.projects.length];
      if (node === undefined) return;
      closeSearch();
      handleOpenFile(node);
    },
    [closeSearch, handleOpenFile, onSelectProject, results],
  );

  // Enter with nothing highlighted opens the FIRST hit, which is what a user
  // who typed a name and pressed Enter is asking for.
  const activateHit = useCallback((): void => {
    openHit(activeHit < 0 ? 0 : activeHit);
  }, [activeHit, openHit]);

  const retry = useCallback((): void => {
    void query.refetch();
  }, [query]);

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

  const projectsRegion = (
    <div
      ref={listScrollRef}
      className="vex-scroll vex-scroll-overlay min-h-0 flex-1 overflow-y-auto overflow-x-clip px-2 py-3"
      data-vex-rail-pane="projects"
      data-rail-control
    >
      {wide ? (
        <DisclosureRow
          icon={<IconFolderOpen size={14} />}
          title={STUDIO_PROJECTS_SECTION}
          open={projectsOpen}
          expandable
          expandOnRowClick
          onToggle={() => setProjectsOpen((open) => !open)}
        >
          <StudioProjectsSection
            projects={allProjects}
            activeProjectId={activeProjectId}
            collapsed={false}
            isLoading={query.isLoading}
            hasError={readFailed}
            onRetry={retry}
            onSelect={onSelectProject}
            showAll={showAllProjects}
            onShowAllChange={setShowAllProjects}
          />
        </DisclosureRow>
      ) : (
        // COLLAPSED: the rows only. No disclosure title, no chevron, nothing
        // that can bleed a truncated word into the 56px spine.
        <StudioProjectsSection
          projects={allProjects}
          activeProjectId={activeProjectId}
          collapsed
          isLoading={query.isLoading}
          hasError={readFailed}
          onRetry={retry}
          onSelect={onSelectProject}
          showAll
          onShowAllChange={setShowAllProjects}
        />
      )}

      <div className="mt-2">
        <RailRow
          selected={activeProjectId === null}
          collapsed={!wide}
          icon={<IconHome size={16} />}
          leading={<IconHome size={14} />}
          title={STUDIO_WELCOME_ROW_LABEL}
          onSelect={onSelectWelcome}
          label={STUDIO_WELCOME_ROW_LABEL}
        />
      </div>
    </div>
  );

  const explorerPane =
    activeProject === null ? null : (
      <div className="flex h-full min-h-0 flex-col px-2 pb-3" data-vex-rail-pane="explorer">
        <DisclosureRow
          icon={<IconFolderOpen size={14} />}
          title={STUDIO_EXPLORER_SECTION}
          open={explorerOpen}
          expandable
          expandOnRowClick
          onToggle={() => setExplorerOpen((open) => !open)}
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* The pane takes the rest of the rail, as VS Code's explorer view
            * takes its view's height. It titles itself with the ROOT PROJECT'S
            * NAME, which is what that view pane does too. */}
          <div className="mt-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line-3">
            <ExplorerHeader
              title={activeProject.name}
              onRefresh={refreshExplorer}
              onCollapseAll={collapseExplorer}
            />
            <ExplorerTree
              projectId={activeProject.id}
              onOpenFile={handleOpenFile}
              registry={activeRegistry}
              driftedPaths={driftedPaths}
              className="min-h-0 flex-1"
            />
          </div>
        </DisclosureRow>
      </div>
    );

  return (
    <aside
      ref={columnRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label={STUDIO_SIDEBAR_LABEL}
      className={cn(
        // The same glass rail as the sessions sidebar (--vex-rail +
        // guard-whitelisted backdrop-blur, no separating stroke). Studio is the
        // same room, not a second application.
        "vex-sidebar relative flex h-full flex-col bg-[var(--vex-rail)] backdrop-blur-xl",
        fading && "vex-sidebar-fading",
        railIn && "vex-sidebar-rail-in",
        quiet && "vex-quiet-bars",
      )}
      style={wide ? { width: collapsed ? frozenWidth : "100%" } : undefined}
      data-vex-area="studio-sidebar"
      data-vex-sidebar-open={collapsed ? "false" : "true"}
    >
      <header
        className={cn(
          "relative flex shrink-0",
          wide
            ? "h-12 items-center justify-between px-3"
            : "flex-col items-center justify-center gap-0.5 px-2 py-2",
        )}
      >
        <SidebarHomeSigil sidebarOpen={wide} />
        <div
          className={cn("flex items-center", wide ? "gap-1" : "flex-col gap-0.5")}
          data-rail-control
        >
          {/* THE WAY BACK. Studio used to be reachable from the agent hero and
            * leavable only from the Studio welcome screen, so a user inside a
            * project had no rendered path back to agent mode. The capsule is
            * wide-only because it is words, not an icon; the collapsed rail
            * reaches it through the Welcome row or by expanding. */}
          {wide ? (
            <RuntimeModeToggle runtimeMode={runtimeMode} onChange={setRuntimeMode} />
          ) : null}
          <SidebarIconButton
            label={searchOpen ? STUDIO_SEARCH_CLOSE_LABEL : STUDIO_SEARCH_OPEN_LABEL}
            onClick={toggleSearch}
          >
            <IconSearch size={16} />
          </SidebarIconButton>
          <SidebarIconButton
            label={
              collapsed ? STUDIO_SIDEBAR_EXPAND_LABEL : STUDIO_SIDEBAR_COLLAPSE_LABEL
            }
            onClick={onToggleSidebar}
          >
            <IconPanelLeft size={17} />
          </SidebarIconButton>
        </div>
      </header>

      {wide && searchOpen ? (
        <div className="px-3 pt-1 pb-2">
          <RailSearchField
            value={searchText}
            onChange={(value) => {
              setSearchText(value);
              setActiveHit(-1);
            }}
            onClose={closeSearch}
            onClear={clearSearch}
            placeholder={STUDIO_SEARCH_PLACEHOLDER}
            label={STUDIO_SEARCH_PLACEHOLDER}
            closeLabel={STUDIO_SEARCH_CLOSE_LABEL}
            clearLabel={STUDIO_SEARCH_CLEAR_LABEL}
            inputRef={(el) => {
              searchInputRef.current = el;
            }}
            icon={<IconSearch size={14} />}
            closeIcon={<IconClose size={12} />}
            combobox={{
              listboxId: SEARCH_LISTBOX_ID,
              activeOptionId: activeHit < 0 ? null : searchOptionId(activeHit),
              expanded: searching && hitCount > 0,
              onMove: moveActiveHit,
              onActivate: activateHit,
            }}
          />
        </div>
      ) : null}

      <div className={cn("p-3", !wide && "px-2")} data-rail-control>
          {/* The rail's one accent-FILLED key, in the same register and the
            * same shape as the sessions rail's signing key. */}
          <button
            type="button"
            onClick={onCreateProject}
            aria-label={STUDIO_NEW_PROJECT_LABEL}
            className={cn(
              "vex-micro-label vex-micro-label--wide relative flex h-10 items-center justify-center gap-2 rounded-full bg-button-accent uppercase text-ink-on-button-accent transition-colors duration-150",
              "hover:bg-button-accent-hover",
              "active:scale-[0.99] active:bg-button-accent-hover",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--vex-surface-1)]",
              wide ? "w-full px-4" : "mx-auto w-10",
            )}
          >
            <IconPlus size={15} />
            {wide ? <span>{STUDIO_NEW_PROJECT_LABEL}</span> : null}
          </button>
      </div>

      {searching ? (
        <StudioRailSearchResults
          results={results}
          listboxId={SEARCH_LISTBOX_ID}
          activeIndex={activeHit}
          optionId={searchOptionId}
          onOpenProject={(projectId) => {
            closeSearch();
            onSelectProject(projectId);
          }}
          onOpenFile={(node) => {
            closeSearch();
            handleOpenFile(node);
          }}
          fileSearchAvailable={activeProjectId !== null}
        />
      ) : null}

      {/* HIDDEN, never unmounted, while the search shows results: unmounting
        * the tree would release the explorer session and lose every folder the
        * user expanded. */}
      <div className="flex min-h-0 flex-1 flex-col" hidden={searching}>
        {wide && explorerPane !== null ? (
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
        )}
      </div>

      {wide ? (
        <div className="border-t border-[var(--vex-line)] px-3 py-3">
          <VexTokenCardCompact />
        </div>
      ) : null}

      <footer className="flex flex-col" data-rail-foot>
        {wide ? (
          <div className="flex items-center gap-1 px-3 pt-2">
            <SidebarIconButton
              label={STUDIO_RAIL_SETTINGS_LABEL}
              onClick={() => {
                setShellRoute({ kind: "settings", origin: null, section: null });
              }}
            >
              <IconSettings size={16} />
            </SidebarIconButton>
            <SidebarIconButton
              label={studioThemeToggleLabel(theme === "chronos" ? "light" : "dark")}
              onClick={() => {
                setThemePreference(theme === "chronos" ? "celeris" : "chronos");
              }}
            >
              {theme === "chronos" ? (
                <IconThemeLight size={16} />
              ) : (
                <IconThemeDark size={16} />
              )}
            </SidebarIconButton>
          </div>
        ) : null}
        <SidebarProfile sidebarOpen={wide} />
      </footer>
    </aside>
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
