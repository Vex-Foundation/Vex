/**
 * How much a directory holds on disk: the bytes of every regular file under
 * it, found by a bounded, asynchronous walk.
 *
 * It answers Settings' "Data size" for the database (`pg18/`) and the
 * embeddings model (`models/`), so it must never stall main:
 *
 *   - Asynchronous all the way down (`readdir` + `lstat` on the libuv pool),
 *     a directory at a time, its entries stat'ed in small batches; nothing
 *     blocks the event loop for longer than one batch's callbacks.
 *   - Bounded: past `maxEntries` entries the walk stops and says so
 *     (`complete: false`), so a directory that is far larger than it should
 *     be costs a bounded amount of work instead of a hang.
 *   - Symbolic links are counted as the links they are and never followed, so
 *     a link cannot make the walk leave the directory or loop.
 *
 * An entry that vanishes mid-walk (Postgres rotates WAL and temp files while
 * it runs) is skipped; one that cannot be read marks the result incomplete.
 * A directory that does not exist holds nothing: 0 bytes, complete.
 */

import { promises as fs, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import type { RuntimeDirSize } from "@shared/schemas/system.js";

/** Far above a healthy cluster (a few thousand files) or the models folder (one). */
export const DIR_SIZE_MAX_ENTRIES = 200_000;
const STAT_BATCH = 64;

/** What the walk reads of an entry and of its `lstat`, and nothing more. */
export type DirSizeEntry = Pick<Dirent, "name">;
export type DirSizeStat = Pick<Stats, "isDirectory" | "isFile" | "size">;

export interface DirSizeFs {
  readonly readdir: (dir: string) => Promise<readonly DirSizeEntry[]>;
  readonly lstat: (file: string) => Promise<DirSizeStat>;
}

const nodeFs: DirSizeFs = {
  readdir: (dir) => fs.readdir(dir, { withFileTypes: true }),
  lstat: (file) => fs.lstat(file),
};

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export async function measureDirectory(
  root: string,
  options: { readonly maxEntries?: number; readonly fs?: DirSizeFs } = {},
): Promise<RuntimeDirSize> {
  const maxEntries = options.maxEntries ?? DIR_SIZE_MAX_ENTRIES;
  const io = options.fs ?? nodeFs;
  let bytes = 0;
  let files = 0;
  let seen = 0;
  let complete = true;
  const pending: string[] = [root];

  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: readonly DirSizeEntry[];
    try {
      entries = await io.readdir(dir);
    } catch (error: unknown) {
      // The root missing is "nothing here"; a subdirectory gone mid-walk was
      // removed by its owner. Anything else is a part we could not see.
      if (errnoCode(error) !== "ENOENT") complete = false;
      continue;
    }
    for (let start = 0; start < entries.length; ) {
      if (seen >= maxEntries) return { bytes, files, complete: false };
      const batch = entries.slice(start, start + Math.min(STAT_BATCH, maxEntries - seen));
      start += batch.length;
      seen += batch.length;
      const stats = await Promise.all(
        batch.map(async (entry) => {
          const full = path.join(dir, entry.name);
          try {
            return { full, stat: await io.lstat(full) };
          } catch (error: unknown) {
            if (errnoCode(error) !== "ENOENT") complete = false;
            return null;
          }
        }),
      );
      for (const item of stats) {
        if (item === null) continue;
        if (item.stat.isDirectory()) {
          pending.push(item.full);
        } else if (item.stat.isFile()) {
          bytes += item.stat.size;
          files += 1;
        }
      }
    }
  }
  return { bytes, files, complete };
}
