/**
 * WRITING TO A PROJECT FROM THE TREE: create, rename, delete.
 *
 * `files-domain.ts` owns AUTHORITY - which projects are live, which tokens
 * still verify, which leases are held - and it keeps owning it: every operation
 * here is handed an already-resolved location produced by that module's own
 * `locate`, so the chain (active row -> realpath -> token verification ->
 * symlink-free walk -> containment) has exactly one implementation and a write
 * cannot reach a syscall having skipped a link of it.
 *
 * What lives HERE is everything that is specific to changing the disk rather
 * than reading it, and each part exists because leaving it in the domain would
 * put a second reason to change into a module that already has one:
 *
 *  - the NAME rules, enforced against the shared decision the renderer also
 *    validates with, so an inline error and a refusal cannot disagree;
 *  - the VEX-MANAGED refusal, derived from the installer's own registry rather
 *    than from a list copied into this file;
 *  - the per-project WRITE LOCK, which is what makes two mutations of one
 *    project a sequence instead of a race;
 *  - the TRASH, injected, so this module and its tests load without Electron;
 *  - the last-moment RE-RESOLUTION before every syscall.
 *
 * ## Why a create takes a parent and a name, and a rename takes a name
 *
 * Neither can address a destination, so neither can leave the project. A
 * rename's target is `dirname(source) + name`, computed here, from a source
 * that `locate` already proved is inside the root and reached through no
 * symbolic link. That is a stronger statement than checking a caller-supplied
 * destination for containment, because there is no destination to check.
 *
 * VS Code does allow separators in its new-file box and creates the
 * intermediate directories (`fileActions.ts:81-86`, which then refreshes the
 * tree because "multiple resources will get created"). REJECTED here: that
 * convenience is a path arriving through a surface whose entire design is that
 * no path does, and the user's alternative - make the folder, then the file -
 * is two keystrokes.
 *
 * ## The residual race, stated plainly
 *
 * MEASURED on this platform (Node 24, ext4): `fs.rename` SILENTLY OVERWRITES an
 * existing file, and overwrites an existing EMPTY directory. Node exposes no
 * `renameat2(RENAME_NOREPLACE)`, so a collision is refused by an `lstat` taken
 * immediately before the rename, and the microseconds between that check and
 * the syscall are not covered. `link` + `unlink` would close the file half of
 * that window atomically (`link` answers EEXIST, measured), and it is REJECTED:
 * it is `EPERM` for directories (measured), so it would split the operation
 * into two platform-dependent paths, and on a case-insensitive filesystem a
 * case-only rename would see its own target and refuse a rename that is legal.
 * A create does NOT share the residual: `open(..., "wx")` and `mkdir` are
 * themselves exclusive (both answer EEXIST, measured), so they are used
 * directly and no pre-check decides them.
 *
 * The window is between a user and their own filesystem, on their own machine,
 * for a name their own tree just showed them. It is named rather than hidden.
 *
 * ## Delete goes to the TRASH
 *
 * `shell.trashItem` (Electron 42), injected as {@link TrashItem} exactly as
 * `project-delete.ts` injects it, for the same reason: a module whose subject
 * is the filesystem must not become unloadable where Electron is not installed.
 * A platform with no trash, or one that refuses, produces `trash_unavailable`
 * with the entry UNTOUCHED - never a silent unlink - and permanent removal is a
 * second request the user makes deliberately.
 */

import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { STUDIO_AGENTS } from "@vex-agent/studio/agents.js";
import {
  FILES_MUTATION_TIMEOUT_MS,
  fileNameRefusal,
  type FileDeleteMode,
  type FileDeleteResult,
  type FileNode,
  type FilesErrorCode,
  type FilesOutcome,
} from "@shared/schemas/files.js";

import { log } from "../../logger/index.js";
import { STUDIO_AGENTS_MD_RELATIVE_PATH } from "../installer/plan.js";
import { mintFileNodeId } from "./node-id.js";
import { describeFileFailure, isEnoentLike } from "./node-path.js";

