/**
 * PROJECT DELETION, end to end (stage B0).
 *
 * The database transaction in `database/projects/delete.ts` is the authority
 * commit. THIS module is the order of operations around it, and the order is
 * the design:
 *
 *   1. CLOSE ADMISSION. New calls, renders and watcher acquisitions for this
 *      project are refused `project_deleting` from here on.
 *   2. TEAR DOWN REVERSIBLE OBSERVERS. None exist in B0; the step is named so
 *      that whoever adds the first one adds it here rather than discovering
 *      later that deletes never closed it.
 *   3. DRAIN `executingCall` and claimed `dispatch` leases, bounded.
 *      `pendingApproval` leases are NOT drained - they PARK. A parked approval
 *      releases when it is settled, and the settlement that releases it is the
 *      refusal step 4 commits, so draining it first would wait on an event the
 *      wait itself prevents. On a timeout: nothing is written, admission
 *      REOPENS, and the caller is told how many calls are still running.
 *   4. THE TRANSACTION. Refusals, the session tombstone and the project
 *      tombstone, all under the session control lock.
 *   5. ANNOUNCE the refusals (the transaction does this after COMMIT), which is
 *      what releases the parked approvals.
 *   6. CLOSE TERMINALS AND VIEWERS, through the gate's close-hook registry.
 *      B2 registers the terminal domain there; the hooks run only after the
 *      tombstone has committed, and a failing hook never fails the delete.
 *   7. CLEANUP, under the ADMINISTRATIVE token - admission stays permanently
 *      closed for a tombstone, and the token is what lets the remover work
 *      inside a gate that refuses everyone else.
 *
 * ## Cancellation
 *
 * Before `BEGIN`, a cancelled request reopens admission and writes nothing.
 * After `BEGIN`, the transaction runs to a terminal commit or rollback whatever
 * the renderer does: a half-applied authority change is not a thing this app
 * offers, and a detached caller is not a reason to leave one behind.
 *
 * ## Cleanup is a durable obligation, not a best-effort tail
 *
 * It removes only what Vex RECORDED writing (`project_file_provenance`), never
 * a file it cannot prove it owns. It is idempotent, it survives a crash, and it
 * has two recovery owners: the startup repair sweep, and a repeated delete
 * request on an unfinished tombstone. A failure leaves the row `pending` with
 * an incremented attempt count, because the work still needs doing.
 *
 * ## The obligation covers only bytes whose ownership Vex can prove
 *
 * An artifact the user edited is no longer provably Vex's, so NOTHING IS OWED
 * for it. A cleanup whose only non-success outcomes are ownership refusals
 * (`isOwnershipRefusal`: a drifted managed block, a hand-edited generated file,
 * an entry provenance cannot vouch for) is therefore DISCHARGED - `done`, not
 * `pending`. Before this rule, such a run recorded a failure and every
 * subsequent app start re-ran a teardown that would correctly refuse again,
 * incremented the attempt count, and at five attempts raised a sticky notice
 * about a state that was already correct: an eternal retry loop on a right
 * answer.
 *
 * Discharge is never silent. Each kept artifact is in the per-artifact outcome
 * list the delete result carries, and the operator log names them. The kept
 * artifacts' PROVENANCE ROWS ARE CLEARED at the same commit point: the project
 * is gone, and the only purpose of a provenance row - proving ownership for a
 * future rewrite of that artifact - is over.
 *
 * A TRANSIENT failure (an io error, a trash that would not move, a database
 * write that did not land) keeps the old semantics exactly: the row stays
 * pending, the attempt count rises, and the work is retried. A run that mixes
 * the two stays pending, because the transient half still needs doing.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  ProjectDeleteInput,
  ProjectDeleteResult,
  ProjectTrashOutcome,
  StudioArtifactOutcome,
} from "@shared/schemas/projects.js";
import { log } from "../logger/index.js";
import {
  listUnfinishedProjectCleanups,
  markProjectCleanupDone,
  readTombstonedProject,
  recordProjectCleanupFailure,
  tombstoneProject,
  tombstoneRequestedTrash,
  type OwedProjectCleanupState,
} from "../database/projects/delete.js";
import {
  clearArtifactProvenance,
  readArtifactProvenance,
} from "../database/projects/installer-provenance.js";
import { buildStudioTeardownPlan } from "./installer/plan.js";
import { enqueueStudioRender } from "./installer/queue.js";
import {
  isOwnershipRefusal,
  isReconciledArtifact,
  reconcileStudioArtifacts,
} from "./installer/reconcile.js";
import {
  deleteConfinedFile,
  replaceConfinedFile,
} from "./installer/confined-fs.js";
import {
  acquireProjectLease,
  closeProjectAdmission,
  closeProjectResources,
  drainProjectLeases,
  reopenProjectAdmission,
  type ProjectDeletionToken,
} from "./project-lifecycle-gate.js";
import { projectNotFoundError } from "./project-errors.js";
import type { TrashItem } from "./os-trash.js";
import { resolveProjectDirectory, resolveProjectsRoot } from "./projects-root.js";

/**
 * The collaborators this module does not own.
 *
 * Both are DESKTOP-RUNTIME capabilities on an otherwise pure
 * database-plus-filesystem path, and naming them as dependencies is what keeps
 * `electron` out of this module's import graph. See `os-trash.ts` and
 * `pty-host-starter.ts`, where each is bound to the real runtime.
 */
