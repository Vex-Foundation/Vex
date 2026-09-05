/**
 * ONE project row on the Studio welcome hero.
 *
 * VS Code's Getting Started recent list is the shape (`gettingStarted.ts`,
 * `buildRecentlyOpenedList`): a row is the project's NAME as the control, with
 * its location beside it as detail, and opening it is the row's only job. The
 * state slot is deepseek's `ToolRow` grammar - a 16px dot per row, error and
 * warning rows carrying their first line in words.
 *
 * WHY IT IS NOT `ProjectRailRow`. The rail row answers "which project is
 * selected, and what may it touch" for a 256px rail: an icon, a name, a
 * permission pill, a drift glyph, and a hover-revealed action cluster. The hero
 * answers a different question - "which of these do I open, and is anything
 * wrong with it" - in a full-width column with room for the folder, and its
 * rows have no actions and no selection. Both read the SAME drift decision
 * (`worstDriftState`) and the SAME sentences (`studio-copy.ts`), so there is
 * still exactly one answer to "is this project drifted"; only the presentation
 * differs.
 */

import type { JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { Pill } from "../../../../components/ui/pill.js";
import { StateDot } from "../../../../components/ui/state-dot.js";
import { worstDriftState } from "../sidebar/project-row-model.js";
import {
  projectDriftLabel,
  projectPermissionTag,
  STUDIO_DRIFT_SENTENCES,
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
  const drift = worstDriftState(project);
  const driftSentence = drift === null ? null : STUDIO_DRIFT_SENTENCES[drift];
  // A drift state the copy table does not cover would otherwise paint a warning
  // dot with no words behind it; the clean label is the honest fallback and the
  // table is total over the states that ARE drift.
  const drifted = driftSentence !== undefined && driftSentence !== null;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-vex-project-drift={drifted ? (drift ?? undefined) : undefined}
      className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <StateDot
        state={drifted ? "warning" : "done"}
        size={10}
        label={
          drifted
            ? projectDriftLabel(project.name, driftSentence)
            : STUDIO_WELCOME_ROW_CLEAN_LABEL
        }
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] leading-[20px] text-ink-primary">
          {project.name}
        </span>
        {/* The folder, which the product shows nowhere else outside Settings.
          * A project is a folder on disk, so "which folder" is the fact that
          * tells two similarly named projects apart. */}
        <span className="block truncate font-mono text-[11px] leading-[16px] text-ink-tertiary">
          {project.displayPath}
        </span>
      </span>
      <Pill
        size="sm"
        variant={project.permission === "full" ? "caution" : "neutral"}
      >
        {projectPermissionTag(project.permission)}
      </Pill>
    </button>
  );
}
