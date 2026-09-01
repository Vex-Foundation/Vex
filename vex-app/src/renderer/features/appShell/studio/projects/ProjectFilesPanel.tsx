/**
 * WHAT THE FILES IN THIS PROJECT ARE RIGHT NOW, per artifact.
 *
 * ## Why this exists beside `RenderOutcomePanel`
 *
 * The two answer DIFFERENT questions from different wire shapes, and merging
 * them would mean inventing the half whichever call did not return.
 *
 *   - `RenderOutcomePanel` renders a `StudioRenderOutcome`: what ONE run DID
 *     (`written`, `removed`, `refused`, `drift_blocked`). `create`,
 *     `updateScope` and `repairFiles` all return one.
 *   - This renders a `StudioFilesStatus`: what each artifact IS on disk
 *     (`current`, `drifted`, `missing`, `stale`, `unsupported`, `unreadable`),
 *     which is the answer for a project nobody has just reconciled, and the
 *     second half of the answer for one somebody has.
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
  PROJECT_FILES_LIST_LABEL,
  PROJECT_FILES_NEVER_RENDERED,
  PROJECT_FILES_REPAIR_ACTION,
  PROJECT_FILES_TITLE,
} from "./projects-copy.js";

export interface ProjectFilesPanelProps {
  readonly files: StudioFilesStatus;
  /**
   * Raise the repair intent for the project these files belong to.
   *
   * Optional because the panel is also rendered INSIDE the repair dialog, where
   * the confirm button is the action and a second one pointing back at the same
   * dialog would be a loop. A surface that has no repair to offer passes
   * nothing and the affordance is not rendered.
   */
  readonly onRepair?: (() => void) | undefined;
}

export function ProjectFilesPanel({
  files,
  onRepair,
}: ProjectFilesPanelProps): JSX.Element {
  const neverRendered = files.lastRenderedScopeVersion === null;
  // Offered only where it would DO something: a repair rewrites what Vex
  // maintains, so a panel whose every row is `current` and whose project has
  // had a full pass has nothing to repair and says nothing about it.
  const wantsRepair =
    neverRendered ||
    files.artifacts.some(
      (artifact) => ARTIFACT_STATE_WANTS_ATTENTION[artifact.state],
    );
  const repairAction =
    onRepair !== undefined && wantsRepair ? (
      // Same shape as the terminal surface's inline "Restore terminals" row:
      // the repair sits beside the sentence that asks for it, not in a menu in
      // another column behind this dialog.
      <button
        type="button"
        onClick={onRepair}
        data-vex-project-files-repair=""
        className="self-start rounded px-1 font-medium text-accent-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {PROJECT_FILES_REPAIR_ACTION}
      </button>
    ) : null;

  return (
    <section className="flex flex-col gap-3" data-vex-project-files="">
      <div className="flex flex-col gap-1">
        <h3 className="vex-eyebrow">{PROJECT_FILES_TITLE}</h3>
        {neverRendered ? (
          <p role="status" className="flex items-start gap-1.5 text-xs text-warning">
            <IconWarning size={13} className="mt-0.5 shrink-0" />
            <span>{PROJECT_FILES_NEVER_RENDERED}</span>
          </p>
        ) : null}
        {repairAction}
      </div>

      {files.artifacts.length === 0 ? (
        <p className="text-xs text-ink-tertiary">{PROJECT_FILES_EMPTY}</p>
      ) : (
        <ul
          aria-label={PROJECT_FILES_LIST_LABEL}
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