export interface ProjectDeleteDeps {
  /** Move an absolute path to the OS trash. Rejects when the platform refuses. */
  readonly trashItem: TrashItem;
  /**
   * Delete this project's terminal revive snapshot. Resolves `true` when the
   * file is gone, INCLUDING when it was never there.
   *
   * A dependency because the snapshot lives under `userData`, which only the
   * Electron runtime can locate, and this module must stay runnable without it.
   */
  readonly removeTerminalSnapshot: (projectId: string) => Promise<boolean>;
}

/**
 * How long a delete waits for in-flight calls.
 *
 * Long enough for an ordinary tool call to finish, short enough that a user who
 * clicked delete gets an answer rather than a spinner. On expiry the user is
 * told the COUNT and can retry, which is a better outcome than a longer wait
 * that still might not be enough.
 */
export const PROJECT_DELETE_DRAIN_DEADLINE_MS = 10_000;

/** Attempts after which the tombstone becomes a durable, user-visible notice. */
export const PROJECT_CLEANUP_STICKY_ATTEMPTS = 5;

/**
 * Delete a project.
 *
 * Every outcome is a `Result` SUCCESS carrying a discriminated outcome, except
 * genuine infrastructure failure. "Blocked because calls are running" is not an
 * error; it is an answer.
 */
export async function deleteProject(
  input: ProjectDeleteInput,
  correlationId: string,
  deps: ProjectDeleteDeps,
  signal?: AbortSignal,
): Promise<Result<ProjectDeleteResult, VexError>> {
  const { projectId } = input;

  // STEP 1. Nothing new starts from here on.
  const token = closeProjectAdmission(projectId);

  // STEP 2. Reversible observers. None in B0 - see the module doc.

  // STEP 3. Drain the classes that finish on their own.
  const drain = await drainProjectLeases(
    projectId,
    PROJECT_DELETE_DRAIN_DEADLINE_MS,
  );
  if (!drain.drained) {
    reopenProjectAdmission(projectId);
    return ok({ outcome: "blocked_active_calls", count: drain.remaining });
  }

  // Cancellation BEFORE `BEGIN` is free: nothing has been written.
  if (signal?.aborted === true) {
    reopenProjectAdmission(projectId);
    return err(projectNotFoundError(correlationId));
  }

  // STEP 4 and 5. The transaction announces its refusals after COMMIT.
  const tombstone = await tombstoneProject(input, correlationId);
  if (!tombstone.ok) {
    reopenProjectAdmission(projectId);
    return tombstone;
  }

  const outcome = tombstone.data;
  if (outcome.kind === "not_found") {
    reopenProjectAdmission(projectId);
    return ok({ outcome: "not_found" });
  }
  if (outcome.kind === "blocked_pending_dispatch") {
    reopenProjectAdmission(projectId);
    return ok({ outcome: "blocked_pending_dispatch" });
  }

  if (outcome.kind === "already_tombstoned") {
    // A REPEATED DELETE on an existing tombstone. Admission stays closed.
    if (outcome.cleanupState === "done" || outcome.cleanupState === "none") {
      return ok({ outcome: "already_removed" });
    }
    // The RESUME honours the TOMBSTONE's recorded trash intent and ignores this
    // request's checkbox: the durable decision was made at deletion time, and a
    // retry is not a second chance to change it.
    const resumed = await runCleanup(
      projectId,
      outcome.slug,
      outcome.cleanupState,
      token,
      correlationId,
      deps,
    );
    // THE ECHO. What comes back is the TOMBSTONE's intent, read off the row
    // this transaction just locked, NOT `input.alsoTrashFolder`. On this branch
    // the two can genuinely disagree - a second window's dialog was already
    // open, or an earlier attempt's checkbox has since moved - and the caller
    // has no other way to learn which decision main is actually honouring.
    const trashRequested = tombstoneRequestedTrash(outcome.cleanupState);
    return ok(
      resumed.finished
        ? {
            outcome: "cleanup_resumed",
            cleanup: resumed.cleanup,
            trash: resumed.trash,
            trashRequested,
          }
        : {
            outcome: "cleanup_pending",
            cleanup: resumed.cleanup,
            trash: resumed.trash,
            trashRequested,
            attempts: resumed.attempts,
          },
    );
  }

  // STEP 6. CLOSE TERMINALS AND VIEWERS, now that the tombstone has COMMITTED.
  // Registered owners (B2 registers the terminal domain) close what they hold
  // for this project. A hook failure never fails the delete - the authority
  // change is already durable - and the gate logs every one.
  await closeProjectResources(projectId);

  // STEP 7. Cleanup, under the administrative token.
  const cleanup = await runCleanup(
    projectId,
    outcome.slug,
    outcome.cleanupState,
    token,
    correlationId,
    deps,
  );
  return ok(
    cleanup.finished
      ? { outcome: "removed", cleanup: cleanup.cleanup, trash: cleanup.trash }
      : {
          outcome: "cleanup_pending",
          cleanup: cleanup.cleanup,
          trash: cleanup.trash,
          // Read from the state the transaction WROTE, not from the input that
          // produced it, so both `cleanup_pending` returns speak with one voice.
          trashRequested: tombstoneRequestedTrash(outcome.cleanupState),
          attempts: cleanup.attempts,
        },
  );
}

