/**
 * Free and total space of the volume that holds a path, from `statfs`.
 *
 * The path need not exist yet: on a first run the runtime directory is
 * created later, so the nearest existing ancestor is measured instead. It is
 * on the same volume unless a mount point sits between the two, and nothing
 * mounts inside Vex's own config directory.
 *
 * `freeBytes` is what an unprivileged process may still write (`bavail`), not
 * the blocks reserved for root (`bfree`): Vex never runs as root.
 */

import { statfs } from "node:fs/promises";
import path from "node:path";

export interface DiskSpace {
  /** The directory that was measured: `target`, or its nearest existing ancestor. */
  readonly measuredPath: string;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Rejects with the `statfs` error when no ancestor can be measured. */
export async function readDiskSpace(target: string): Promise<DiskSpace> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stats = await statfs(current);
      return {
        measuredPath: current,
        freeBytes: Math.max(0, stats.bavail * stats.bsize),
        totalBytes: Math.max(0, stats.blocks * stats.bsize),
      };
    } catch (error: unknown) {
      const parent = path.dirname(current);
      if ((errnoCode(error) !== "ENOENT" && errnoCode(error) !== "ENOTDIR") || parent === current) throw error;
      current = parent;
    }
  }
}
