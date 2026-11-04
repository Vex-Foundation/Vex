/**
 * The PROJECTS list inside the Studio sidebar, in H3 cells (our approved
 * Studio plate, docs/design/H3-DESKTOP.md section 4.9): PROJECTS as a 44 head
 * (13, 600, caps, ink, set 24 in, the chats column's CHATS register), the
 * rows on the 36 pitch, "Show all N" under the first three, their action
 * menu, and the four states the list itself can be in, each said in the
 * sidebar's sentence register (a failure in ink with Retry underlined).
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
import { LineMore } from "../../../../components/icons/line/index.js";
import { Menu, type MenuEntry } from "../../../../components/ui/menu.js";
import { Swatch } from "../../../../components/ui/swatch.js";
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
  STUDIO_PROJECTS_SECTION,
  STUDIO_SHOW_FEWER_PROJECTS,
  studioShowAllProjectsLabel,
} from "../studio-copy.js";
import { ProjectRailRow } from "./ProjectRailRow.js";

/**
 * The three row actions. Ids are the contract between this list and the
 * dispatch below; a `MenuEntry` carries no handler of its own. Exported with
 * the dispatch so the welcome's rows raise the same three requests.
 */
export const PROJECT_ROW_MENU_ENTRIES: readonly MenuEntry[] = [
  { id: "settings", label: STUDIO_PROJECT_MENU_SETTINGS },
  { id: "repair", label: STUDIO_PROJECT_MENU_REPAIR },
  { id: "delete", label: STUDIO_PROJECT_MENU_DELETE, danger: true },
];

/** Publish the dialog intent a row menu item names; unknown ids do nothing. */
export function runProjectRowAction(projectId: string, itemId: string): void {
  if (itemId === "settings") openProjectSettings(projectId);
  else if (itemId === "repair") openProjectRepair(projectId);
  else if (itemId === "delete") openProjectDelete(projectId);
}

/**
 * Rows shown before the list offers the rest.
 *
 * The column's height is shared with the explorer pane below, and an
 * unbounded project list would push the tree out of the column entirely
 * (rule 05: every growing list has an explicit bound). Three rows, as the
 * plate draws them, plus a control that says how many exist - nothing is
 * hidden, and one click shows everything.
 */
export const STUDIO_PROJECTS_COLLAPSED_ROWS = 3;

/** The group head's id, for the section's `aria-labelledby`. */
const PROJECTS_HEADING_ID = "studio-sidebar-projects";


export interface StudioProjectsSectionProps {
  readonly projects: readonly ProjectDto[];
  readonly activeProjectId: string | null;
  readonly isLoading: boolean;
  /** A settled read that failed, or a transport failure. */
  readonly hasError: boolean;
  readonly onRetry: () => void;
  readonly onSelect: (projectId: string) => void;
  /** Show every row rather than the first {@link STUDIO_PROJECTS_COLLAPSED_ROWS}. */
  readonly showAll: boolean;
  readonly onShowAllChange: (showAll: boolean) => void;
}

export function StudioProjectsSection({
  projects,
  activeProjectId,
  isLoading,
  hasError,
  onRetry,
  onSelect,
  showAll,
  onShowAllChange,
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
      runProjectRowAction(projectId, itemId);
    },
    [closeMenu],
  );

  // PROJECTS, the 44 head, names the list in every state, the way CHATS
  // names the chats. The words stay in sentence case; the class sets caps.
  const head = (
    <h2 id={PROJECTS_HEADING_ID} className="vex-st-head">
      {STUDIO_PROJECTS_SECTION}
    </h2>
  );

  if (isLoading) {
    return (
      <>
        {head}
        <ListPlaceholder
          sidebarOpen
          register="sentence"
          text={STUDIO_PROJECTS_LOADING}
          icon={<Swatch state="listening" size={10} />}
        />
      </>
    );
  }

  if (hasError) {
    // NEVER a blank list. The line states what failed and offers the one
    // action that can fix it; `role="status"` announces it without stealing
    // focus.
    return (
      <>
        {head}
        <div role="status" className="vex-st-fail">
          <span className="vex-st-fail__line">
            <Swatch state="error" size={10} />
            {STUDIO_PROJECTS_ERROR}
          </span>
          <button type="button" onClick={onRetry} className="vex-st-link">
            {STUDIO_PROJECTS_RETRY}
          </button>
        </div>
      </>
    );
  }

  if (projects.length === 0) {
    return (
      <>
        {head}
        <ListPlaceholder sidebarOpen register="sentence" text={STUDIO_PROJECTS_EMPTY} />
      </>
    );
  }

  const bounded =
    showAll || projects.length <= STUDIO_PROJECTS_COLLAPSED_ROWS
      ? projects
      : projects.slice(0, STUDIO_PROJECTS_COLLAPSED_ROWS);

  return (
    <section aria-labelledby={PROJECTS_HEADING_ID} className="vex-st-projects">
      {head}
      <ol className="vex-st-rows">
        {bounded.map((project) => (
          <li key={project.id}>
            <ProjectRailRow
              project={project}
              selected={project.id === activeProjectId}
              onSelect={() => onSelect(project.id)}
              actionsPinned={openMenuProjectId === project.id}
              actions={
                <Menu
                  open={openMenuProjectId === project.id}
                  portal
                  onClose={closeMenu}
                  onSelect={(itemId) => onMenuSelect(project.id, itemId)}
                  items={PROJECT_ROW_MENU_ENTRIES}
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
                      className="vex-st-dots"
                    >
                      <LineMore size={14} />
                    </button>
                  }
                />
              }
            />
          </li>
        ))}
        {/* The bound, said out loud, with the whole count in it ("Show all
          * 4"), on its own 32 row. */}
        {projects.length <= STUDIO_PROJECTS_COLLAPSED_ROWS ? null : (
          <li>
            <button
              type="button"
              onClick={() => onShowAllChange(!showAll)}
              className="vex-st-more"
            >
              {showAll
                ? STUDIO_SHOW_FEWER_PROJECTS
                : studioShowAllProjectsLabel(projects.length)}
            </button>
          </li>
        )}
      </ol>
    </section>
  );
}