interface CleanupReport {
  readonly finished: boolean;
  readonly cleanup: StudioArtifactOutcome[];
  readonly trash: ProjectTrashOutcome;
  readonly attempts: number;
}

/**
 * Remove the artifacts Vex wrote, then optionally trash the folder.
 *
 * Runs as a TERMINAL JOB of the project's own installer queue, keyed by the
 * same project id, so it serializes behind any render already in flight rather
 * than deleting files a render is mid-write on. It is enqueued as `repair`
 * because a repair is never superseded: a teardown that a later job could
 * cancel would leave the obligation recorded but silently unperformed.
 */
async function runCleanup(
  projectId: string,
  slug: string,
  cleanupState: OwedProjectCleanupState,
  token: ProjectDeletionToken,
  correlationId: string,
  deps: ProjectDeleteDeps,
): Promise<CleanupReport> {
  return enqueueStudioRender<CleanupReport>({
    projectId,
    kind: "repair",
    run: () =>
      runCleanupJob(projectId, slug, cleanupState, token, correlationId, deps),
    // A repair is never superseded, so this is unreachable in practice; it
    // reports "nothing was done" rather than claiming a cleanup that did not run.
    whenSuperseded: () => ({
      finished: false,
      cleanup: [],
      trash: "not_requested" as const,
      attempts: 0,
    }),
  });
}

