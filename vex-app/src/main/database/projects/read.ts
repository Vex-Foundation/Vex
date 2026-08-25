/**
 * Project reads (Vex Studio stage P).
 *
 * Both reads join `projects` with `project_wallets` - the authoritative wallet
 * table - and never read the backing session's mirrored wallet columns.
 *
 * The backing session is NOT returned by any agent-mode session API and this
 * module does nothing to make it so: `main/database/sessions/read.ts` filters
 * `scope = 'vex_app'`, and a project's backing session carries
 * `scope = 'vex_studio'`. That exclusion is a property of the existing session
 * reads, which stage P deliberately leaves untouched.
 *
 * Every read asserts the projects root has not changed. A read is where a moved
 * root is first noticed, and reporting it here is what stops the user from
 * opening a project whose folder is no longer where the row says it is.
 */

import { homedir } from "node:os";
import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { log } from "../../logger/index.js";
import {
  projectWalletDriftError,
} from "../../studio/project-errors.js";
import {
  assertProjectsRootUnchanged,
  formatProjectDisplayPath,
  resolveProjectsRoot,
} from "../../studio/projects-root.js";
import { dbError, withClient } from "../sessions/connection.js";
import {
  PROJECT_ROW_COLUMNS,
  PROJECT_WALLET_ROW_COLUMNS,
  projectWallets,
  toProjectDto,
  type ProjectRow,
  type ProjectWalletRow,
} from "./mappers.js";

/**
 * Build DTOs for a set of project rows, verifying each project's wallet
 * selection against the inventory. Returns the first drift as a failure: a read
 * that silently dropped a drifted selection would be a read that hides a
 * changed signing key.
 */
export function buildProjectDtos(
  rows: ReadonlyArray<ProjectRow>,
  walletRows: ReadonlyArray<ProjectWalletRow>,
  resolvedRoot: string,
  correlationId: string,
): Result<ProjectDto[], VexError> {
  const out: ProjectDto[] = [];
  for (const row of rows) {
    const projection = projectWallets(
      walletRows.filter((w) => w.project_id === row.id),
    );
    if (projection.kind === "drift") {
      return err(projectWalletDriftError(projection.family, correlationId));
    }
    if (projection.kind === "missing_family") {
      log.error(
        `[projects-db] project is missing its ${projection.family} wallet row ` +
          `projectId=${row.id} correlationId=${correlationId}`,
      );
      return dbError(
        `project ${row.id} is missing its ${projection.family} project_wallets row`,
      );
    }
    out.push(
      toProjectDto(
        row,
        projection.wallets,
        formatProjectDisplayPath(resolvedRoot, row.slug, homedir()),
      ),
    );
  }
  return ok(out);
}

/** Read one project. `ok(null)` for an unknown id (the caller held a stale view). */
export async function getProject(
  projectId: string,
  correlationId: string,
): Promise<Result<ProjectDto | null, VexError>> {
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return rootOutcome;
  const resolvedRoot = rootOutcome.data;

  return withClient(async (client: Client) => {
    try {
      const rootCheck = await assertProjectsRootUnchanged(
        client,
        resolvedRoot,
        correlationId,
      );
      if (!rootCheck.ok) return rootCheck;

      const rows = await client.query<ProjectRow>(
        `SELECT ${PROJECT_ROW_COLUMNS} FROM projects WHERE id = $1`,
        [projectId],
      );
      const row = rows.rows[0];
      if (row === undefined) return ok(null);

      const walletRows = await client.query<ProjectWalletRow>(
        `SELECT ${PROJECT_WALLET_ROW_COLUMNS} FROM project_wallets WHERE project_id = $1`,
        [projectId],
      );
      const dtos = buildProjectDtos(
        [row],
        walletRows.rows,
        resolvedRoot,
        correlationId,
      );
      if (!dtos.ok) return dtos;
      return ok(dtos.data[0] ?? null);
    } catch (cause) {
      return dbError("getProject query failed", cause);
    }
  });
}

/**
 * List every project, newest first.
 *
 * Bounded by the number of workspaces a person creates by hand, which is why
 * there is no cursor here: unlike a transcript or an activity feed, this
 * collection does not grow on its own. If projects ever become machine-created,
 * this read gains pagination before that lands, not after.
 */
export async function listProjects(
  correlationId: string,
): Promise<Result<ProjectDto[], VexError>> {
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return rootOutcome;
  const resolvedRoot = rootOutcome.data;

  return withClient(async (client: Client) => {
    try {
      const rootCheck = await assertProjectsRootUnchanged(
        client,
        resolvedRoot,
        correlationId,
      );
      if (!rootCheck.ok) return rootCheck;

      const rows = await client.query<ProjectRow>(
        `SELECT ${PROJECT_ROW_COLUMNS} FROM projects ORDER BY created_at DESC`,
      );
      if (rows.rows.length === 0) return ok([]);
      const walletRows = await client.query<ProjectWalletRow>(
        `SELECT ${PROJECT_WALLET_ROW_COLUMNS} FROM project_wallets`,
      );
      return buildProjectDtos(
        rows.rows,
        walletRows.rows,
        resolvedRoot,
        correlationId,
      );
    } catch (cause) {
      return dbError("listProjects query failed", cause);
    }
  });
}
