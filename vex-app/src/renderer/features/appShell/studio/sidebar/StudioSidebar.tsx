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
 * The section structure follows VS Code's Explorer viewlet, where the tree is
 * wrapped by a view pane whose title is the root folder's name and whose header
 * carries the tree's own actions (`explorerView.ts`). Ours does the same: the
 * EXPLORER disclosure names the active project and contains `ExplorerHeader`
 * plus `ExplorerTree`.
 *
 * ## Two things about the EXPLORER section
 *
 * It is HIDDEN with the `hidden` attribute, not unmounted, whenever a project
 * is active: unmounting the tree would release its explorer session, drop its
 * watcher and throw away every folder the user expanded. Without ANY active
 * project there is nothing to render, so it is absent - there is no session to
 * preserve in that case.
 *
 * ## Search
 *
 * The rail search filters the PROJECT rows by name. It does not search the
 * explorer: the tree owns its own type-ahead over its own rows, and one field
 * driving two different search models would produce results the user cannot
 * attribute to either.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { FileNode } from "@shared/schemas/files.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import {
  IconClose,
  IconFolderOpen,
  IconHome,
  IconPanelLeft,
  IconPlus,
  IconSearch,
} from "../../../../components/icons/index.js";
import { RailRow, RailSearchField } from "../../../../components/ui/rail-list.js";
import { DisclosureRow } from "../../../../components/ui/disclosure-row.js";
import { useCollapseChoreography } from "../../../../lib/useCollapseChoreography.js";
import { useQuietScrollbars } from "../../../../lib/useQuietScrollbars.js";
import { useScrollbarVisibility } from "../../../../lib/useScrollbarVisibility.js";
import { cn } from "../../../../lib/utils.js";
import { useProjects } from "../../../../lib/api/projects.js";
import { SidebarHomeSigil } from "../../SidebarHomeSigil.js";
import { SidebarProfile } from "../../SidebarProfile.js";
import { SidebarIconButton } from "../../SessionRows.js";
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
  STUDIO_EXPLORER_SECTION,
  STUDIO_PROJECTS_SECTION,
  STUDIO_NEW_PROJECT_LABEL,
  STUDIO_SEARCH_CLOSE_LABEL,
  STUDIO_SEARCH_OPEN_LABEL,
  STUDIO_SEARCH_PLACEHOLDER,
  STUDIO_SIDEBAR_COLLAPSE_LABEL,
  STUDIO_SIDEBAR_EXPAND_LABEL,
  STUDIO_SIDEBAR_LABEL,
  STUDIO_WELCOME_ROW_LABEL,
} from "../studio-copy.js";
import { filterProjectsByName } from "./project-row-model.js";
import { StudioProjectsSection } from "./StudioProjectsSection.js";

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

  const columnRef = useRef<HTMLElement | null>(null);
  const { quiet, onPointerEnter, onPointerLeave } = useQuietScrollbars(columnRef);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollbarVisibility(listScrollRef);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect((): void => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Section open state is COMPONENT-LOCAL on purpose: the plan persists no
  // Studio layout preference in this stage, and a disclosure the store
  // remembered would be a persisted slot the whitelist does not carry.
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(true);

  const allProjects: readonly ProjectDto[] = useMemo(
    () => (query.data !== undefined && query.data.ok ? query.data.data : []),
    [query.data],
  );
  const visibleProjects = useMemo(
    () => (searchOpen ? filterProjectsByName(allProjects, searchText) : allProjects),
    [allProjects, searchOpen, searchText],
  );
  const activeProject =
    activeProjectId === null
      ? null
      : (allProjects.find((project) => project.id === activeProjectId) ?? null);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchText("");
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

  const retry = useCallback((): void => {
    void query.refetch();
  }, [query]);

  // The header's actions act on the session the TREE holds. `peek` reads it
  // without taking a reference, which is what keeps the header a sibling of the
  // tree rather than a second owner of its lifetime.
  const activeRegistry = explorerRegistry ?? windowExplorerRegistry;
  const refreshExplorer = useCallback((): void => {
    if (activeProjectId === null) return;
    activeRegistry.peek(activeProjectId)?.refreshNow();
  }, [activeRegistry, activeProjectId]);
  const collapseExplorer = useCallback((): void => {
    if (activeProjectId === null) return;
    activeRegistry.peek(activeProjectId)?.collapseAll();
  }, [activeRegistry, activeProjectId]);

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
          className={cn("flex items-center", wide ? "gap-0.5" : "flex-col gap-0.5")}
          data-rail-control
        >
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
            onChange={setSearchText}
            onClose={closeSearch}
            placeholder={STUDIO_SEARCH_PLACEHOLDER}
            label={STUDIO_SEARCH_PLACEHOLDER}
            closeLabel={STUDIO_SEARCH_CLOSE_LABEL}
            inputRef={(el) => {
              searchInputRef.current = el;
            }}
            icon={<IconSearch size={14} />}
            closeIcon={<IconClose size={12} />}
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

      <div
        ref={listScrollRef}
        className="vex-scroll vex-scroll-overlay min-h-0 flex-1 overflow-y-auto overflow-x-clip px-2 py-3"
        data-rail-control
      >
        <DisclosureRow
          icon={<IconFolderOpen size={14} />}
          title={STUDIO_PROJECTS_SECTION}
          open={projectsOpen}
          expandable
          expandOnRowClick
          onToggle={() => setProjectsOpen((open) => !open)}
        >
          <StudioProjectsSection
            projects={visibleProjects}
            activeProjectId={activeProjectId}
            collapsed={!wide}
            isLoading={query.isLoading}
            hasError={query.data !== undefined && !query.data.ok}
            onRetry={retry}
            onSelect={onSelectProject}
            searching={searchOpen && searchText.trim().length > 0}
          />
        </DisclosureRow>

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

        {activeProject !== null ? (
          <div className="mt-2" hidden={!wide}>
            <DisclosureRow
              icon={<IconFolderOpen size={14} />}
              title={STUDIO_EXPLORER_SECTION}
              open={explorerOpen}
              expandable
              expandOnRowClick
              onToggle={() => setExplorerOpen((open) => !open)}
            >
              <div className="mt-1 flex h-64 flex-col overflow-hidden rounded-lg border border-line-3">
                {/* The pane titles itself with the ROOT PROJECT'S NAME, as
                  * VS Code's explorer view pane does. */}
                <ExplorerHeader
                  title={activeProject.name}
                  onRefresh={refreshExplorer}
                  onCollapseAll={collapseExplorer}
                />
                <ExplorerTree
                  projectId={activeProject.id}
                  onOpenFile={handleOpenFile}
                  registry={activeRegistry}
                  className="min-h-0 flex-1"
                />
              </div>
            </DisclosureRow>
          </div>
        ) : null}
      </div>

      {wide ? (
        <div className="border-t border-[var(--vex-line)] px-3 py-3">
          <VexTokenCardCompact />
        </div>
      ) : null}

      <footer className="flex flex-col" data-rail-foot>
        <SidebarProfile sidebarOpen={wide} />
      </footer>
    </aside>
  );
}
