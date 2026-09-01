/**
 * ONE project row, in the house rail grammar (`components/ui/rail-list.tsx`).
 *
 * The sidebar and the Studio welcome screen render THE SAME row rather than two
 * that look alike: they show the same facts about the same object, and a second
 * implementation would be a second answer to "is this project drifted".
 *
 * Trailing content is always-visible metadata, deliberately: the permission tag
 * says whether an agent in this project may touch anything outside it, and a
 * fact with that weight is not a hover reveal. The drift badge sits beside it
 * for the same reason. `RailRow` fades the trailing slot while the actions
 * cluster reveals, which is the house behaviour and is correct here too: the
 * actions only appear on hover or focus, and the tag is back the moment they go.
 */

import type { JSX, ReactNode } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { IconFolderClose, IconWarning } from "../../../../components/icons/index.js";
import { Pill } from "../../../../components/ui/pill.js";
import { RailRow } from "../../../../components/ui/rail-list.js";
import { StateDot } from "../../../../components/ui/state-dot.js";
import {
  projectDriftLabel,
  projectPermissionTag,
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
      trailing={
        <span className="flex items-center gap-1">
          <Pill size="sm" variant={project.permission === "full" ? "caution" : "neutral"}>
            {projectPermissionTag(project.permission)}
          </Pill>
          {driftSentence !== undefined && driftSentence !== null ? (
            <span
              role="img"
              aria-label={projectDriftLabel(project.name, driftSentence)}
              data-vex-project-drift={drift ?? undefined}
              className="flex items-center text-warning"
            >
              <IconWarning size={13} />
            </span>
          ) : null}
        </span>
      }
      actions={actions}
      actionsPinned={actionsPinned}
      onSelect={onSelect}
      label={project.name}
    />
  );
}