/** Move an absolute path to the operating system's trash. See `os-trash.ts`. */
export type TrashItem = (absolutePath: string) => Promise<void>;

/**
 * A location the domain has already proven, exactly as `locate` returns it.
 *
 * Declared structurally rather than imported so `files-domain.ts` depends on
 * this module and not the other way round; the domain owns the chain, this
 * module owns what may be done at the end of it.
 */
export interface ResolvedLocation {
  readonly projectDirectory: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly epoch: number;
}

export type LocateOutcome =
  | ({ readonly ok: true } & ResolvedLocation)
  | { readonly ok: false; readonly code: FilesErrorCode };

export interface MutationDependencies {
  /** The domain's own authority chain. The only way a path is produced here. */
  readonly locate: (projectId: string, nodeId: string | null) => Promise<LocateOutcome>;
  /** The domain's publication fence: has this project been closed since? */
  readonly stillAuthorised: (projectId: string, epoch: number) => boolean;
  readonly trashItem: TrashItem;
  /** Injected so a test can drive the deadline without waiting for it. */
  readonly timeoutMs?: number;
}

/* ------------------------------------------------------------------ *
 * Vex-managed artifacts
 * ------------------------------------------------------------------ */

/**
 * Everything under this prefix is Vex's, whatever its name.
 *
 * `.vex/` holds `protocols.md`, the bridge's own state and whatever a later
 * stage puts beside them, so the rule is the DIRECTORY rather than a growing
 * list of files inside it.
 */
const VEX_DIRECTORY_PREFIX = ".vex/";

/**
 * The exact project-relative paths the installer writes, plus the two
 * instruction files it owns a region of.
 *
 * DERIVED FROM THE REGISTRY, not transcribed: `STUDIO_AGENTS` is the same
 * source `buildStudioPlan` reads, so an agent added there is protected here
 * without anybody remembering to come back. A transcribed list is a second
 * source of truth for which files have an owner, and the failure it produces -
 * a user renaming a config the installer will silently recreate, and a
 * provenance row pointing at a path that no longer exists - is invisible until
 * the next Repair.
 *
 * `CLAUDE.md` is a literal because it is the render layer's constant
 * (`@vex-agent/studio/installer/render/claude-md.ts`) and importing a renderer
 * into the filesystem layer to read one string would be the heavier coupling.
 */
function managedRelativePaths(): ReadonlySet<string> {
  const paths = new Set<string>([STUDIO_AGENTS_MD_RELATIVE_PATH, "CLAUDE.md"]);
  for (const agent of Object.values(STUDIO_AGENTS)) {
    const candidates = agentConfigPaths(agent);
    for (const candidate of candidates) paths.add(candidate);
  }
  return paths;
}

/**
 * Every repo-relative config path one registry entry can name.
 *
 * Read structurally because the registry's writable and unsupported members do
 * not share a field, and an unsupported agent that GAINS a writer later must
 * be protected the moment it does rather than the moment somebody notices.
 */
function agentConfigPaths(agent: unknown): readonly string[] {
  if (typeof agent !== "object" || agent === null) return [];
  const out: string[] = [];
  for (const value of Object.values(agent as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0 && !value.includes(" ")) {
      // A repo-relative POSIX path, never an absolute one and never a command
      // template (which is why a value containing a space is skipped).
      if (value.endsWith(".json") || value.endsWith(".jsonc")
        || value.endsWith(".toml") || value.endsWith(".md")) {
        out.push(value);
      }
    }
  }
  return out;
}

/** Computed once: the registry is compiled into the app and never changes. */
const MANAGED_PATHS = managedRelativePaths();

/**
 * Is this project-relative path one Vex owns?
 *
 * Exported for the tests that enumerate the registry against it, so "the rule
 * covers every agent" is an assertion rather than a claim in a comment.
 */
export function isVexManagedPath(relativePath: string): boolean {
  if (relativePath === ".vex" || relativePath.startsWith(VEX_DIRECTORY_PREFIX)) return true;
  return MANAGED_PATHS.has(relativePath);
}

