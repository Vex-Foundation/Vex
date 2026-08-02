/**
 * The image locker (C2) — orchestration over the byte store and the metadata
 * repo. No Electron imports: the file picker belongs to the IPC handler, so
 * this module stays a plain async unit that takes a path and returns a verdict.
 *
 * OWNERSHIP SPLIT, stated once here because it is the thing to get right:
 *  - METADATA is owned by Lane A's `@vex-agent/db/repos/launch-images.js`
 *    (table `launch_images`, migration 062). It is the single source of truth
 *    for what an image IS. Main imports it directly — main → agent runtime is
 *    the legal direction (`check-process-boundaries.mjs` forbids `@vex-agent`
 *    in renderer/shared only; precedent: `ipc/sessions/plan.ts`).
 *  - BYTES are owned by `./byte-store.ts`, under userData, keyed by the same
 *    opaque id.
 * Deliberately NOT a second metadata index main-side: two records of the same
 * fact drift, and the one that drifts here would be the digest an on-chain
 * authorization was signed against.
 *
 * OVERSIZED IMAGES ARE OPTIMIZED, NOT REFUSED (`./downscale.ts`). The 20 KB cap
 * stays — it is gas on an irreversible transaction, not a storage limit — so an
 * over-budget pick is re-encoded down to fit before anything else looks at it.
 * An image that already fits is stored byte-identical.
 *
 * DELETION ORDER IS LOAD-BEARING (Lane A's correction): the repo owns the
 * whole rule in ONE transaction, because a check-then-delete in main has a
 * TOCTOU window in which a launch intent could be created between the check
 * and the delete. So we ask the repo to delete the ROW first and remove the
 * BYTES only once it reports `deleted: true`. Losing bytes while a row
 * survives is a recoverable inconsistency; the reverse is a live launch about
 * to sign against an image that no longer exists.
 */

import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import {
  deleteLaunchImage,
  getLaunchImage,
  insertLaunchImage,
  listLaunchImages,
  type DeleteLaunchImageResult,
  type LaunchImageRow,
} from "@vex-agent/db/repos/launch-images.js";
import {
  lockerImageSchema,
  LOCKER_IMAGE_MAX_BYTES,
  type LockerImage,
} from "@shared/schemas/images.js";
import { log } from "../logger/index.js";
import {
  digestOf,
  newLockerImageId,
  readImageBytes,
  removeImageBytes,
  writeImageBytes,
} from "./byte-store.js";
import {
  deriveLockerImageLabel,
  validateLockerImageBytes,
  type LockerImageRejection,
} from "./image-validation.js";
import {
  downscaleLockerImage,
  DOWNSCALE_MAX_SOURCE_BYTES,
} from "./downscale.js";

/**
 * What the ladder did, when it did something. ABSENT on an untouched image, so
 * "we changed your file" is never implied about bytes we stored verbatim.
 */
export interface LockerImageOptimization {
  readonly originalByteLength: number;
  readonly storedByteLength: number;
}

export type StoreImageOutcome =
  | {
      readonly ok: true;
      readonly image: LockerImage;
      readonly optimization?: LockerImageOptimization;
    }
  | { readonly ok: false; readonly rejection: LockerImageRejection };

/**
 * Ingest a file the USER picked in main's own dialog.
 *
 * `sourcePath` comes from `dialog.showOpenDialog` and from nowhere else — it
 * is never renderer- or model-supplied. Order: size (from `stat`, so an
 * enormous file is refused without ever being read into memory) → read →
 * magic-byte + header validation → bytes → metadata row.
 *
 * The metadata row is written LAST. If it fails, the orphaned bytes are
 * removed on the way out, so a failed upload cannot leave a file the locker
 * has no record of.
 */
