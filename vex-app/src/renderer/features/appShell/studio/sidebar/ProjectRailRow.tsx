/**
 * ONE project row in the Studio body of the left sidebar
 * (docs/design/R3-MINIMAL.md section 4, "Studio"): 34 high, padding 0 10, the
 * name in 14 and the outlined "Full access" tag at the right. The selected
 * project takes the selection wash with its name in blue at 500, the same
 * register as a selected nav or session row; no dot.
 *
 * Drift is a state, so it is a fill with its words: the ink hatch swatch
 * (concerned) named by the drift sentence, the same sentence the row's
 * description, the welcome row and the explorer's file mark read.
 *
 * On the 56px rail the row is a 40 x 40 folder key with the name as its
 * accessible name and tooltip; the full access tag folds to a warning mark.
 * The action cluster (the sidebar's ellipsis menu) sits beside the select
 * control, never inside it, and shows on hover, focus, or while its menu is
 * open.
 */

import type { JSX, ReactNode } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { LineFolder } from "../../../../components/icons/line/index.js";
import { Swatch } from "../../../../components/ui/swatch.js";
import { Tooltip } from "../../../../components/ui/tooltip.js";
import { cn } from "../../../../lib/utils.js";
import { ProjectPermissionState } from "../ProjectPermissionState.js";
import {
  projectDriftLabel,
  projectPermissionDescription,
  STUDIO_DRIFT_SENTENCES,
} from "../studio-copy.js";
import { worstDriftState } from "./project-row-model.js";

export interface ProjectRailRowProps {
  readonly project: ProjectDto;
  readonly selected: boolean;
  readonly collapsed?: boolean;
  readonly onSelect: () => void;
  /** The row's action cluster (the sidebar's ellipsis menu); omitted elsewhere. */
  readonly actions?: ReactNode;
  readonly actionsPinned?: boolean;
}

export function ProjectRailRow({
  project,
  selected,
  collapsed = false,
  onSelect,
  actions,
  actionsPinned = false,
}: ProjectRailRowProps): JSX.Element {
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
  const hasActions = actions !== undefined && !collapsed;

  return (
    <div
      className="vex-st-proj"
      data-selected={selected || undefined}
      data-rail={collapsed || undefined}
      data-rail-row-pinned={actionsPinned || undefined}
    >
      <Tooltip label={description}>
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          aria-label={collapsed ? project.name : undefined}
          aria-description={description}
          className="vex-st-proj__select"
        >
          {collapsed ? (
            <span className="vex-st-proj__key">
              <LineFolder className="vex-ls-nrow__i" />
              <span className="vex-st-proj__overlay">
                <ProjectPermissionState permission={project.permission} collapsed />
                {driftMark}
              </span>
            </span>
          ) : (
            <>
              <span className="vex-st-proj__t truncate">{project.name}</span>
              <span className="vex-st-proj__state" data-rail-persistent-state>
                {driftMark}
                <ProjectPermissionState permission={project.permission} />
              </span>
            </>
          )}
        </button>
      </Tooltip>
      {hasActions ? (
        <div
          data-rail-actions
          className={cn("vex-st-proj__acts shrink-0", actionsPinned && "vex-st-proj__acts--pinned")}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
