/**
 * Owner of the Vex Studio projects-root contract (stage P).
 *
 * ONE place decides where projects live and whether that place is still the
 * place they were created in. Everything else - the create path, the reads, the
 * scope edits - asks this module and fails closed on its answer.
 *
 * The contract:
 *
 *   1. The configured root is `config.json`'s absolute `projectsRoot` override
 *      when present, otherwise `DEFAULT_PROJECTS_ROOT` (`~/Vex/projects`).
 *      `resolveProjectsRootPath` (mirrored in `src/config/paths.ts`) owns that
 *      choice; this module owns making it real on disk.
 *   2. `resolveProjectsRoot()` creates the directory when absent and returns
 *      its REALPATH. Realpath, not the configured string, is the value every
 *      confinement check compares against, so a symlinked root is compared as
 *      the place it actually points to.
 *   3. `studio_settings.projects_root` records that realpath at first project
 *      creation. `anchorProjectsRoot` performs that first write and the
 *      comparison as ONE locked statement (the create path); the read paths use
 *      `assertProjectsRootUnchanged`, which compares under a share lock. Both
 *      fail closed with `projects.root_changed` on a mismatch, because
 *      `projects.root_path` is RELATIVE to the recorded root: continuing would
 *      silently re-home every project.
 *
 * Root migration is deliberately not implemented here. Moving a workspace full
 * of user files is an explicit workflow with its own consent, not a side effect
 * of editing a config field.
 */

import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { loadConfig } from "@config/store.js";
import { log } from "../logger/index.js";
import { resolveProjectsRootPath } from "../paths/config-dir.js";
import {
  projectsRootChangedError,
  projectsRootUnavailableError,
} from "./project-errors.js";

/** Read the configured root without touching the filesystem. */
export function configuredProjectsRoot(): string {
  return resolveProjectsRootPath(loadConfig().projectsRoot);
}

/**
 * Ensure the projects root exists and return its realpath.
 *
 * `mkdir` is recursive here and ONLY here: the root itself is a container the
 * app may create on the user's behalf. Individual project directories are
 * claimed non-recursively and exclusively (see `main/database/projects/
 * create.ts`), which is what makes an occupied slug a refusal instead of a
 * silent reuse.
 */
export async function resolveProjectsRoot(
  correlationId: string,
): Promise<Result<string, VexError>> {
  const configured = configuredProjectsRoot();
  try {
    await mkdir(configured, { recursive: true });
    return ok(await realpath(configured));
  } catch (cause) {
    // Structural log only: the path is main-process information and never
    // rides the public error.
    log.warn(
      `[studio:projects-root] could not prepare projects root correlationId=${correlationId}`,
      cause,
    );
    return err(projectsRootUnavailableError(correlationId));
  }
}

interface StudioSettingsRow {
  projects_root: string;
}

/** Same comparison for both root primitives: realpath equality, not string equality. */
function rootsAgree(recorded: string, resolvedRoot: string): boolean {
  return path.resolve(recorded) === path.resolve(resolvedRoot);
}

/**
 * Anchor the projects root and prove it is still ours, in ONE statement.
 *
 * This is the WRITE-side primitive, used by the create path as the first
 * statement after `BEGIN`. A plain `SELECT` followed by an
 * `INSERT ... ON CONFLICT DO NOTHING` could not give this guarantee: between
 * the two statements a concurrent first-creation can commit a different root,
 * and the `DO NOTHING` insert would then silently accept it.
 *
 * The upsert closes that gap. On the first creation it inserts our root. On
 * every later creation the conflict path takes a ROW LOCK on `studio_settings`
 * id 1 and `RETURNING` yields the STORED root under that lock, so no concurrent
 * transaction can change the anchor between this check and the rest of ours.
 * `DO UPDATE SET updated_at = studio_settings.updated_at` is a deliberate no-op
 * on the value: the anchor is immutable, and the assignment exists only because
 * `RETURNING` needs an `UPDATE` branch to return the existing row.
 *
 * Returns the anchored root on agreement, `projects.root_changed` otherwise.
 * The caller owns the `ROLLBACK`.
 */
