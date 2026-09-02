/**
 * The single owner of the `projects` domain error vocabulary (Vex Studio
 * stage P).
 *
 * Every factory here produces a redacted, user-actionable `VexError` that names
 * the REAL cause and the remedy. None of them collapses into "unexpected
 * error": a Studio project failure is always one of a small set of concrete
 * situations, and telling the user which one is the difference between a
 * fixable state and a dead end.
 *
 * Redaction rules applied here:
 *   - absolute filesystem paths never reach the renderer. Root mismatch is
 *     described in terms the user can act on ("the configured projects root")
 *     while the concrete paths go only to the main-process log.
 *   - slugs, project names, and family names DO appear: they are values the
 *     user typed or chose, not secrets, and a refusal that hides them is not
 *     actionable.
 */

import type { VexError } from "@shared/ipc/result.js";

function projectsError(
  code: Extract<VexError["code"], `projects.${string}`>,
  message: string,
  options: {
    readonly correlationId: string;
    readonly retryable: boolean;
    readonly userActionable: boolean;
  },
): VexError {
  return {
    code,
    domain: "projects",
    message,
    retryable: options.retryable,
    userActionable: options.userActionable,
    redacted: true,
    correlationId: options.correlationId,
  };
}

/**
 * The configured projects root no longer matches the one recorded in
 * `studio_settings` at first creation. Fails closed: `projects.root_path` is
 * relative to the recorded root, so continuing would silently point every
 * existing project at a different place on disk.
 */
export function projectsRootChangedError(correlationId: string): VexError {
  return projectsError(
    "projects.root_changed",
    "The configured Vex Studio projects root has changed since your projects were created, " +
      "so their folders can no longer be located. Restore the previous projects root in " +
      "config.json (or remove the projectsRoot override to return to the default). " +
      "Moving the projects root is a separate migration, not an automatic move.",
    { correlationId, retryable: false, userActionable: true },
  );
}

/** The projects root could not be created or resolved on disk. */
export function projectsRootUnavailableError(correlationId: string): VexError {
  return projectsError(
    "projects.root_unavailable",
    "The Vex Studio projects folder could not be opened or created. " +
      "Check that the location exists, is a folder rather than a file, and is writable, then try again.",
    { correlationId, retryable: true, userActionable: true },
  );
}

/**
 * `<root>/<slug>` already exists. The create path claims the directory with an
 * exclusive `mkdir` and never replaces or renames an existing path, so this is
 * a refusal rather than an overwrite.
 */
export function projectSlugTakenError(
  slug: string,
  correlationId: string,
): VexError {
  return projectsError(
    "projects.slug_taken",
    `A folder named "${slug}" already exists in your Vex Studio projects. ` +
      "Nothing was changed. Choose a different project name.",
    { correlationId, retryable: false, userActionable: true },
  );
}

/** The project name derived no usable slug (for example, punctuation only). */
export function projectNameUnusableError(correlationId: string): VexError {
  return {
    code: "validation.invalid_input",
    domain: "projects",
    message:
      "That project name contains no letters or digits, so no folder name can be derived from it. " +
      "Include at least one Latin letter or digit.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

/**
 * The project is being deleted, so this operation was declined (B0).
 *
 * Deliberately NOT `projects.not_found`: the project still exists, the user's
 * own delete is what refused this, and saying "no such project" would be both
 * untrue and confusing next to a list that still shows it.
 */
export function projectDeletingError(correlationId: string): VexError {
  return projectsError(
    "projects.deleting",
    "This project is being deleted, so Vex did not run that. Nothing was changed.",
    { correlationId, retryable: false, userActionable: true },
  );
}

/**
 * The slug belongs to a tombstone whose cleanup has not finished (B0).
 *
 * RETRYABLE, and that is the point: the remover still owns that folder, and
 * claiming it now would mean the cleanup deleting the NEW project's files.
 * Cleanup is a durable obligation with two recovery owners, so waiting works.
 */
export function projectSlugCleanupPendingError(correlationId: string): VexError {
  return projectsError(
    "projects.slug_cleanup_pending",
    "A project with this name was just deleted and Vex is still removing its "
      + "files. Nothing was created. Try again in a moment.",
    { correlationId, retryable: true, userActionable: true },
  );
}

export function projectNotFoundError(correlationId: string): VexError {
  return projectsError(
    "projects.not_found",
    "That project no longer exists. Refresh your project list.",
    { correlationId, retryable: false, userActionable: true },
  );
}

/** Optimistic-concurrency miss on a scope edit. Nothing was written. */
export function projectScopeConflictError(
  expected: number,
  actual: number,
  correlationId: string,
): VexError {
  return projectsError(
    "projects.scope_conflict",
    `The project settings changed while you were editing them (you were editing version ${expected}, ` +
      `the project is now at version ${actual}). Nothing was saved. Reopen the settings and apply your change again.`,
    { correlationId, retryable: false, userActionable: true },
  );
}

/**
 * A stored wallet selection no longer resolves to the same address. Fails
 * closed rather than handing back a selection that would let a later signing
 * path use a key the user never chose.
 */
export function projectWalletDriftError(
  family: "evm" | "solana",
  correlationId: string,
): VexError {
  const label = family === "evm" ? "EVM" : "Solana";
  return projectsError(
    "projects.wallet_drift",
    `The ${label} wallet saved for this project no longer matches the wallet in your inventory: ` +
      "it was removed, or re-imported over a different key. The project was left unchanged. " +
      "Select the wallet again in project settings to confirm which key it should use.",
    { correlationId, retryable: false, userActionable: true },
  );
}

/**
 * The backing-session mirror update did not affect exactly one row.
 *
 * The project row and its backing session are created together in one
 * transaction and the session id is `UNIQUE` on `projects`, so a mirror UPDATE
 * guarded by `id = $backing AND scope = 'vex_studio'` must match exactly one
 * row. Zero means the backing session is gone or is no longer a Studio session;
 * more than one is impossible without a corrupt schema. Either way the edit is
 * rolled back: a project whose session no longer mirrors its permission and
 * wallet scope would let a session-keyed gate decide with stale authority.
 *
 * Stage P implements no repair for this state, and the message says so rather
 * than inviting a retry that would fail the same way.
 */
export function projectBackingSessionIntegrityError(
  correlationId: string,
): VexError {
  return projectsError(
    "projects.backing_session_integrity",
    "This project's underlying agent session is missing or no longer belongs to the project, " +
      "so its permission and wallet settings could not be kept in step. " +
      "The project was NOT changed. Retrying will not help: the project's stored state is inconsistent " +
      "and needs to be repaired, which this version of Vex Studio cannot do. " +
      "Create a new project and keep this one unopened until repair is available.",
    { correlationId, retryable: false, userActionable: true },
  );
}

/**
 * Renderer-supplied wallet id that is not in the inventory. Mirrors the
 * sessions path: main resolves ids server-side and fails closed on any id it
 * does not own.
 */
export function projectInvalidWalletError(correlationId: string): VexError {
  return {
    code: "wallets.invalid_selection",
    domain: "projects",
    message: "The selected wallet is not in your wallet inventory. Nothing was changed.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}
