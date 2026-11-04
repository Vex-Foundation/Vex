/**
 * ONE project row in the Studio sidebar, in H3 cells (our approved Studio
 * plate, docs/design/H3-DESKTOP.md section 4.9): 36 high, the name at 15 in
 * ink set 24 in, the open project on the selected row's fade, and at the
 * right a status square and RUNNING while a shell of the project's is live
 * (`workspace/project-live.ts`), as the chats list's tags are drawn
 * (section 1.4).
 *
 * The plate draws no access tag on a row: the open project's access is the
 * header's line ("Studio · Full access") and the console's This project, and
 * every row keeps its permission sentence as its accessible description and
 * its tooltip, so the standing authority is still said where it is asked.
 *
 * Drift is a state, so it is a fill with its words: the ink hatch swatch
 * (concerned) named by the drift sentence, the same sentence the row's
 * description, the welcome row and the explorer's file mark read.
 *
 * The action cluster (the sidebar's ellipsis menu) sits beside the select
 * control, never inside it, and shows on hover, focus, or while its menu is
 * open. The rail has no project rows: its Projects and files key opens these
 * in a drawer (`StudioSidebar`).
 */

import type { JSX, ReactNode } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { Swatch } from "../../../../components/ui/swatch.js";
import { Tooltip } from "../../../../components/ui/tooltip.js";
import { cn } from "../../../../lib/utils.js";
import {
  projectDriftLabel,
  projectPermissionDescription,
  STUDIO_DRIFT_SENTENCES,
  STUDIO_PROJECT_RUNNING_LABEL,
} from "../studio-copy.js";
import { useProjectLive } from "../workspace/project-live.js";
import { worstDriftState } from "./project-row-model.js";

export interface ProjectRailRowProps {
  readonly project: ProjectDto;
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** The row's action cluster (the sidebar's ellipsis menu); omitted elsewhere. */
  readonly actions?: ReactNode;
  readonly actionsPinned?: boolean;
}

export function ProjectRailRow({
  project,
  selected,
  onSelect,
  actions,
  actionsPinned = false,
}: ProjectRailRowProps): JSX.Element {
  const running = useProjectLive(project.id);
  const drift = worstDriftState(project);
  const driftSentence = drift === null ? null : STUDIO_DRIFT_SENTENCES[drift];
  const driftDescription =
    driftSentence == null ? null : projectDriftLabel(project.name, driftSentence);
  const description = [projectPermissionDescription(project.permission), driftDescription]
    .filter(Boolean)
    .join(" ");
  const driftMark =
    driftDescription === null ? null : (
      <span
        role="img"
        aria-label={driftDescription}
        data-vex-project-drift={drift ?? undefined}
        className="vex-st-proj__drift"
      >
        <Swatch state="concerned" size={10} />
      </span>
    );

  return (
    <div
      className="vex-st-proj"
      data-selected={selected || undefined}
      data-running={running || undefined}
      data-rail-row-pinned={actionsPinned || undefined}
    >
      <Tooltip label={description}>
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          aria-description={description}
          className="vex-st-proj__select"
        >
          <span className="vex-st-proj__t truncate">{project.name}</span>
          {/* A space the flex row does not draw, so the name reads "vex-core
            * Running" rather than one run-on word. */}
          {" "}
          <span className="vex-st-proj__state" data-rail-persistent-state>
            {driftMark}
            {running ? (
              <span className="vex-st-proj__run" data-vex-project-running="">
                <Swatch state="done" size={6} className="text-running-mark" />
                <span>{STUDIO_PROJECT_RUNNING_LABEL}</span>
              </span>
            ) : null}
          </span>
        </button>
      </Tooltip>
      {actions === undefined ? null : (
        <div
          data-rail-actions
          className={cn("vex-st-proj__acts shrink-0", actionsPinned && "vex-st-proj__acts--pinned")}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