async function runCleanupJob(
  projectId: string,
  slug: string,
  cleanupState: OwedProjectCleanupState,
  token: ProjectDeletionToken,
  correlationId: string,
  deps: ProjectDeleteDeps,
): Promise<CleanupReport> {
  // The administrative lease. Admission is closed for this project, so an
  // ordinary render acquisition would be refused - which is the point.
  const lease = acquireProjectLease(projectId, "render", token);
  if (!lease.ok) {
    return await failCleanup(
      projectId,
      "The project's lifecycle gate refused the cleanup lease.",
      [],
      "not_requested",
    );
  }

  try {
    const rootOutcome = await resolveProjectsRoot(correlationId);
    if (!rootOutcome.ok) {
      return await failCleanup(
        projectId,
        "The projects root could not be resolved.",
        [],
        "not_requested",
      );
    }
    const directory = resolveProjectDirectory(rootOutcome.data, slug);
    if (directory === null) {
      return await failCleanup(
        projectId,
        "The project folder is not inside the configured projects root.",
        [],
        "not_requested",
      );
    }

    const provenanceOutcome = await readArtifactProvenance(projectId);
    if (!provenanceOutcome.ok) {
      return await failCleanup(
        projectId,
        "The record of what Vex wrote could not be read, so nothing was removed.",
        [],
        "not_requested",
      );
    }
    const provenance = provenanceOutcome.data;

    // THE TEARDOWN PLAN, which is a different planner rather than a filtered
    // install plan. `buildStudioPlan` appends AGENTS.md, CLAUDE.md and
    // .vex/protocols.md as unconditional INSTALLS, so filtering it to `remove`
    // would silently leave all three behind - including an AGENTS.md managed
    // block still telling the next coding agent that this repository is
    // connected to Vex and which wallets it may spend. That block is a claim of
    // live authority, and a deleted project must not keep making it.
    const teardown = buildStudioTeardownPlan({
      previouslyWritten: new Set(provenance.keys()),
    });
    const removals = teardown.artifacts;

    let artifacts: StudioArtifactOutcome[] = [];
    /** Artifacts left in place because they are not provably Vex's. */
    const kept: { readonly key: string; readonly path: string }[] = [];
    /** Non-success outcomes that are NOT an ownership answer. These keep the row pending. */
    let blocked = 0;
    if (removals.length > 0) {
      const reconciled = await reconcileStudioArtifacts({
        projectDirectory: await realpathOrSelf(directory),
        plan: { artifacts: removals, unsupported: [] },
        // A teardown reads NEITHER of these: `facts` feeds config RENDERING
        // and `brief` feeds the managed block, and this plan only removes.
        // The empty command is inert here and would be visible immediately if
        // a rendering artifact ever reached this call.
        facts: { projectId, bridgeCommand: "" },
        brief: null,
        provenance,
        // A TEARDOWN IS NOT A REPAIR, and this used to say `true`.
        //
        // `repair` grants exactly one power inside the reconciler that a
        // teardown plan can reach: the provenance-proven TAKEOVER in
        // `decideAgentConfig`, which replaces (here: REMOVES) a Vex entry whose
        // current bytes no longer match what provenance recorded - that is, an
        // entry the USER hand-edited. Repair means "I, the user, am asking Vex
        // to overwrite my edit with the generated entry", and a delete is not
        // that request. With `true`, deleting a project silently deleted a
        // hand-edited Vex config entry (JSON or TOML) before the drift and
        // unknown-key checks ever ran, contradicting the policy this module's
        // own header states: drifted content is KEPT, REPORTED, and DISCHARGES
        // the obligation.
        //
        // `repair: false` is the right seam rather than a new mode because for
        // a teardown plan - every artifact `operation: "remove"` - it is the
        // ONLY reachable consumer of the flag. The other three
        // (`decideAgentsMd`, `decideClaudeMd`, `decideProtocolsDoc`) are on the
        // install branch of `decideDesiredText`, which a remove operation never
        // takes. So this changes that one behaviour and nothing else, and the
        // refusals it now produces are ownership refusals, which discharge.
        repair: false,
        io: {
          replaceFile: replaceConfinedFile,
          // The teardown is the only plan that produces `delete` decisions, so
          // it is the only run that supplies this.
          deleteFile: deleteConfinedFile,
          // A teardown never writes an artifact, so nothing ever asks to record
          // provenance. Returning true keeps the reconciler's contract without
          // pretending a write happened.
          commitProvenance: () => Promise.resolve(true),
          clearProvenance: async (artifactKey: string) => {
            const cleared = await clearArtifactProvenance(projectId, artifactKey);
            if (!cleared.ok) {
              log.error(
                `[studio:delete] provenance for ${artifactKey} was not cleared `
                  + `projectId=${projectId} correlationId=${correlationId}`,
              );
            }
            return cleared.ok;
          },
        },
      });
      artifacts = [...reconciled.artifacts];

      // CLASSIFY every outcome that is not a success. A teardown plan carries no
      // `unsupported` items, so the reconciler emits exactly one outcome per
      // planned artifact, in plan order - which is what lets a kept artifact be
      // paired back to the provenance key it must release. The pairing is
      // VERIFIED on the path rather than assumed from the index: a mismatch
      // falls through to `blocked`, so a future planner change that breaks the
      // correspondence leaves the obligation pending instead of clearing the
      // wrong row.
      for (const [index, outcome] of artifacts.entries()) {
        if (isReconciledArtifact(outcome)) continue;
        const planned = removals[index];
        if (
          isOwnershipRefusal(outcome)
          && planned !== undefined
          && planned.relativePath === outcome.path
        ) {
          kept.push({ key: planned.key, path: planned.relativePath });
          continue;
        }
        blocked += 1;
      }
    }
    // THE PROVENANCE-INDEPENDENT REMOVAL: the project's terminal revive
    // snapshot.
    //
    // It is not in the project folder and it has no provenance row, because it
    // is not an artifact Vex wrote INTO the user's repository - it lives under
    // `userData` and is unambiguously Vex's own file. It is also the most
    // sensitive thing this cleanup touches: a serialization of everything that
    // scrolled through the project's terminals, which is command lines, tokens
    // pasted at a prompt, and output from tools that print credentials when
    // they fail. Leaving it behind means a deleted project's terminal output
    // outlives the project, for as long as the snapshot directory bound
    // tolerates it.
    //
    // ENOENT is SUCCESS. A project whose terminals were never opened has no
    // snapshot, and treating its absence as a failure would leave every such
    // delete permanently pending.
    const snapshotRemoved = await deps.removeTerminalSnapshot(projectId);
    if (!snapshotRemoved) {
      log.error(
        `[studio:delete] the terminal snapshot could not be removed `
          + `projectId=${projectId} correlationId=${correlationId}`,
      );
    }

    const removalsCompleted = blocked === 0 && snapshotRemoved;

    let trash: ProjectTrashOutcome = "not_requested";
    if (cleanupState === "trash_pending") {
      trash = await trashProjectFolder(
        rootOutcome.data,
        directory,
        correlationId,
        deps.trashItem,
      );
    }

    // The folder is only "clean" when both halves are. A failed trash keeps the
    // obligation, because the user asked for the folder to go.
    const finished = removalsCompleted && trash !== "failed";
    if (!finished) {
      return await failCleanup(
        projectId,
        trash === "failed"
          ? "The project folder could not be moved to the trash."
          : "Some of the entries Vex wrote could not be removed.",
        artifacts,
        trash,
      );
    }

    // THE DISCHARGE COMMIT POINT. Nothing is owed for an artifact Vex cannot
    // prove it owns, so its provenance row - whose only purpose was to prove
    // ownership for a future rewrite of a project that no longer exists - goes
    // too. Cleared HERE and not earlier: a trash step that failed above keeps
    // the obligation, and the retry must still be able to report these.
    if (kept.length > 0) {
      for (const artifact of kept) {
        const cleared = await clearArtifactProvenance(projectId, artifact.key);
        if (!cleared.ok) {
          return await failCleanup(
            projectId,
            "The record of what Vex wrote could not be updated, so the cleanup is "
              + "not finished.",
            artifacts,
            trash,
          );
        }
      }
      // NOT SILENT. The user-facing half is the per-artifact outcome list this
      // report already carries; this is the operator half. Repo-relative labels
      // only, exactly as every other message on this path.
      log.warn(
        `[studio:delete] cleanup discharged with ${String(kept.length)} artifact(s) `
          + `left in place because they are no longer provably Vex's `
          + `projectId=${projectId} correlationId=${correlationId} `
          + `kept=${kept.map((artifact) => artifact.path).join(", ")}`,
      );
    }

    const marked = await markProjectCleanupDone(projectId);
    if (!marked.ok || !marked.data) {
      // The work was done but the record of it was not. Reported as unfinished
      // so a retry re-runs an IDEMPOTENT cleanup, rather than as done on the
      // strength of a write that did not land.
      return await failCleanup(
        projectId,
        "The cleanup finished but its completion could not be recorded.",
        artifacts,
        trash,
      );
    }
    return { finished: true, cleanup: artifacts, trash, attempts: 0 };
  } catch (cause) {
    log.error(
      `[studio:delete] cleanup threw projectId=${projectId} correlationId=${correlationId}`,
      cause,
    );
    return await failCleanup(
      projectId,
      "The cleanup did not finish.",
      [],
      "not_requested",
    );
  } finally {
    lease.ok && lease.lease.release();
  }
}

