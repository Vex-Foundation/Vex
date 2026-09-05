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
 *      fail closed with `projects.root_changed` on a proven mismatch (and with
 *      `projects.root_unverifiable` when equality cannot be proven), because
 *      `projects.root_path` is RELATIVE to the recorded root: continuing would
 *      silently re-home every project.
 *
 * Root migration is deliberately not implemented here. Moving a workspace full
 * of user files is an explicit workflow with its own consent, not a side effect
 * of editing a config field.
 */

import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { loadConfig } from "@config/store.js";
import { log } from "../logger/index.js";
import { resolveProjectsRootPath } from "../paths/config-dir.js";
import {
  projectsRootChangedError,
  projectsRootUnavailableError,
  projectsRootUnverifiableError,
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

/**
 * What the recorded root and the resolved root are to each other.
 *
 * THREE outcomes, not two, and the third is the reason this is not a boolean:
 * "these are not the same directory" and "Vex could not establish whether these
 * are the same directory" have different remedies and must not share a refusal.
 */
type RootIdentityVerdict = "same" | "different" | "unprovable";

/**
 * Compare two projects roots by FILESYSTEM IDENTITY, not by spelling.
 *
 * WHY NOT A STRING COMPARE. `path.resolve(a) === path.resolve(b)` answers a
 * question about text. The question that matters is whether the folder holding
 * the user's projects is the folder their `projects.root_path` values are
 * relative to, and on the two platforms Vex ships to besides Linux, one folder
 * has many spellings: `C:\Users\Ada\Vex\projects` and
 * `c:\users\ada\Vex\projects` are the same directory on NTFS, and
 * `/Users/Ada/Vex/projects` and `/users/ada/Vex/projects` are the same
 * directory on a default (case-insensitive) APFS volume. A user who edits
 * `config.json` by hand, or an installer that writes the drive letter in the
 * other case, would be told their projects root "changed" and locked out of
 * every project they own.
 *
 * The filesystem itself answers the question: `dev`+`ino` is the identity two
 * paths either share or do not, on every platform, with no case rule of our own
 * and no `process.platform` branch. This is the SAME primitive
 * `captureDirectoryChain` uses in the installer, for the same reason.
 *
 * THE BYTE-EQUAL FAST PATH IS NOT AN OPTIMISATION. Identical resolved strings
 * name one path, so the identity comparison is already decided and taking it
 * without a syscall means this check cannot start failing because a `stat`
 * failed on a path that is trivially its own equal. Only a spelling difference
 * costs two `stat` calls.
 *
 * FAILS SAFE. A `stat` that throws (the recorded root was moved or deleted, or
 * is not readable) and an identity the filesystem does not supply (`dev` and
 * `ino` both zero, which Node reports on some Windows network and FAT volumes
 * where no file index exists) both mean the same thing: equality could not be
 * PROVEN. That is `unprovable`, and every caller turns it into a refusal.
 * Nothing here ever reports `same` on an unproven pair.
 */
async function compareRoots(
  recorded: string,
  resolvedRoot: string,
): Promise<RootIdentityVerdict> {
  const recordedPath = path.resolve(recorded);
  const resolvedPath = path.resolve(resolvedRoot);
  if (recordedPath === resolvedPath) return "same";

  let recordedIdentity;
  let resolvedIdentity;
  try {
    [recordedIdentity, resolvedIdentity] = await Promise.all([
      stat(recordedPath),
      stat(resolvedPath),
    ]);
  } catch {
    return "unprovable";
  }

  // No file index, no identity. Refusing beats guessing on the one comparison
  // that decides whether every project row still points at real folders.
  if (recordedIdentity.dev === 0 && recordedIdentity.ino === 0) return "unprovable";
  if (resolvedIdentity.dev === 0 && resolvedIdentity.ino === 0) return "unprovable";

  return recordedIdentity.dev === resolvedIdentity.dev
    && recordedIdentity.ino === resolvedIdentity.ino
    ? "same"
    : "different";
}

/**
 * Turn a non-`same` verdict into the refusal that names the real situation.
 *
 * `context` is a short structural word for the log line only; no path ever
 * reaches the returned error.
 */
function rootDisagreementError(
  verdict: "different" | "unprovable",
  context: "anchored" | "recorded",
  correlationId: string,
): VexError {
  if (verdict === "unprovable") {
    log.warn(
      `[studio:projects-root] could not prove the configured root is the ${context} root `
        + `correlationId=${correlationId}`,
    );
    return projectsRootUnverifiableError(correlationId);
  }
  log.warn(
    `[studio:projects-root] configured root differs from the ${context} root `
      + `correlationId=${correlationId}`,
  );
  return projectsRootChangedError(correlationId);
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
 * Returns the anchored root on agreement, `projects.root_changed` when the two
 * roots are proven to be different directories, and
 * `projects.root_unverifiable` when the comparison could not be proven at all
 * (see `compareRoots`).
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
  const verdict = await compareRoots(row.projects_root, resolvedRoot);
  if (verdict !== "same") {
    return err(rootDisagreementError(verdict, "anchored", correlationId));
  }
  return ok(row.projects_root);
}

/**
 * Compare the resolved root with the one recorded in `studio_settings`.
 *
 * This is the READ-side primitive, for the paths that do NOT write the anchor
 * (the reads and the scope edit). Returns `ok(null)` when no root has been
 * recorded yet (no project has ever been created). Returns `ok(recorded)` when
 * they agree. Fails with `projects.root_changed` when they are proven to be
 * different directories, and with `projects.root_unverifiable` when equality
 * could not be proven (see `compareRoots`).
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
  const verdict = await compareRoots(row.projects_root, resolvedRoot);
  if (verdict !== "same") {
    return err(rootDisagreementError(verdict, "recorded", correlationId));
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
 *
 * THE PREFIX COMPARISON IS BYTE-EXACT AND STAYS THAT WAY, on every platform.
 * This is a CONTAINMENT check, and containment is not equality: the two have
 * opposite safe failures. `compareRoots` above may not refuse a root that is
 * genuinely the user's, so it asks the filesystem for identity. This check may
 * not ACCEPT a path that is not genuinely inside the root, so it takes the
 * cheapest comparison that can only ever be wrong in the refusing direction. A
 * case-insensitive prefix here would accept `/root/PROJECTS/x` as being inside
 * `/root/projects` - true on NTFS and on a default APFS volume, and FALSE on
 * ext4, on a case-sensitive APFS volume (which macOS still offers and which
 * ships on some developer machines), and on any case-sensitive mount attached
 * to a Windows box. There is no `process.platform` branch either: the platform
 * a path is EVALUATED on does not tell you the case behaviour of the VOLUME the
 * path is on. The cost of this decision is a false refusal on a case-different
 * spelling; the cost of the other decision is a write outside the project.
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
 * Stands in for a root Vex could not prove sits under the user's home
 * directory. Deliberately tilde-less: `~` is a promise about WHERE the folder
 * is, and this label exists precisely for the case where that is unknown.
 */
export const PROJECT_DISPLAY_UNKNOWN_ROOT = "<projects root>";

/**
 * Display-only rendering of a project's location for a settings label.
 *
 * THE PROMISE: the returned text never carries an identity-revealing absolute
 * path. It is TEXT, not a capability - no handler accepts it back.
 *
 * Keeping that promise TRUE ON EVERY PLATFORM is what shapes this function.
 * The old version returned the absolute path whenever the home prefix did not
 * match, which made the promise conditional on a string comparison that a
 * case-different home spelling breaks on exactly the two platforms where one
 * directory has many spellings: `C:\Users\Ada` vs `c:\users\ada`,
 * `/Users/Ada` vs `/users/ada`. On those the label silently became
 * `C:\Users\Ada\Vex\projects\app` - the username, in a screenshot, in the one
 * place the JSDoc promised it would not be.
 *
 * So there are exactly two answers here:
 *
 *   - the home prefix is PROVEN by a byte-exact match, and the path collapses
 *     to `~/...`;
 *   - it is not proven - a different spelling, a different volume, a root
 *     genuinely outside the home directory - and the location is named
 *     abstractly as `<projects root>/<slug>`.
 *
 * Note what is NOT done: the containment and equality checks above are left
 * exactly as they are. A display label is not a reason to loosen either one,
 * and this function is not consulted by anything that decides where bytes go.
 *
 * THE COST, stated: a user whose projects root is somewhere unusual (say
 * `/srv/workspaces`) no longer sees that path in the settings label. The label
 * is not the only place the location is discoverable - `config.json` holds the
 * override the user themselves wrote - and a label that leaks a username in a
 * support bundle is the more expensive mistake.
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
  return `${PROJECT_DISPLAY_UNKNOWN_ROOT}${path.sep}${slug}`;
}
