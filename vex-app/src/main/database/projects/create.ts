/**
 * Vex Studio project creation - filesystem claim plus one DB transaction.
 *
 * This module is the SINGLE owner of project state creation. There is no
 * engine-side projects repository in stage P: the engine stays unaware that
 * project persistence exists.
 *
 * Ordering, and why it is this way:
 *
 *   1. Wallet ids are resolved to `{id, address}` BEFORE anything is created
 *      (the handler does this, exactly as `main/ipc/sessions/create.ts` does).
 *      An unknown id fails closed with nothing written and no directory
 *      claimed.
 *   2. `<root>/<slug>` is claimed with a NON-RECURSIVE, exclusive `mkdir`.
 *      `EEXIST` is a typed `projects.slug_taken` refusal, never an overwrite
 *      and never a reuse of somebody else's folder. `rename` is not used
 *      anywhere in this path: Node documents that `rename` can overwrite an
 *      existing file, which is precisely the outcome a workspace claim must
 *      never have.
 *   3. The projects-root anchor and the three insert families (backing session,
 *      project, two `project_wallets` rows) happen in ONE transaction, with the
 *      anchor FIRST. `anchorProjectsRoot` writes it on a first creation and
 *      returns the stored value under a row lock otherwise, so a concurrent
 *      first-creation cannot anchor a different root while this transaction is
 *      writing rows whose `root_path` is relative to ours. A crash between the
 *      inserts must not leave a project without its backing session or without
 *      its wallet rows.
 *   4. On DB failure the directory claim is compensated: `rmdir`
 *      NON-RECURSIVELY, so it removes ONLY the empty directory this request
 *      created. If anything landed inside it in the meantime, `rmdir` fails
 *      with ENOTEMPTY, the directory is left alone, and the failure is
 *      reported. Compensation never deletes user content.
 *
 * The filesystem claim happens BEFORE the transaction rather than after,
 * because the reverse order has no safe compensation: a committed project row
 * whose directory could not be created would be a project the user can see and
 * cannot open, and deleting the row would then be a destructive fix for a
 * successful write. Claiming first makes the only compensating action the
 * removal of an empty directory we just made.
 */

import { mkdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  VEX_STUDIO_SESSION_SCOPE,
  type ProjectCreateInput,
  type ProjectDto,
  type StudioAgentId,
} from "@shared/schemas/projects.js";
import { log } from "../../logger/index.js";
import { deriveProjectSlug } from "../../studio/project-slug.js";
import { slugHeldByUnfinishedCleanup } from "./delete.js";
import {
  projectNameUnusableError,
  projectSlugCleanupPendingError,
  projectSlugTakenError,
  projectsRootUnavailableError,
} from "../../studio/project-errors.js";
import {
  anchorProjectsRoot,
  formatProjectDisplayPath,
  resolveProjectDirectory,
  resolveProjectsRoot,
} from "../../studio/projects-root.js";
import { dbError, withClient } from "../sessions/connection.js";
import {
  PROJECT_ROW_COLUMNS,
  toProjectDto,
  type ProjectRow,
  type ProjectWalletRefs,
} from "./mappers.js";

/** Codes for which the claimed directory must be rolled back. */
function isErrnoCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === code
  );
}

/**
 * Insert the backing session for a project.
 *
 * Written here rather than reused from `main/database/sessions/create.ts`
 * BECAUSE that path hard-codes `VEX_APP_SESSION_SCOPE`, and widening it to take
 * a scope parameter would put a Studio concern inside the agent session create
 * path - the one path whose behaviour must stay byte-for-byte unchanged.
 *
 * The row is an ordinary agent session (`mode = 'agent'`) with:
 *   - `scope = 'vex_studio'`, so every agent-mode read (which filters
 *     `scope = 'vex_app'`) ignores it;
 *   - `title` = the project name, so the GLOBAL approvals inbox, which joins
 *     all sessions without a scope filter, shows a useful label instead of an
 *     unnamed row;
 *   - the wallet columns MIRRORED from `project_wallets`. The mirror exists so
 *     session-keyed gates agree with the project; `project_wallets` remains the
 *     authority.
 */
async function insertBackingSession(
  client: Client,
  sessionId: string,
  input: ProjectCreateInput,
  wallets: ProjectWalletRefs,
): Promise<void> {
  await client.query(
    `INSERT INTO sessions
       (id, scope, mode, permission, initial_goal, title,
        selected_evm_wallet_id, selected_evm_wallet_address,
        selected_solana_wallet_id, selected_solana_wallet_address)
     VALUES ($1, $2, 'agent', $3, NULL, $4, $5, $6, $7, $8)`,
    [
      sessionId,
      VEX_STUDIO_SESSION_SCOPE,
      input.permission,
      input.name,
      wallets.evm?.id ?? null,
      wallets.evm?.address ?? null,
      wallets.solana?.id ?? null,
      wallets.solana?.address ?? null,
    ],
  );
}

async function insertProjectRows(
  client: Client,
  ids: { readonly projectId: string; readonly sessionId: string },
  input: ProjectCreateInput,
  slug: string,
  wallets: ProjectWalletRefs,
): Promise<ProjectRow | undefined> {
  const agents: StudioAgentId[] = [...input.agents];
  await client.query(
    `INSERT INTO projects
       (id, name, slug, root_path, permission, backing_session_id, agents)
     VALUES ($1, $2, $3, $3, $4, $5, $6)`,
    [ids.projectId, input.name, slug, input.permission, ids.sessionId, agents],
  );
  // Exactly one row per family, always both, nulls meaning "no selection".
  for (const family of ["evm", "solana"] as const) {
    const ref = wallets[family];
    await client.query(
      `INSERT INTO project_wallets (project_id, family, wallet_id, address)
       VALUES ($1, $2, $3, $4)`,
      [ids.projectId, family, ref?.id ?? null, ref?.address ?? null],
    );
  }
  const read = await client.query<ProjectRow>(
    `SELECT ${PROJECT_ROW_COLUMNS} FROM projects WHERE id = $1`,
    [ids.projectId],
  );
  return read.rows[0];
}