/** Record the failed attempt and report it. The obligation STAYS pending. */
async function failCleanup(
  projectId: string,
  reason: string,
  artifacts: StudioArtifactOutcome[],
  trash: ProjectTrashOutcome,
): Promise<CleanupReport> {
  const recorded = await recordProjectCleanupFailure(projectId, reason);
  const attempts = recorded.ok ? recorded.data : 0;
  if (attempts >= PROJECT_CLEANUP_STICKY_ATTEMPTS) {
    // The durable sticky notice: the fact lives on the row (state, attempts,
    // last error), so the surface that renders it in B4 reads it rather than
    // being told by an event it might have missed.
    log.error(
      `[studio:delete] cleanup has failed ${String(attempts)} times and needs `
        + `attention projectId=${projectId}`,
    );
  }
  return { finished: false, cleanup: artifacts, trash, attempts };
}

/**
 * Move the project folder to the OS trash.
 *
 * FIRST use of an OS trash in this app, on a destructive path, so the guard is
 * explicit: the directory's REALPATH must still resolve to a direct child of
 * the projects root's realpath. That is what stops a symlinked slug directory -
 * or a root that moved between the tombstone and this call - from turning
 * "trash the project" into "trash something else". THE GUARD LIVES HERE, with
 * the caller that knows the root, and never travels with the injected
 * capability.
 *
 * It is the TRASH, never an unlink: the user can get their files back.
 * A failure here NEVER rolls back the authority commit; the project is deleted
 * either way, and the folder is simply still on disk.
 */
