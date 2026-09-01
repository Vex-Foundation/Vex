/**
 * Assembling the `{ project, render, refreshFailure }` answer that `create`,
 * `updateScope` and `repairFiles` all return.
 *
 * Two rules live here, and they are the two that were previously re-decided by
 * each handler:
 *
 *   1. A COMMITTED CHANGE IS NEVER REPORTED AS A FAILURE. The project row is
 *      already stored when the render starts, so a render that could not run
 *      returns the project plus a NAMED run failure. It does not turn the whole
 *      call into an error, and it does not borrow an artifact-level warning to
 *      say so.
 *   2. THE ROW IS RE-READ AFTER THE RENDER. A completed render advances the
 *      durable last-rendered marker, and the row the caller committed was read
 *      before that. Returning it would put "Vex has never completed a full pass
 *      over this project's files" directly above the report of the pass that
 *      just completed. When the re-read itself fails, the committed row is
 *      returned WITH `refreshFailure` set, because a row that may be one field
 *      behind is worth more to the user than an error that discards the render
 *      report as well.
 */

import type { Result, VexError } from "@shared/ipc/result.js";
import type { ProjectDto, ProjectRenderEnvelope } from "@shared/schemas/projects.js";
import type {
  StudioRenderOutcome,
  StudioRunFailure,
} from "@shared/schemas/studio-installer.js";
import type { StudioRenderTrigger } from "../../studio/installer.js";
import { getProject } from "../../database/projects/read.js";
import { withProjectFiles } from "./files.js";

/**
 * The outcome to report when the render never produced one.
 *
 * The run's real `VexError` code travels in `runFailure.code` rather than being
 * logged and dropped: "your projects root moved", "this project is being
 * deleted" and "the database is unavailable" have different fixes, and the
 * caller is the one who has to choose between them.
 */
export function renderFailureOutcome(
  error: VexError,
  scopeVersion: number,
  trigger: StudioRenderTrigger,
): StudioRenderOutcome {
  const runFailure: StudioRunFailure = {
    kind: "render_failed",
    code: error.code,
    // Already sanitized by the error's owner: main never puts a path, a cause
    // or a provider payload into a public message.
    detail: error.message,
    correlationId: error.correlationId,
  };
  return {
    scopeVersion,
    completed: false,
    trigger,
    artifacts: [],
    warnings: [],
    runFailure,
  };
}

/**
 * Re-read the project and assemble the envelope.
 *
 * @param committed - the row as the caller's own committed transaction left it.
 *   Returned verbatim (with its disk status attached) when the re-read fails.
 * @param render - what the reconciliation reported.
 * @param correlationId - this request's id, carried into a refresh failure.
 */
export async function buildProjectRenderEnvelope(
  committed: ProjectDto,
  render: StudioRenderOutcome,
  correlationId: string,
): Promise<ProjectRenderEnvelope> {
  const fresh: Result<ProjectDto | null> = await getProject(
    committed.id,
    correlationId,
  );

  if (!fresh.ok) {
    return {
      project: await withProjectFiles(committed, correlationId),
      render,
      refreshFailure: {
        kind: "project_refresh_failed",
        code: fresh.error.code,
        detail: fresh.error.message,
        correlationId,
      },
    };
  }

  if (fresh.data === null) {
    // The row was committed and is gone: a delete landed between the two
    // statements. Saying "not found" as the whole call's error would be false
    // about what this call did, so the committed row is returned and the
    // disappearance is named.
    return {
      project: await withProjectFiles(committed, correlationId),
      render,
      refreshFailure: {
        kind: "project_refresh_failed",
        code: "projects.not_found",
        detail:
          "Vex could not re-read this project after writing its files. It may have been deleted from another window.",
        correlationId,
      },
    };
  }

  return {
    project: await withProjectFiles(fresh.data, correlationId),
    render,
    refreshFailure: null,
  };
}