/* ------------------------------------------------------------------ *
 * The per-project write lock
 * ------------------------------------------------------------------ */

/**
 * ONE write at a time per project, with a bounded wait.
 *
 * Two mutations of one project are not independent even when they name
 * different entries: a create checks a name against a directory another
 * mutation is renaming into, and a delete of a folder can be in flight while a
 * create lands inside it. Serialising is the smallest correct answer and it
 * costs nothing at human speed.
 *
 * The lock is a promise CHAIN rather than a queue object: each waiter awaits
 * the previous holder's settlement, so a mutation that throws still releases.
 * The deadline is enforced on the WAIT, never on the work: cancelling a rename
 * halfway is not something a filesystem offers, and a deadline that abandoned a
 * syscall in flight would report an outcome it does not know.
 */
export type LockAcquisition =
  /** Held. Call `release` exactly once; calling it twice is a no-op. */
  | { readonly outcome: "acquired"; readonly release: () => void }
  /** The deadline passed while waiting. NOTHING was acquired. */
  | { readonly outcome: "timeout" }
  /** The caller's signal aborted the wait. NOTHING was acquired. */
  | { readonly outcome: "aborted" };

class ProjectWriteLock {
  readonly #chains = new Map<string, Promise<void>>();

  /**
   * @param projectId the project to serialise on.
   * @param timeoutMs how long to wait for the lock before refusing.
   * @param signal aborts the WAIT; an abort after acquisition is ignored,
   *   because the syscall it would interrupt has no safe abandonment point.
   * @returns what happened. Only `"acquired"` may touch the disk.
   */
  async acquire(
    projectId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<LockAcquisition> {
    const previous = this.#chains.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The chain is extended SYNCHRONOUSLY, before the first await, so a caller
    // that arrives while this one is still waiting queues behind it rather
    // than beside it (rule 05: the reservation is taken before the await).
    const mine = previous.then(
      () => held,
      () => held,
    );
    this.#chains.set(projectId, mine);
    this.#collectWhenSettled(projectId, mine);

    const waited = await raceDeadline(previous, timeoutMs, signal);
    if (waited !== "acquired") {
      // This entry is already in the chain, so it must settle whatever happens
      // or every later waiter blocks on a lock nobody holds.
      release();
      return { outcome: waited };
    }

    let released = false;
    return {
      outcome: "acquired",
      release: () => {
        if (released) return;
        released = true;
        release();
      },
    };
  }

  /**
   * Drop a project's chain once THIS link is the tail and has settled, so the
   * map is bounded by the projects being written to rather than by every
   * project the process has ever opened.
   */
  #collectWhenSettled(projectId: string, mine: Promise<void>): void {
    void mine.then(
      () => {
        if (this.#chains.get(projectId) === mine) this.#chains.delete(projectId);
      },
      () => {
        if (this.#chains.get(projectId) === mine) this.#chains.delete(projectId);
      },
    );
  }
}

/**
 * Wait for the previous holder, the deadline, or the caller's abort.
 *
 * The timer and the listener are BOTH released in the `finally`, whichever arm
 * won: a lock waited on ten thousand times must not leave ten thousand
 * listeners on a long-lived signal, and a pending timer would hold the event
 * loop open past a mutation that already answered.
 */
async function raceDeadline(
  previous: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<"acquired" | "timeout" | "aborted"> {
  if (signal?.aborted === true) return "aborted";
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<"acquired" | "timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
      if (signal !== undefined) {
        onAbort = (): void => {
          resolve("aborted");
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      previous.then(
        () => {
          resolve("acquired");
        },
        () => {
          resolve("acquired");
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The operations
 * ------------------------------------------------------------------ */

/** Why the caller's request cannot proceed, as this surface's own codes. */
function classifyWriteFailure(cause: unknown): FilesErrorCode {
  if (isEnoentLike(cause)) return "not_found";
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "EEXIST") return "name_exists";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "write_denied";
  if (code === "ENOTEMPTY") return "io_error";
  if (code === "ENAMETOOLONG") return "name_invalid";
  if (code === "EISDIR" || code === "ENOTDIR") return "not_found";
  return "io_error";
}

export class ProjectFileMutations {
  readonly #deps: MutationDependencies;
  readonly #lock = new ProjectWriteLock();
  readonly #timeoutMs: number;

  constructor(deps: MutationDependencies) {
    this.#deps = deps;
    this.#timeoutMs = deps.timeoutMs ?? FILES_MUTATION_TIMEOUT_MS;
  }

  /**
   * Create one entry inside a directory the caller already holds a token for.
   *
   * The PARENT is re-resolved under the lock, so a directory that was renamed
   * or removed while this request waited produces a refusal rather than a file
   * appearing somewhere the user is no longer looking.
   */
  async create(input: {
    readonly projectId: string;
    readonly parentNodeId: string | null;
    readonly name: string;
    readonly kind: "file" | "directory";
    readonly signal?: AbortSignal;
  }): Promise<FilesOutcome<FileNode>> {
    const named = this.#checkName(input.name);
    if (named !== null) return named;

    return this.#underLock(input.projectId, input.signal, async () => {
      const parent = await this.#deps.locate(input.projectId, input.parentNodeId);
      if (!parent.ok) return { ok: false, code: parent.code };
      if (parent.kind === "symlink") return { ok: false, code: "symlinked_path" };
      if (parent.kind !== "directory") return { ok: false, code: "not_a_directory" };

      const relativePath = joinRelative(parent.relativePath, input.name);
      // A create INTO a managed path is refused for the same reason a rename of
      // one is: the installer owns that name and would overwrite whatever the
      // user put there on the next Repair.
      if (isVexManagedPath(relativePath)) return { ok: false, code: "vex_managed" };

      const absolutePath = path.join(parent.absolutePath, input.name);
      try {
        if (input.kind === "directory") {
          // `recursive: false` is the default and it is the point: `mkdir`
          // answers EEXIST rather than succeeding on a directory that is
          // already there, which is the exclusive create this needs.
          await mkdir(absolutePath);
        } else {
          // `wx` is O_CREAT|O_EXCL: the kernel decides the collision, so there
          // is no check-then-act window here at all.
          const handle = await open(absolutePath, "wx");
          await handle.close();
        }
      } catch (cause) {
        log.warn(
          `[studio:files] create refused projectId=${input.projectId} `
            + `kind=${input.kind} ${describeFileFailure(cause)}`,
        );
        return { ok: false, code: classifyWriteFailure(cause) };
      }

      return this.#describeCreated(input.projectId, relativePath, absolutePath, parent.epoch);
    });
  }

  /**
   * Rename one entry IN PLACE. The parent directory never changes.
   *
   * A case-only rename is recognised rather than refused: on a case-insensitive
   * filesystem the target `lstat`s to the source itself, and treating that as a
   * collision would refuse `readme.md` -> `README.md`, which is a rename users
   * make constantly and git records.
   */
  async rename(input: {
    readonly projectId: string;
    readonly nodeId: string;
    readonly name: string;
    readonly signal?: AbortSignal;
  }): Promise<FilesOutcome<FileNode>> {
    const named = this.#checkName(input.name);
    if (named !== null) return named;

    return this.#underLock(input.projectId, input.signal, async () => {
      const source = await this.#deps.locate(input.projectId, input.nodeId);
      if (!source.ok) return { ok: false, code: source.code };
      if (source.relativePath === "") return { ok: false, code: "outside_project" };
      if (isVexManagedPath(source.relativePath)) return { ok: false, code: "vex_managed" };

      const parentRelative = parentOf(source.relativePath);
      const targetRelative = joinRelative(parentRelative, input.name);
      if (targetRelative === source.relativePath) {
        // The same name. Nothing to do, and reporting the node as it stands is
        // more useful to the caller than an error about a no-op.
        return this.#describeCreated(
          input.projectId,
          source.relativePath,
          source.absolutePath,
          source.epoch,
        );
      }
      if (isVexManagedPath(targetRelative)) return { ok: false, code: "vex_managed" };

      const targetAbsolute = path.join(path.dirname(source.absolutePath), input.name);
      if (await wouldOverwriteAnother(source.absolutePath, targetAbsolute)) {
        return { ok: false, code: "name_exists" };
      }

      try {
        await rename(source.absolutePath, targetAbsolute);
      } catch (cause) {
        log.warn(
          `[studio:files] rename refused projectId=${input.projectId} `
            + `${describeFileFailure(cause)}`,
        );
        return { ok: false, code: classifyWriteFailure(cause) };
      }

      return this.#describeCreated(
        input.projectId,
        targetRelative,
        targetAbsolute,
        source.epoch,
      );
    });
  }

  /**
   * Delete one entry, to the trash unless the caller explicitly said otherwise.
   *
   * A DIRECTORY IS REMOVED WITH ITS CONTENTS, which is what the confirmation
   * the user read said. The recursion is the operating system's for a trash and
   * `rm -r`'s for a permanent delete; neither walks the tree in this process,
   * so there is no partial state this module could be left holding.
   */
  async delete(input: {
    readonly projectId: string;
    readonly nodeId: string;
    readonly mode: FileDeleteMode;
    readonly signal?: AbortSignal;
  }): Promise<FilesOutcome<FileDeleteResult>> {
    return this.#underLock(input.projectId, input.signal, async () => {
      const target = await this.#deps.locate(input.projectId, input.nodeId);
      if (!target.ok) return { ok: false, code: target.code };
      // THE ROOT IS NOT DELETABLE FROM HERE. Removing a project is the project
      // lifecycle's action, with its own typed confirmation and its own durable
      // obligations (tombstone, provenance cleanup, terminal teardown), and a
      // tree that could take the folder out from under all of that would leave
      // every one of them pointing at nothing.
      if (target.relativePath === "") return { ok: false, code: "outside_project" };
      if (isVexManagedPath(target.relativePath)) return { ok: false, code: "vex_managed" };

      const kind = target.kind;
      if (input.mode === "trash") {
        try {
          await this.#deps.trashItem(target.absolutePath);
        } catch (cause) {
          // UNTOUCHED. The caller offers permanent deletion as a second
          // decision; falling through to an unlink here would remove a file the
          // user was told they could restore.
          log.warn(
            `[studio:files] trash refused projectId=${input.projectId} `
              + `${describeFileFailure(cause)}`,
          );
          return { ok: false, code: "trash_unavailable" };
        }
      } else {
        try {
          await rm(target.absolutePath, { recursive: kind === "directory", force: false });
        } catch (cause) {
          log.warn(
            `[studio:files] delete refused projectId=${input.projectId} `
              + `${describeFileFailure(cause)}`,
          );
          return { ok: false, code: classifyWriteFailure(cause) };
        }
      }

      if (!this.#deps.stillAuthorised(input.projectId, target.epoch)) {
        // The entry IS gone; the project stopped being ours while it went. The
        // honest answer names the project rather than claiming a result about a
        // tree the caller may no longer be allowed to see.
        return { ok: false, code: "project_closed" };
      }
      return {
        ok: true,
        value: { path: target.relativePath, disposition: input.mode, kind },
      };
    });
  }

  /* ----------------------- internals ----------------------- */

  #checkName(name: string): { readonly ok: false; readonly code: FilesErrorCode } | null {
    return fileNameRefusal(name) === null ? null : { ok: false, code: "name_invalid" };
  }

  /**
   * Run one mutation with this project's write lock held.
   *
   * An ABORTED WAIT throws `AbortError`, which `registerHandler` normalises into
   * `internal.cancelled` - the surface's one cancellation contract, rather than
   * a second one expressed as an outcome code. Nothing has been written when it
   * throws, which is what makes cancelling safe to offer at all.
   */
  async #underLock<T>(
    projectId: string,
    signal: AbortSignal | undefined,
    work: () => Promise<FilesOutcome<T>>,
  ): Promise<FilesOutcome<T>> {
    const acquired = await this.#lock.acquire(projectId, this.#timeoutMs, signal);
    if (acquired.outcome === "aborted") {
      const error = new Error("The mutation was cancelled before it started.");
      error.name = "AbortError";
      throw error;
    }
    if (acquired.outcome === "timeout") {
      log.warn(
        `[studio:files] mutation refused: projectId=${projectId} waited `
          + `${String(this.#timeoutMs)}ms for the write lock`,
      );
      return { ok: false, code: "mutation_busy" };
    }
    try {
      return await work();
    } finally {
      acquired.release();
    }
  }

  /**
   * The node the caller now holds, described exactly as a listing would.
   *
   * The same fields from the same `lstat`, so a row applied from a mutation and
   * the same row re-read by the watcher's refresh are indistinguishable - which
   * is what lets the model merge them by node id instead of showing two.
   */
  async #describeCreated(
    projectId: string,
    relativePath: string,
    absolutePath: string,
    epoch: number,
  ): Promise<FilesOutcome<FileNode>> {
    if (!this.#deps.stillAuthorised(projectId, epoch)) {
      return { ok: false, code: "project_closed" };
    }
    const nodeId = mintFileNodeId(projectId, relativePath);
    const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    try {
      const stats = await lstat(absolutePath);
      const kind = stats.isSymbolicLink()
        ? "symlink"
        : stats.isDirectory()
          ? "directory"
          : stats.isFile()
            ? "file"
            : "other";
      return {
        ok: true,
        value: {
          nodeId,
          name,
          path: relativePath,
          kind,
          size: kind === "file" ? stats.size : null,
          modifiedMs: Math.trunc(stats.mtimeMs),
        },
      };
    } catch (cause) {
      // The write SUCCEEDED and the entry vanished before it could be described
      // - a build script, another window, the user's own terminal. The caller
      // is told the truth about the name it asked for; the watcher's own
      // deletion event is what removes the row moments later.
      log.warn(
        `[studio:files] created entry could not be described projectId=${projectId} `
          + `${describeFileFailure(cause)}`,
      );
      return { ok: false, code: "not_found" };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Path arithmetic, and the whole of it
 * ------------------------------------------------------------------ */

/** The parent of a project-relative POSIX path. The root is the empty string. */
function parentOf(relativePath: string): string {
  const at = relativePath.lastIndexOf("/");
  return at === -1 ? "" : relativePath.slice(0, at);
}

/** `<parent>/<name>`, with the root's empty parent handled. */
function joinRelative(parentRelative: string, name: string): string {
  return parentRelative === "" ? name : `${parentRelative}/${name}`;
}

/** A filesystem entry's identity: the pair that names one file on one volume. */
interface EntryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** `lstat`'s identity for a path, or `null` when nothing is there. */
async function identityOf(absolutePath: string): Promise<EntryIdentity | null> {
  try {
    const stats = await lstat(absolutePath, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

/**
 * Would renaming `source` to `target` overwrite a DIFFERENT entry?
 *
 * `false` when nothing is at the target, and `false` when what is at the target
 * IS the source - which is what a case-only rename looks like on a filesystem
 * that folds case (macOS, Windows). Compared by `(dev, ino)`, the same identity
 * `no-follow-open.ts` proves a handle with, rather than by lowercasing two
 * strings and assuming the filesystem folds case the way JavaScript does.
 *
 * MEASURED on Linux/ext4: a case-only rename is an ordinary rename there (the
 * two names are two entries), and this returns `false` for it because nothing
 * is at the target at all. The identity branch is the case-insensitive
 * platforms' path and is exercised by its own test with a fake `lstat`.
 */
async function wouldOverwriteAnother(source: string, target: string): Promise<boolean> {
  const targetIdentity = await identityOf(target);
  if (targetIdentity === null) return false;
  const sourceIdentity = await identityOf(source);
  if (sourceIdentity === null) return true;
  return (
    sourceIdentity.dev !== targetIdentity.dev || sourceIdentity.ino !== targetIdentity.ino
  );
}
