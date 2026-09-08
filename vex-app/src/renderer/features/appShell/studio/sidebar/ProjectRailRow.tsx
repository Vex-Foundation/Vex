/** Sidebar project selection with persistent permission and drift state. */

import type { JSX, ReactNode } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { IconFolderClose, IconWarning } from "../../../../components/icons/index.js";
import { RailRow } from "../../../../components/ui/rail-list.js";
import { StateDot } from "../../../../components/ui/state-dot.js";
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
  actionsPinned,
}: ProjectRailRowProps): JSX.Element {
  const drift = worstDriftState(project);
  const driftSentence = drift === null ? null : STUDIO_DRIFT_SENTENCES[drift];
  const driftDescription = driftSentence == null ? null : projectDriftLabel(project.name, driftSentence);
  const description = [projectPermissionDescription(project.permission), driftDescription]
    .filter(Boolean).join(" ");
  const driftMark = driftDescription === null ? null : (
    <span
      role="img"
      aria-label={driftDescription}
      data-vex-project-drift={drift ?? undefined}
      className="flex items-center text-warning"
    >
      <IconWarning size={13} />
    </span>
  );

  return (
    <RailRow
      selected={selected}
      collapsed={collapsed}
      icon={<IconFolderClose size={16} />}
      // The active dot marks the SELECTED project and nothing else. It is not a
      // liveness light: this stage has no per-project run state to report, and
      // a dot that meant two things would report neither.
      leading={selected ? <StateDot state="done" size={8} /> : undefined}
      title={project.name}
      persistentTrailing={
        <span className="flex items-center gap-1">
          <ProjectPermissionState permission={project.permission} />
          {driftMark}
        </span>
      }
      collapsedOverlay={
        <span className="flex items-center gap-0.5">
          <ProjectPermissionState permission={project.permission} collapsed />
          {driftMark}
        </span>
      }
      description={description}
      actions={actions}
      actionsPinned={actionsPinned}
      onSelect={onSelect}
      label={project.name}
    />
  );
}
