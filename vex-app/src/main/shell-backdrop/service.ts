/**
 * The backdrop SERVICE - orchestration over the byte store, the validation
 * matrix and the pointer of record in `preferences.json`.
 *
 * No Electron dialog here: the file picker belongs to the IPC handler, so
 * this module stays a plain async unit that takes a path (from main's own
 * dialog and nowhere else) and returns a verdict.
 *
 * ONE BACKDROP AT A TIME, and the ORDER of a replacement is load-bearing:
 *   stat gate -> read -> validate (sniff, decode, band) -> write new bytes
 *   (temp + rename) -> COMMIT the pointer -> delete the previous file.
 * The pointer is written LAST, after the bytes are proven and on disk, so a
 * crash before the commit leaves the OLD backdrop intact and a new file the
 * next reconcile sweeps; a crash after it leaves the NEW backdrop intact and
 * an old file the next reconcile sweeps. At no point does the pointer name
 * bytes that do not exist.
 *
 * EVERY OPERATION IS SERIALIZED through one promise chain (the same shape as
 * `preferences/store.ts`). Without it, a `read` arriving while a `pick` is
 * between "bytes written" and "pointer committed" would reconcile the new
 * file away as an orphan.
 *
 * RECONCILE ON READ. The renderer reads the backdrop once per launch when the
 * shell mounts, and every read first sweeps the directory against the
 * pointer: a `.bin` the pointer does not name is deleted, a `.tmp` is
 * deleted, and a pointer whose file is GONE is cleared so the shell falls
 * back to the shipped artwork instead of painting a broken image. That is the
 * orphan cleanup the brief asks for on launch, owned here rather than in
 * `index.ts` so it needs no boot-order hook and is idempotent on every call.
 *
 * LOGGING records the operation, the outcome and structural facts (mime,
 * byte count, orphan count). Never a path, never a file name, never bytes.
 */

import { readFile, stat } from "node:fs/promises";
import {
  SHELL_BACKDROP_MAX_SOURCE_BYTES,
  SHELL_BACKDROP_ROUTE_PREFIX,
  shellBackdropPointerSchema,
  type ShellBackdropPointer,
  type ShellBackdropRecord,
} from "@shared/schemas/shell-backdrop.js";
import { log } from "../logger/index.js";
import { preferencesStore } from "../preferences/store.js";
import { APP_ORIGIN } from "../protocol/app-protocol.js";
import {
  listStoredBackdrops,
  newShellBackdropId,
  removeBackdropBytes,
  removePendingBackdropFile,
  writeBackdropBytes,
} from "./store.js";
import { validateShellBackdropBytes, type ShellBackdropRejection } from "./validation.js";

export type InstallBackdropOutcome =
  | { readonly ok: true; readonly backdrop: ShellBackdropRecord }
  | { readonly ok: false; readonly rejection: ShellBackdropRejection };

/** The URL the app protocol serves this id from. One composition, here. */
export function shellBackdropUrl(imageId: string): string {
  return `${APP_ORIGIN}${SHELL_BACKDROP_ROUTE_PREFIX}${imageId}`;
}

function toRecord(pointer: ShellBackdropPointer): ShellBackdropRecord {
  return { ...pointer, url: shellBackdropUrl(pointer.imageId) };
}

/** Serialises every service operation. Errors do not poison the chain. */
let chain: Promise<void> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task, task);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readPointer(): Promise<ShellBackdropPointer | null> {
  const preferences = await preferencesStore.load();
  return preferences.shell.backdrop;
}

async function writePointer(pointer: ShellBackdropPointer | null): Promise<void> {
  await preferencesStore.update({
    shell: { backdrop: pointer === null ? null : shellBackdropPointerSchema.parse(pointer) },
  });
}

/**
 * Sweep the directory against the pointer. Returns the pointer that is TRUE
 * after the sweep: the input pointer when its file exists, `null` when the
 * file was gone and the pointer has been cleared.
 */