/**
 * Create a project: claim the directory, then write the rows.
 *
 * `walletRefs` MUST already be resolved by the caller. This function never
 * resolves a wallet id itself, so a renderer-supplied address can never reach
 * the database through it.
 */
export async function createProject(
  input: ProjectCreateInput,
  walletRefs: ProjectWalletRefs,
  correlationId: string,
): Promise<Result<ProjectDto, VexError>> {
  const slug = deriveProjectSlug(input.name);
  if (slug === null) return err(projectNameUnusableError(correlationId));

  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return rootOutcome;
  const resolvedRoot = rootOutcome.data;

  const directory = resolveProjectDirectory(resolvedRoot, slug);
  if (directory === null) {
    // Unreachable through the slug alphabet; kept as a fail-closed guard so a
    // future caller cannot widen the input without tripping it.
    log.error(
      `[projects-db] refused a project directory outside the projects root correlationId=${correlationId}`,
    );
    return err(projectsRootUnavailableError(correlationId));
  }

  // THE TOMBSTONE CHECK, BEFORE THE DIRECTORY IS CLAIMED (B0).
  //
  // The partial unique index frees a slug at the DATABASE level as soon as the
  // project is tombstoned, so an insert would succeed. The FILESYSTEM is the
  // problem: a tombstone whose cleanup has not finished still owns that folder,
  // and its remover is going to delete entries from it. Claiming it now would
  // mean the remover deleting the NEW project's files.
  //
  // Retryable, because cleanup is a durable obligation with two recovery owners
  // (the startup sweep and a repeated delete), so waiting actually resolves it.
  const heldByCleanup = await slugHeldByUnfinishedCleanup(slug);
  if (!heldByCleanup.ok) return heldByCleanup;
  if (heldByCleanup.data) {
    return err(projectSlugCleanupPendingError(correlationId));
  }

  // Exclusive claim: no `recursive`, so an existing directory is EEXIST.
  try {
    await mkdir(directory);
  } catch (cause) {
    if (isErrnoCode(cause, "EEXIST")) {
      return err(projectSlugTakenError(slug, correlationId));
    }
    log.warn(
      `[projects-db] could not claim the project directory correlationId=${correlationId}`,
      cause,
    );
    return err(projectsRootUnavailableError(correlationId));
  }

  const outcome = await withClient(async (client) =>
    runCreateTransaction(client, input, slug, walletRefs, resolvedRoot, correlationId),
  );

  if (!outcome.ok) {
    await compensateDirectoryClaim(directory, correlationId);
  }
  return outcome;
}

async function runCreateTransaction(
  client: Client,
  input: ProjectCreateInput,
  slug: string,
  walletRefs: ProjectWalletRefs,
  resolvedRoot: string,
  correlationId: string,
): Promise<Result<ProjectDto, VexError>> {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  try {
    await client.query("BEGIN");
    // FIRST statement of the transaction, and deliberately so: it both writes
    // the anchor on a first creation and returns the stored anchor under a row
    // lock on every later one. Nothing else may be written before the root this
    // project's `root_path` is relative to has been proved to be ours.
    const rootCheck = await anchorProjectsRoot(
      client,
      resolvedRoot,
      correlationId,
    );
    if (!rootCheck.ok) {
      await client.query("ROLLBACK");
      return rootCheck;
    }
    await insertBackingSession(client, sessionId, input, walletRefs);
    const row = await insertProjectRows(
      client,
      { projectId, sessionId },
      input,
      slug,
      walletRefs,
    );
    if (row === undefined) {
      await client.query("ROLLBACK");
      return dbError(`createProject lost row id=${projectId} after INSERT`);
    }
    await client.query("COMMIT");
    return ok(
      toProjectDto(
        row,
        {
          evm: walletRefs.evm,
          solana: walletRefs.solana,
        },
        formatProjectDisplayPath(resolvedRoot, slug, homedir()),
      ),
    );
  } catch (cause) {
    try {
      await client.query("ROLLBACK");
    } catch (rbCause) {
      log.warn("[projects-db] ROLLBACK after createProject failure failed", rbCause);
    }
    // A UNIQUE violation on `slug` means another request committed the same
    // slug between our directory claim and this insert. Report it by name, not
    // as a generic database failure - the user's remedy is a different name.
    if (isErrnoCode(cause, "23505")) {
      return err(projectSlugTakenError(slug, correlationId));
    }
    return dbError("createProject transaction failed", cause);
  }
}

/**
 * Remove ONLY the empty directory this request created.
 *
 * `rmdir` is non-recursive on purpose. If anything was written into the
 * directory between the claim and the failure, `rmdir` raises ENOTEMPTY, we
 * leave it in place, and we record that it was left. Nothing here can delete a
 * pre-existing file, a pre-existing directory, or user content: the only path
 * it is ever given is the one `mkdir` just created exclusively.
 */
async function compensateDirectoryClaim(
  directory: string,
  correlationId: string,
): Promise<void> {
  try {
    await rmdir(directory);
  } catch (cause) {
    log.warn(
      `[projects-db] project directory left in place after a failed create ` +
        `(it is no longer empty, or could not be removed) correlationId=${correlationId}`,
      cause,
    );
  }
}
