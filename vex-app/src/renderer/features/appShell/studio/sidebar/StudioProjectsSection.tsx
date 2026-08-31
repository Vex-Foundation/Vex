/**
 * The PROJECTS list inside the Studio sidebar: the rows, their action menu, and
 * the four states the list itself can be in.
 *
 * Split out of `StudioSidebar.tsx` because it owns a different thing: the rail
 * owns the column (collapse choreography, the sections, the footer), this owns
 * the query and one row's interaction. Neither file has to be read to review the
 * other.
 *
 * ## The row menu is LIVE (B4b)
 *
 * Settings, Repair and Delete publish a project-dialog intent
 * (`projects/project-dialog-intent.ts`); the dialogs themselves are mounted by
 * `StudioProjectDialogs` in the Studio centre. This section does not own a
 * dialog and must not: the welcome screen in the other column raises the same
 * requests, and two owners would be two dialogs answering one click.
 *
 * The menu is `Menu`'s own list, so it keeps the keyboard path B4a built - the
 * ellipsis is a real button with `aria-haspopup`, and the items are reachable
 * without a pointer. The three ids below are the whole interaction surface.
 */

import { useCallback, useState, type JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { IconArchive, IconEllipsis, IconWarning } from "../../../../components/icons/index.js";
import { DotmSquare3 } from "../../../../components/ui/dotm-square-3.js";
import { Menu, type MenuEntry } from "../../../../components/ui/menu.js";
import { RailGroup } from "../../../../components/ui/rail-list.js";
import { ListPlaceholder } from "../../SessionRows/ListPlaceholder.js";
import {
  openProjectDelete,
  openProjectRepair,
  openProjectSettings,
} from "../projects/index.js";
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

/**
 * The three row actions. Ids are the contract between this list and the
 * dispatch below; a `MenuEntry` carries no handler of its own.
 */
const ROW_MENU_ENTRIES: readonly MenuEntry[] = [
  { id: "settings", label: STUDIO_PROJECT_MENU_SETTINGS },
  { id: "repair", label: STUDIO_PROJECT_MENU_REPAIR },
  { id: "delete", label: STUDIO_PROJECT_MENU_DELETE, danger: true },
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

  /**
   * One dispatch for the three items, and the menu closes on EVERY selection
   * including an id it does not know.
   *
   * A menu left open behind a modal would still be in the DOM, still focusable,
   * and would outlive the dialog it launched. Closing first, publishing second,
   * so the dialog's own focus management runs against a settled tree.
   */
  const onMenuSelect = useCallback(
    (projectId: string, itemId: string): void => {
      closeMenu();
      if (itemId === "settings") openProjectSettings(projectId);
      else if (itemId === "repair") openProjectRepair(projectId);
      else if (itemId === "delete") openProjectDelete(projectId);
    },
    [closeMenu],
  );

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
                onSelect={(itemId) => onMenuSelect(project.id, itemId)}
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