async function reconcileInner(
  pointer: ShellBackdropPointer | null,
): Promise<ShellBackdropPointer | null> {
  const stored = await listStoredBackdrops();
  let orphans = 0;
  for (const id of stored.ids) {
    if (pointer !== null && id === pointer.imageId) continue;
    await removeBackdropBytes(id);
    orphans += 1;
  }
  for (const pending of stored.pendingFiles) {
    await removePendingBackdropFile(pending);
    orphans += 1;
  }
  if (orphans > 0) {
    log.info(`[shell-backdrop] reconcile removed orphans=${orphans}`);
  }
  if (pointer !== null && !stored.ids.includes(pointer.imageId)) {
    log.warn("[shell-backdrop] reconcile cleared a pointer whose file is missing");
    await writePointer(null);
    return null;
  }
  return pointer;
}

/**
 * The current backdrop after a reconcile, or `null` when the shipped artwork
 * is in use.
 */
export function readShellBackdrop(): Promise<ShellBackdropRecord | null> {
  return serialized(async () => {
    const pointer = await reconcileInner(await readPointer());
    return pointer === null ? null : toRecord(pointer);
  });
}

/**
 * Ingest a file the USER picked in main's own dialog.
 *
 * `sourcePath` comes from `dialog.showOpenDialog` and from nowhere else; it is
 * never renderer- or model-supplied. See the file header for the order and
 * why the pointer commits last.
 */
export function installShellBackdropFromFile(sourcePath: string): Promise<InstallBackdropOutcome> {
  return serialized(async () => {
    const size = (await stat(sourcePath)).size;
    // Refused from `stat`, before a single byte is read into memory.
    if (size > SHELL_BACKDROP_MAX_SOURCE_BYTES) {
      return {
        ok: false,
        rejection: {
          kind: "too_large",
          byteLength: size,
          maxBytes: SHELL_BACKDROP_MAX_SOURCE_BYTES,
        },
      };
    }
    const bytes = new Uint8Array(await readFile(sourcePath));
    const validation = validateShellBackdropBytes(bytes);
    if (!validation.ok) return { ok: false, rejection: validation.rejection };

    const previous = await readPointer();
    const pointer: ShellBackdropPointer = {
      imageId: newShellBackdropId(),
      mime: validation.mime,
      width: validation.width,
      height: validation.height,
      byteLength: validation.byteLength,
    };
    await writeBackdropBytes(pointer.imageId, bytes);
    try {
      await writePointer(pointer);
    } catch (cause) {
      // The pointer never moved: the previous backdrop is still the truth, so
      // the freshly written bytes are the orphan, not the old ones.
      await removeBackdropBytes(pointer.imageId).catch(() => undefined);
      throw cause;
    }
    if (previous !== null && previous.imageId !== pointer.imageId) {
      // Best effort AFTER the commit: a failure here leaves an orphan the next
      // read reconciles, never an inconsistency.
      await removeBackdropBytes(previous.imageId).catch((cause: unknown) => {
        log.warn(
          `[shell-backdrop] previous file removal failed type=${
            cause instanceof Error ? cause.name : typeof cause
          }`,
        );
      });
    }
    log.info(
      `[shell-backdrop] installed mime=${pointer.mime} bytes=${pointer.byteLength} ` +
        `size=${pointer.width}x${pointer.height} replaced=${String(previous !== null)}`,
    );
    return { ok: true, backdrop: toRecord(pointer) };
  });
}

/**
 * Remove the custom backdrop: pointer first (the commit), then the bytes.
 * Idempotent: clearing when none is set is a success.
 */
export function clearShellBackdrop(): Promise<void> {
  return serialized(async () => {
    const pointer = await readPointer();
    if (pointer === null) return;
    await writePointer(null);
    await removeBackdropBytes(pointer.imageId).catch((cause: unknown) => {
      log.warn(
        `[shell-backdrop] clear file removal failed type=${
          cause instanceof Error ? cause.name : typeof cause
        }`,
      );
    });
    log.info("[shell-backdrop] cleared");
  });
}