async function trashProjectFolder(
  configuredRoot: string,
  directory: string,
  correlationId: string,
  trashItem: TrashItem,
): Promise<ProjectTrashOutcome> {
  let resolvedDirectory: string;
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(configuredRoot);
    resolvedDirectory = await realpath(directory);
  } catch (cause) {
    // A folder that is already gone is not a failure: the obligation was to
    // ensure it is not there, and it is not there.
    if (isMissing(cause)) return "trashed";
    log.warn(
      `[studio:delete] the project folder could not be resolved for trashing `
        + `correlationId=${correlationId}`,
    );
    return "failed";
  }

  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (
    !resolvedDirectory.startsWith(prefix)
    || path.dirname(resolvedDirectory) !== resolvedRoot
  ) {
    log.error(
      `[studio:delete] REFUSED to trash a path outside the projects root `
        + `correlationId=${correlationId}`,
    );
    return "failed";
  }

  try {
    await trashItem(resolvedDirectory);
    return "trashed";
  } catch (cause) {
    log.warn(
      `[studio:delete] trashItem failed correlationId=${correlationId}`,
      cause,
    );
    return "failed";
  }
}

async function realpathOrSelf(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return directory;
  }
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object"
    && cause !== null
    && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * STARTUP REPAIR: finish the cleanups a previous run did not.
 *
 * Cloned from the pending-refusal repair pattern (migration 092 and
 * `approval-refusals.ts`): a durable obligation gets an owner that runs once
 * per app start, bounded, and never blocks startup on its own failure.
 *
 * BOUNDED AT THREE ATTEMPTS PER START. A tombstone whose cleanup keeps failing
 * must not turn every launch into a retry storm; after three it waits for the
 * next start or for the user to ask again, and its attempt count is what makes
 * the failure visible rather than silent.
 */
export async function repairUnfinishedProjectCleanups(
  deps: ProjectDeleteDeps,
): Promise<void> {
  const pending = await listUnfinishedProjectCleanups();
  if (!pending.ok) {
    log.warn(
      "[studio:delete] unfinished project cleanups could not be listed at startup",
    );
    return;
  }
  if (pending.data.length === 0) return;

  let attempted = 0;
  for (const tombstone of pending.data) {
    if (attempted >= 3) {
      log.warn(
        `[studio:delete] ${String(pending.data.length - attempted)} project cleanup(s) `
          + "were left for a later start",
      );
      return;
    }
    attempted += 1;
    // Admission is closed for a tombstone for the life of the process, and the
    // token is minted here exactly as the original delete minted it.
    const token = closeProjectAdmission(tombstone.projectId);
    const report = await runCleanup(
      tombstone.projectId,
      tombstone.slug,
      tombstone.cleanupState,
      token,
      `startup-cleanup-${tombstone.projectId}`,
      deps,
    );
    log.info(
      `[studio:delete] startup cleanup projectId=${tombstone.projectId} `
        + `finished=${String(report.finished)} attempts=${String(report.attempts)}`,
    );
  }
}

/** Re-exported so the create path can ask before it claims a slug's directory. */
export { slugHeldByUnfinishedCleanup } from "../database/projects/delete.js";

/** Re-exported for the delete IPC handler's `already_removed` shortcut. */
export { readTombstonedProject };
