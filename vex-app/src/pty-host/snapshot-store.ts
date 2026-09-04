/**
 * REVIVE SNAPSHOTS on disk: one JSON file per project under
 * `<userData>/studio/terminal-snapshots/<projectId>.json`.
 *
 * ## Why the modes and the rename matter
 *
 * A snapshot is a serialization of everything that scrolled through a
 * developer's terminal: command lines, tokens they pasted, output from tools
 * that print credentials on failure. It is not secret material Vex chose to
 * store, but it is material a user would be alarmed to find world-readable. So
 * the directory is `0700`, the files are `0600`, and neither is left to a
 * process umask that a packaging environment might have widened.
 *
 * The write is WRITE-THEN-RENAME because the alternative loses data on the
 * exact path that matters most. Snapshots are committed during shutdown; a
 * truncating write interrupted by the OS killing a slow-quitting app leaves a
 * half-written JSON file, and the next launch would discard it - so a crash
 * during save would cost the user the workspace the save existed to protect.
 * `rename` within one directory is atomic on every platform Vex ships to.
 *
 * ## A bad snapshot is discarded WHOLE
 *
 * Corrupt JSON, a failed schema, or a version this build does not understand:
 * the file goes, a notice is reported, and the project starts empty. There is
 * no partial restore, because a workspace missing an unnamed half is worse than
 * an empty one - the user cannot tell what they lost or whether to look for it.
 *
 * ## The directory bound evicts the oldest INACTIVE project
 *
 * "Inactive" means no live terminal in this process belongs to it. Evicting an
 * active project's snapshot would delete the very state the current session is
 * about to save, so the caller supplies the active set and eviction skips it.
 * Every eviction is reported; none is silent.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SNAPSHOT_DIR_MAX_BYTES,
  WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
  terminalSnapshotFileName,
  terminalWorkspaceSnapshotSchema,
  type TerminalWorkspaceSnapshot,
} from "@shared/schemas/terminal.js";

export type SnapshotReadOutcome =
  | { readonly kind: "ok"; readonly snapshot: TerminalWorkspaceSnapshot }
  | { readonly kind: "absent" }
  | { readonly kind: "discarded"; readonly reason: "corrupt" | "version" };

export type SnapshotWriteOutcome =
  | { readonly kind: "ok"; readonly bytes: number }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "failed" };

/**
 * Project ids are opaque; refuse anything that could escape the directory.
 *
 * The rule lives in the shared contract because main deletes these same files
 * during a project delete, without a pty host in the loop.
 */
const snapshotFileName = terminalSnapshotFileName;