export async function storeLockerImageFromFile(sourcePath: string): Promise<StoreImageOutcome> {
  const size = (await stat(sourcePath)).size;
  // The cap no longer bounds what we READ — an oversized file is now a
  // candidate for optimization, not an immediate refusal — so a separate,
  // much larger ceiling stops a multi-gigabyte pick from being pulled into
  // memory. Refused from `stat`, before a single byte is read.
  if (size > DOWNSCALE_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      rejection: { kind: "too_large", byteLength: size, maxBytes: LOCKER_IMAGE_MAX_BYTES },
    };
  }

  const original = new Uint8Array(await readFile(sourcePath));

  // NORMALIZE FIRST. Everything downstream — validation, the digest, the stored
  // metadata — must describe the bytes that actually land on disk.
  const downscaled = downscaleLockerImage(original);
  if (downscaled.kind === "undecodable") {
    return {
      ok: false,
      rejection: {
        kind: "unsupported_format",
        reason: "the file could not be decoded as an image",
      },
    };
  }
  if (downscaled.kind === "exhausted") {
    return {
      ok: false,
      rejection: {
        kind: "too_large",
        byteLength: downscaled.smallestByteLength,
        maxBytes: LOCKER_IMAGE_MAX_BYTES,
      },
    };
  }

  const bytes = downscaled.bytes;
  const validation = validateLockerImageBytes(bytes);
  if (!validation.ok) return { ok: false, rejection: validation.rejection };

  const imageId = newLockerImageId();
  await writeImageBytes(imageId, bytes);
  try {
    const row = await insertLaunchImage({
      imageId,
      label: deriveLockerImageLabel(sourcePath),
      byteLength: validation.byteLength,
      mime: validation.mime,
      width: validation.width,
      height: validation.height,
      // The digest of what is STORED, never of the original: this hash travels
      // into a launch authorization and is compared on the signing path, so it
      // has to describe the bytes that will be written on-chain.
      digest: digestOf(bytes),
    });
    const image = lockerImageSchema.parse(row);
    if (downscaled.kind === "optimized") {
      log.info(
        `[images:store] optimized ${downscaled.originalByteLength}B -> ${bytes.byteLength}B`,
      );
      return {
        ok: true,
        image,
        optimization: {
          originalByteLength: downscaled.originalByteLength,
          storedByteLength: bytes.byteLength,
        },
      };
    }
    return { ok: true, image };
  } catch (cause) {
    await removeImageBytes(imageId).catch(() => undefined);
    throw cause;
  }
}

/**
 * Every locker image, most-recent first (the repo orders it).
 *
 * A row that does not satisfy the C2 shape is SKIPPED with a warning rather
 * than failing the whole read: one malformed row must not make the user's
 * entire locker unreachable. The count is logged so the skip is visible
 * instead of silent.
 */
export async function listLockerImages(): Promise<LockerImage[]> {
  const rows = await listLaunchImages();
  const images: LockerImage[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = lockerImageSchema.safeParse(row);
    if (parsed.success) images.push(parsed.data);
    else skipped += 1;
  }
  if (skipped > 0) {
    log.warn(`[images] skipped ${skipped} launch_images row(s) that failed the C2 shape`);
  }
  return images;
}

/** Metadata for one image, or `null` when the id is unknown. */
export async function getLockerImage(imageId: string): Promise<LockerImage | null> {
  const row = await getLaunchImage(imageId);
  if (row === null) return null;
  const parsed = lockerImageSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export type DeleteLockerImageOutcome = DeleteLaunchImageResult;

/**
 * Explicit deletion. The repo is the gate (see the header note on ordering);
 * this function's only added responsibility is removing the bytes once the
 * row is provably gone.
 */
export async function deleteLockerImage(imageId: string): Promise<DeleteLockerImageOutcome> {
  const outcome = await deleteLaunchImage(imageId);
  if (outcome.deleted) await removeImageBytes(imageId);
  return outcome;
}

/**
 * A `data:` URL over the stored bytes, for the sidebar card's thumbnail grid.
 *
 * The MIME comes from the METADATA ROW — i.e. from the magic-byte validation
 * performed at upload — never from a re-sniff and never from a file name. The
 * digest is re-verified on the way out: a `data:` URL whose bytes no longer
 * match what the locker recorded would be showing the user one image while
 * the launch path signs over another.
 *
 * `null` means the id (or its bytes) are gone.
 */
export async function readLockerImageDataUrl(imageId: string): Promise<string | null> {
  const image = await getLockerImage(imageId);
  if (image === null) return null;
  const bytes = await readImageBytes(imageId);
  if (bytes === null) return null;
  if (digestOf(bytes) !== image.digest) {
    log.warn(`[images] digest mismatch for a stored image; refusing to render it`);
    return null;
  }
  return `data:${image.mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export type { LaunchImageRow };
