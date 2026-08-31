/**
 * The PROJECTS list inside the Studio sidebar: the rows, their action menu, and
 * the four states the list itself can be in.
 *
 * Split out of `StudioSidebar.tsx` because it owns a different thing: the rail
 * owns the column (collapse choreography, the sections, the footer), this owns
 * the query and one row's interaction. Neither file has to be read to review the
 * other.
 *
 * ## The row menu is rendered and DISABLED, not omitted
 *
 * Settings, Repair and Delete are stage B4b's handlers. Rendering the menu with
 * three `aria-disabled` items is the honest state: the keyboard path to the row
 * actions exists and is testable now, so B4b adds handlers rather than building
 * an interaction surface from scratch. There is no roadmap copy on them - a
 * disabled item says "not now" by being disabled, and a "coming soon" label
 * would be a promise this repo does not make in UI.
 */

import { useCallback, useState, type JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { IconArchive, IconEllipsis, IconWarning } from "../../../../components/icons/index.js";
import { DotmSquare3 } from "../../../../components/ui/dotm-square-3.js";
import { Menu, type MenuEntry } from "../../../../components/ui/menu.js";
import { RailGroup } from "../../../../components/ui/rail-list.js";
import { ListPlaceholder } from "../../SessionRows/ListPlaceholder.js";
import {
  projectRowMenuLabel,
  STUDIO_PROJECT_MENU_DELETE,
  STUDIO_PROJECT_MENU_REPAIR,
  STUDIO_PROJECT_MENU_SETTINGS,
  STUDIO_PROJECTS_EMPTY,
  STUDIO_PROJECTS_ERROR,
  STUDIO_PROJECTS_LOADING,
  STUDIO_PROJECTS_RETRY,
  STUDIO_PROJECTS_SEARCH_EMPTY,
  STUDIO_PROJECTS_SECTION,
} from "../studio-copy.js";
import { ProjectRailRow } from "./ProjectRailRow.js";

/** The three row actions, disabled until B4b owns their handlers. */
const ROW_MENU_ENTRIES: readonly MenuEntry[] = [
  { id: "settings", label: STUDIO_PROJECT_MENU_SETTINGS, disabled: true },
  { id: "repair", label: STUDIO_PROJECT_MENU_REPAIR, disabled: true },
  { id: "delete", label: STUDIO_PROJECT_MENU_DELETE, disabled: true, danger: true },
];

export interface StudioProjectsSectionProps {
  readonly projects: readonly ProjectDto[];
  readonly activeProjectId: string | null;
  readonly collapsed: boolean;
  readonly isLoading: boolean;
  /** A settled read that failed, or a transport failure. */
  readonly hasError: boolean;
  readonly onRetry: () => void;
  readonly onSelect: (projectId: string) => void;
  /** True while a search query is narrowing the list (changes the empty copy). */
  readonly searching: boolean;
}

export function StudioProjectsSection({
  projects,
  activeProjectId,
  collapsed,
  isLoading,
  hasError,
  onRetry,
  onSelect,
  searching,
}: StudioProjectsSectionProps): JSX.Element {
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpenMenuProjectId(null), []);

  if (isLoading) {
    return (
      <ListPlaceholder
        sidebarOpen={!collapsed}
        text={STUDIO_PROJECTS_LOADING}
        icon={
          <DotmSquare3
            size={26}
            dotSize={4}
            color="var(--vex-accent)"
            ariaLabel={STUDIO_PROJECTS_LOADING}
          />
        }
      />
    );
  }

  if (hasError) {
    // NEVER a blank rail. The line states what failed and offers the one action
    // that can fix it; `role="status"` announces it without stealing focus.
    return (
      <div role="status" className="flex flex-col items-start gap-2 p-3">
        <span className="flex items-center gap-2 text-[12px] leading-[18px] text-warning">
          <IconWarning size={14} />
          {!collapsed ? STUDIO_PROJECTS_ERROR : null}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded px-1 text-[12px] leading-[18px] text-ink-secondary underline underline-offset-2 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          {STUDIO_PROJECTS_RETRY}
        </button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <ListPlaceholder
        sidebarOpen={!collapsed}
        text={searching ? STUDIO_PROJECTS_SEARCH_EMPTY : STUDIO_PROJECTS_EMPTY}
        icon={<IconArchive size={18} />}
      />
    );
  }

  return (
    // `collapsed` here suppresses RailGroup's own eyebrow and gives the group
    // an `aria-label` instead: the visible "PROJECTS" title is the enclosing
    // DisclosureRow's, and printing it twice would give the section two
    // headings that a screen reader reads back-to-back. The ROW collapse state
    // is a separate prop and rides on each row below.
    <RailGroup
      title={STUDIO_PROJECTS_SECTION}
      collapsed
      headingId="studio-sidebar-projects"
    >
      {projects.map((project) => (
        <li key={project.id}>
          <ProjectRailRow
            project={project}
            selected={project.id === activeProjectId}
            collapsed={collapsed}
            onSelect={() => onSelect(project.id)}
            actionsPinned={openMenuProjectId === project.id}
            actions={
              <Menu
                open={openMenuProjectId === project.id}
                portal
                onClose={closeMenu}
                // Every item is disabled, so nothing can be selected; the
                // handler exists because the primitive requires one and B4b
                // replaces this whole prop set.
                onSelect={closeMenu}
                items={ROW_MENU_ENTRIES}
                anchor={
                  <button
                    type="button"
                    aria-label={projectRowMenuLabel(project.name)}
                    aria-haspopup="menu"
                    aria-expanded={openMenuProjectId === project.id}
                    onClick={() =>
                      setOpenMenuProjectId((current) =>
                        current === project.id ? null : project.id,
                      )
                    }
                    className="flex h-6 w-6 items-center justify-center rounded text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                  >
                    <IconEllipsis size={14} />
                  </button>
                }
              />
            }
          />
        </li>
      ))}
    </RailGroup>
  );
}