export class TerminalSnapshotStore {
  constructor(private readonly directory: string) {}

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // `mkdir` honours the mode only when it CREATES the directory, so an
    // existing one from an older build (or a wider umask) is corrected here.
    await fs.chmod(this.directory, 0o700).catch(() => undefined);
  }

  async read(projectId: string): Promise<SnapshotReadOutcome> {
    const name = snapshotFileName(projectId);
    if (name === null) return { kind: "absent" };
    const file = path.join(this.directory, name);

    // STAT BEFORE READ. `readFile` on an unbounded path allocates whatever is
    // there before a single validation rule has run, so a 2 GiB file - however
    // it came to exist - would be a heap exhaustion in the pty host rather than
    // a rejected snapshot. The bound is the same one the write side enforces,
    // so a file this refuses is a file this build could never have produced.
    let size: number;
    try {
      const info = await fs.stat(file);
      if (!info.isFile()) return { kind: "absent" };
      size = info.size;
    } catch {
      return { kind: "absent" };
    }
    if (size > WORKSPACE_SNAPSHOT_FILE_MAX_BYTES) {
      await this.discard(file);
      return { kind: "discarded", reason: "corrupt" };
    }

    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return { kind: "absent" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.discard(file);
      return { kind: "discarded", reason: "corrupt" };
    }

    const validated = terminalWorkspaceSnapshotSchema.safeParse(parsed);
    if (!validated.success) {
      // A version mismatch is reported separately from arbitrary corruption:
      // the first is an expected consequence of upgrading Vex and the second
      // is not, and an operator reading the log needs to tell them apart.
      const version = (parsed as { version?: unknown } | null)?.version;
      await this.discard(file);
      return {
        kind: "discarded",
        reason: typeof version === "number" ? "version" : "corrupt",
      };
    }

    // IDENTITY: the file is named for a project and must describe that project.
    // `p1.json` holding a snapshot whose `projectId` is `p2` would restore one
    // project's terminals under another project's name - and, because the host
    // writes back to the file named for the projectId it was handed, would then
    // move them there permanently. The schema already pins layout.projectId to
    // the snapshot's; this pins the snapshot's to the filename.
    if (validated.data.projectId !== projectId) {
      await this.discard(file);
      return { kind: "discarded", reason: "corrupt" };
    }

    return { kind: "ok", snapshot: validated.data };
  }

  private async discard(file: string): Promise<void> {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }

  /**
   * Commit a snapshot atomically.
   *
   * The size ceiling is enforced HERE as a last gate; the caller is expected to
   * have already row-reduced each terminal to fit. A file that is still too
   * large is refused rather than written, and the refusal is reported, because
   * writing a 40 MiB file the next launch would reject is strictly worse than
   * not writing one.
   */
  async write(snapshot: TerminalWorkspaceSnapshot): Promise<SnapshotWriteOutcome> {
    const name = snapshotFileName(snapshot.projectId);
    if (name === null) return { kind: "failed" };
    const serialized = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > WORKSPACE_SNAPSHOT_FILE_MAX_BYTES) {
      return { kind: "too_large", bytes };
    }

    const file = path.join(this.directory, name);
    // UNIQUE PER WRITE, not per process. The pid alone made every concurrent
    // commit of one project write the same temporary path, so one writer could
    // rename a file another was still filling. The host now serializes a
    // project's commits, which removes that overlap at the source; this is the
    // second lock, and it is one line.
    const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      await this.ensureDirectory();
      await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, file);
      // The rename preserves the temp file's mode, but an existing destination
      // from an older build may be wider; correct it either way.
      await fs.chmod(file, 0o600).catch(() => undefined);
      return { kind: "ok", bytes };
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      return { kind: "failed" };
    }
  }

  /**
   * Remove a project's snapshot file. IDEMPOTENT, and never an error.
   *
   * The host's compensation path: a capture whose rename landed after the
   * project was forgotten unlinks the file it just wrote (see the post-rename
   * fence in `PtyHostService.captureProject`). "Already gone" is the outcome
   * this asks for, so an absent file is success, and a removal that fails is
   * not worth failing a commit over - the delete's own cleanup owns the file
   * and runs against it too.
   */
  async remove(projectId: string): Promise<void> {
    const name = snapshotFileName(projectId);
    if (name === null) return;
    await this.discard(path.join(this.directory, name));
  }

  /**
   * Bring the directory under `SNAPSHOT_DIR_MAX_BYTES`, oldest inactive first.
   *
   * Returns the project ids evicted so the caller can report each one. An empty
   * array means nothing needed evicting - never that eviction failed silently.
   *
   * `maxBytes` is a parameter rather than a constant read inside so the bound's
   * BEHAVIOUR can be tested without writing 64 MiB of fixtures to a real disk.
   * Production always passes the contract value.
   */
  async enforceDirectoryBound(
    activeProjectIds: ReadonlySet<string>,
    maxBytes: number = SNAPSHOT_DIR_MAX_BYTES,
  ): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch {
      return [];
    }

    const files: Array<{ projectId: string; file: string; size: number; mtimeMs: number }> = [];
    let total = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(this.directory, entry);
      try {
        const info = await fs.stat(file);
        if (!info.isFile()) continue;
        total += info.size;
        files.push({
          projectId: entry.slice(0, -".json".length),
          file,
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // Vanished between readdir and stat. Nothing to evict.
      }
    }

    if (total <= maxBytes) return [];

    const evicted: string[] = [];
    const candidates = files
      .filter((candidate) => !activeProjectIds.has(candidate.projectId))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const candidate of candidates) {
      if (total <= maxBytes) break;
      await fs.rm(candidate.file, { force: true }).catch(() => undefined);
      total -= candidate.size;
      evicted.push(candidate.projectId);
    }
    return evicted;
  }
}
