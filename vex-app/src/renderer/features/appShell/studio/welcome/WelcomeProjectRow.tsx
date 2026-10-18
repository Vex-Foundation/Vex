/**
 * ONE project row on the Studio welcome (docs/design/R3-MINIMAL.md section
 * 9.5 and the Studio welcome reference): a state swatch, the name in 14 / 500,
 * the outlined "Full access" tag, and under it the folder in JetBrains Mono 12
 * muted; a quiet rule under every row. At the right, "Repair" in blue when a
 * Vex file drifted, then the row's ellipsis menu.
 *
 * State by fill with its words: a clean project is the solid fill, named
 * "Vex's files in this project are as Vex wrote them" for assistive
 * technology (no visible word says it); a drifted one is the ink hatch with
 * the drift sentence visible beside the name, so the swatch carries no second
 * copy of it.
 *
 * WHY IT IS NOT `ProjectRailRow`. The sidebar row answers "which project is
 * selected" in a 264px column; this one answers "which of these do I open, and
 * is anything wrong with it" in a full-width column with room for the folder.
 * Both read the SAME drift decision (`worstDriftState`) and the SAME sentences
 * (`studio-copy.ts`), and the menu raises the SAME three requests as the
 * sidebar's (`PROJECT_ROW_MENU_ENTRIES`), so there is one answer to each.
 */

import { useState, type JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { LineMore } from "../../../../components/icons/line/index.js";
import { Menu } from "../../../../components/ui/menu.js";
import { Swatch } from "../../../../components/ui/swatch.js";
import { Tooltip } from "../../../../components/ui/tooltip.js";
import { ProjectPermissionState } from "../ProjectPermissionState.js";
import { worstDriftState } from "../sidebar/project-row-model.js";
import {
  PROJECT_ROW_MENU_ENTRIES,
  runProjectRowAction,
} from "../sidebar/StudioProjectsSection.js";
import {
  projectDriftLabel,
  projectPermissionDescription,
  projectRowMenuLabel,
  STUDIO_DRIFT_SENTENCES,
  STUDIO_PROJECT_MENU_REPAIR,
  STUDIO_WELCOME_ROW_CLEAN_LABEL,
} from "../studio-copy.js";

export interface WelcomeProjectRowProps {
  readonly project: ProjectDto;
  readonly onSelect: () => void;
}

export function WelcomeProjectRow({
  project,
  onSelect,
}: WelcomeProjectRowProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const drift = worstDriftState(project);
  const driftSentence = drift === null ? null : STUDIO_DRIFT_SENTENCES[drift];
  // A drift state the copy table does not cover would otherwise paint a
  // concerned fill with no words behind it; the clean label is the honest
  // fallback and the table is total over the states that ARE drift.
  const drifted = driftSentence !== undefined && driftSentence !== null;
  const description = [
    projectPermissionDescription(project.permission),
    drifted ? projectDriftLabel(project.name, driftSentence) : null,
  ].filter(Boolean).join(" ");

  return (
    <div
      data-vex-project-drift={drifted ? (drift ?? undefined) : undefined}
      className="flex min-w-0 items-center gap-3.5 border-b border-rule-quiet"
    >
      <Tooltip label={description}>
        <button
          type="button"
          onClick={onSelect}
          aria-description={description}
          className="group min-w-0 flex-1 py-2.5 text-left hover:bg-interactive-hover"
        >
          <span className="flex min-w-0 items-center gap-2">
            {drifted ? (
              <Swatch state="concerned" size={10} />
            ) : (
              <Swatch state="done" size={10} label={STUDIO_WELCOME_ROW_CLEAN_LABEL} />
            )}
            <span className="min-w-0 truncate text-[14px] leading-[20px] font-medium text-ink-primary">
              {project.name}
            </span>
            <ProjectPermissionState permission={project.permission} />
            {drifted ? (
              <span className="min-w-0 truncate text-[12.5px] leading-[20px] text-ink-tertiary">
                {driftSentence}
              </span>
            ) : null}
          </span>
          {/* The folder, which the product shows nowhere else outside Settings.
            * A project is a folder on disk, so "which folder" is the fact that
            * tells two similarly named projects apart. */}
          <span className="vex-num ml-[18px] block truncate font-mono text-[12px] leading-[18px] text-ink-tertiary">
            {project.displayPath}
          </span>
        </button>
      </Tooltip>
      {drifted ? (
        <button
          type="button"
          aria-label={`${STUDIO_PROJECT_MENU_REPAIR} ${project.name}`}
          onClick={() => runProjectRowAction(project.id, "repair")}
          className="shrink-0 text-[13px] font-medium text-accent-primary hover:underline hover:underline-offset-[3px]"
        >
          {STUDIO_PROJECT_MENU_REPAIR}
        </button>
      ) : null}
      <Menu
        open={menuOpen}
        portal
        onClose={() => setMenuOpen(false)}
        onSelect={(itemId) => {
          setMenuOpen(false);
          runProjectRowAction(project.id, itemId);
        }}
        items={PROJECT_ROW_MENU_ENTRIES}
        anchor={
          <button
            type="button"
            aria-label={projectRowMenuLabel(project.name)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-6 w-6 shrink-0 items-center justify-center text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary"
          >
            <LineMore size={16} />
          </button>
        }
      />
    </div>
  );
}
