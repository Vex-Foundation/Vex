/**
 * WHAT THE FILES IN THIS PROJECT ARE RIGHT NOW, per artifact.
 *
 * ## Why this exists beside `RenderOutcomePanel`
 *
 * The two answer DIFFERENT questions from different wire shapes, and merging
 * them would mean inventing the half whichever call did not return.
 *
 *   - `RenderOutcomePanel` renders a `StudioRenderOutcome`: what ONE run DID
 *     (`written`, `removed`, `refused`, `drift_blocked`). `updateScope` and
 *     `repairFiles` both return one.
 *   - This renders a `StudioFilesStatus`: what each artifact IS on disk
 *     (`current`, `drifted`, `missing`, `stale`, `unsupported`, `unreadable`).
 *     `create` returns a `ProjectDto` and NOTHING ELSE - see
 *     `projectCreateResultSchema` - so a status is the only honest thing the
 *     creator has to show.
 *
 * An earlier draft of this folder projected the status vocabulary into the
 * outcome vocabulary so one panel could serve both. It was deleted: the
 * projection had to answer "did this run write the file" from a shape that does
 * not record it, and it turned `missing` into `refused: io_error`, which tells
 * the user a write failed when no write was attempted. A dialog about someone's
 * repository does not get to guess.
 *
 * Every artifact gets a row including `current`, for the reason
 * `RenderOutcomePanel` states about `unchanged`: a list of only the problems
 * makes "all four files are fine" and "Vex tracks no files here" identical.
 */

import type { JSX } from "react";
import type { StudioFilesStatus } from "@shared/schemas/studio-installer.js";
import { IconWarning } from "../../../../components/icons/index.js";
import { Pill } from "../../../../components/ui/pill.js";
import { agentPresentation } from "./studio-agent-catalogue.js";
import {
  ARTIFACT_KIND_LABELS,
  ARTIFACT_STATE_LABELS,
  ARTIFACT_STATE_SENTENCES,
  ARTIFACT_STATE_WANTS_ATTENTION,
  PROJECT_FILES_EMPTY,
  PROJECT_FILES_NEVER_RENDERED,
  PROJECT_FILES_TITLE,
  PROJECT_OUTCOME_LIST_LABEL,
} from "./projects-copy.js";

export interface ProjectFilesPanelProps {
  readonly files: StudioFilesStatus;
}

export function ProjectFilesPanel({ files }: ProjectFilesPanelProps): JSX.Element {
  return (
    <section className="flex flex-col gap-3" data-vex-project-files="">
      <div className="flex flex-col gap-1">
        <h3 className="vex-eyebrow">{PROJECT_FILES_TITLE}</h3>
        {files.lastRenderedScopeVersion === null ? (
          <p role="status" className="flex items-start gap-1.5 text-xs text-warning">
            <IconWarning size={13} className="mt-0.5 shrink-0" />
            <span>{PROJECT_FILES_NEVER_RENDERED}</span>
          </p>
        ) : null}
      </div>

      {files.artifacts.length === 0 ? (
        <p className="text-xs text-ink-tertiary">{PROJECT_FILES_EMPTY}</p>
      ) : (
        <ul
          aria-label={PROJECT_OUTCOME_LIST_LABEL}
          className="flex flex-col gap-1.5"
          data-vex-file-rows={String(files.artifacts.length)}
        >
          {files.artifacts.map((artifact, index) => {
            const agentName =
              artifact.agentId === null
                ? null
                : agentPresentation(artifact.agentId).displayName;
            const attention = ARTIFACT_STATE_WANTS_ATTENTION[artifact.state];
            return (
              <li
                key={`${artifact.kind}:${artifact.agentId ?? "-"}:${String(index)}`}
                data-vex-artifact-state={artifact.state}
                data-vex-artifact-kind={artifact.kind}
                className="flex flex-col gap-1 rounded-lg border border-line-2 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-xs text-ink-primary">
                      {agentName === null
                        ? ARTIFACT_KIND_LABELS[artifact.kind]
                        : `${ARTIFACT_KIND_LABELS[artifact.kind]} - ${agentName}`}
                    </span>
                    {/* Repo-relative text for a label, never a capability. */}
                    {artifact.path !== null ? (
                      <span className="truncate font-mono text-[10px] text-ink-tertiary">
                        {artifact.path}
                      </span>
                    ) : null}
                  </span>
                  <Pill size="sm" variant={attention ? "caution" : "neutral"}>
                    {ARTIFACT_STATE_LABELS[artifact.state]}
                  </Pill>
                </div>
                <span
                  className={`text-xs ${attention ? "text-warning" : "text-ink-tertiary"}`}
                >
                  {ARTIFACT_STATE_SENTENCES[artifact.state]}
                </span>
                {/* Main's own sanitized explanation, whenever it sent one. */}
                {artifact.detail !== null ? (
                  <span className="text-xs text-ink-tertiary">{artifact.detail}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