export async function anchorProjectsRoot(
  client: Client,
  resolvedRoot: string,
  correlationId: string,
): Promise<Result<string, VexError>> {
  const anchored = await client.query<StudioSettingsRow>(
    `INSERT INTO studio_settings (id, projects_root) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET updated_at = studio_settings.updated_at
     RETURNING projects_root`,
    [resolvedRoot],
  );
  const row = anchored.rows[0];
  if (row === undefined) {
    // Unreachable: the statement either inserts or updates, and both branches
    // return a row. Kept as a fail-closed guard rather than an assertion.
    log.error(
      `[studio:projects-root] the projects-root anchor returned no row correlationId=${correlationId}`,
    );
    return err(projectsRootUnavailableError(correlationId));
  }
  if (!rootsAgree(row.projects_root, resolvedRoot)) {
    log.warn(
      `[studio:projects-root] configured root differs from the anchored root correlationId=${correlationId}`,
    );
    return err(projectsRootChangedError(correlationId));
  }
  return ok(row.projects_root);
}

/**
 * Compare the resolved root with the one recorded in `studio_settings`.
 *
 * This is the READ-side primitive, for the paths that do NOT write the anchor
 * (the reads and the scope edit). Returns `ok(null)` when no root has been
 * recorded yet (no project has ever been created). Returns `ok(recorded)` when
 * they agree. Fails with `projects.root_changed` when they disagree.
 *
 * `FOR SHARE` is not decoration: it holds the anchor row against a concurrent
 * first-creation for the remainder of the caller's transaction, so the root
 * proved here is still the root when the caller acts on it. Without it the
 * check would be a TOCTOU gap even though it runs on the caller's connection.
 *
 * Takes an explicit `Client` so it runs INSIDE the caller's transaction: a
 * check on a separate connection could not take a lock the caller holds.
 */
export async function assertProjectsRootUnchanged(
  client: Client,
  resolvedRoot: string,
  correlationId: string,
): Promise<Result<string | null, VexError>> {
  const recorded = await client.query<StudioSettingsRow>(
    "SELECT projects_root FROM studio_settings WHERE id = 1 FOR SHARE",
  );
  const row = recorded.rows[0];
  if (row === undefined) return ok(null);
  if (!rootsAgree(row.projects_root, resolvedRoot)) {
    log.warn(
      `[studio:projects-root] configured root differs from the recorded root correlationId=${correlationId}`,
    );
    return err(projectsRootChangedError(correlationId));
  }
  return ok(row.projects_root);
}

/**
 * Resolve `<root>/<slug>` and prove it stays inside the root.
 *
 * The slug alphabet already makes traversal impossible (see
 * `project-slug.ts`), so this is defence in depth against a future caller that
 * reaches this function with a value from somewhere else. It compares against
 * the REALPATH of the root, and it refuses a path that is exactly the root.
 */
export function resolveProjectDirectory(
  resolvedRoot: string,
  slug: string,
): string | null {
  const candidate = path.resolve(resolvedRoot, slug);
  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (!candidate.startsWith(prefix)) return null;
  // Exactly one segment below the root: a project directory is never nested.
  if (path.dirname(candidate) !== path.resolve(resolvedRoot)) return null;
  return candidate;
}

/**
 * Display-only rendering of a project's location for a settings label.
 *
 * Collapses the user's home directory to `~` so a screenshot or a support
 * bundle does not carry an identity-revealing absolute path. This is TEXT, not
 * a capability: no handler accepts it back.
 */
export function formatProjectDisplayPath(
  resolvedRoot: string,
  slug: string,
  homeDirectory: string,
): string {
  const full = path.join(resolvedRoot, slug);
  const home = path.resolve(homeDirectory);
  if (full === home) return "~";
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  if (full.startsWith(prefix)) {
    return `~${path.sep}${full.slice(prefix.length)}`;
  }
  return full;
}
