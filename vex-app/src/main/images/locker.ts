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
 * TWO VARIANTS PER IMAGE (owner decision 2026-08-19). The ORIGINAL is stored
 * VERBATIM — no downscale, no crop, ever — because pools.fun hosts images
 * off-chain and has no size limit of ours (measured: its upload endpoint
 * accepted a 2,104,822-byte PNG byte-identically). Trench does write the bytes
 * on-chain, so a SECOND copy under its 20 KB budget is DERIVED at ingest by
 * `./downscale.ts`:
 *  - the original already fits  -> it IS the copy, no second file is written,
 *    and `onchain_digest === digest` records exactly that;
 *  - the ladder re-encodes      -> the copy lands beside the original in the
 *    byte store and carries its own digest;
 *  - the ladder is exhausted    -> the image is stored with NO copy. It is a
 *    perfectly good pools.fun image; only Trench refuses it, by name. An
 *    upload is not refused for a limit that binds one of two launchpads.
 *
 * The 25 MiB read ceiling is a RESOURCE bound, not a product limit, and is the
 * only size at which an upload is still refused outright.
 *
 * DELETION ORDER IS LOAD-BEARING (Lane A's correction): the repo owns the
 * whole rule in ONE transaction, because a check-then-delete in main has a
 * TOCTOU window in which a launch intent could be created between the check
 * and the delete. So we ask the repo to delete the ROW first and remove BOTH
 * BYTE FILES only once it reports `deleted: true`. Losing bytes while a row
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
  type LiveIntentReference,
} from "@vex-agent/db/repos/launch-images.js";
import {
  lockerImageSchema,
  LOCKER_IMAGE_MAX_SOURCE_BYTES,
  type ImageOnchainVariant,
  type LockerImage,
} from "@shared/schemas/images.js";
import { log } from "../logger/index.js";
import {
  digestOf,
  newLockerImageId,
  readImageBytes,
  readOnchainVariantBytes,
  removeImageBytes,
  removeOnchainVariantBytes,
  writeImageBytes,
  writeOnchainVariantBytes,
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

export type StoreImageOutcome =
  | {
      readonly ok: true;
      readonly image: LockerImage;
      /**
       * Present ONLY when the ladder actually re-encoded. Absent covers two
       * different situations on purpose, because neither is "we changed your
       * image": the original was already its own on-chain copy, or no copy
       * could be derived at all. `image.onchainByteLength` distinguishes them,
       * and does so permanently rather than only on this one reply.
       */
      readonly onchainVariant?: ImageOnchainVariant;
    }
  | { readonly ok: false; readonly rejection: LockerImageRejection };

/**
 * The metadata row, narrowed to the C2 shape the renderer and the agent see.
 *
 * `onchainDigest` is dropped here deliberately: it is signing material with no
 * consumer outside main, and the smallest shape that leaves this module is the
 * one that cannot leak it.
 */
function toLockerImage(row: LaunchImageRow): LockerImage | null {
  const parsed = lockerImageSchema.safeParse({
    imageId: row.imageId,
    label: row.label,
    byteLength: row.byteLength,
    mime: row.mime,
    width: row.width,
    height: row.height,
    digest: row.digest,
    onchainByteLength: row.onchainByteLength,
    uploadedAt: row.uploadedAt,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Ingest a file the USER picked in main's own dialog.
 *
 * `sourcePath` comes from `dialog.showOpenDialog` and from nowhere else — it
 * is never renderer- or model-supplied. Order: size (from `stat`, so an
 * enormous file is refused without ever being read into memory) → read →
 * magic-byte + header validation OF THE ORIGINAL → derive the Trench copy →
 * bytes → metadata row.
 *
 * VALIDATION RUNS ON THE ORIGINAL because the original is what is stored and
 * what a pools.fun launch uploads. The derived copy is produced by our own
 * encoder from bytes that already passed, so re-validating it would only be
 * asking Electron whether it trusts itself.
 *
 * The metadata row is written LAST. If it fails, the orphaned bytes — both
 * files — are removed on the way out, so a failed upload cannot leave a file
 * the locker has no record of.
 */
export async function storeLockerImageFromFile(sourcePath: string): Promise<StoreImageOutcome> {
  const size = (await stat(sourcePath)).size;
  // A RESOURCE bound, not a product limit: it stops a multi-gigabyte pick from
  // being pulled into memory. Refused from `stat`, before a single byte is read.
  if (size > DOWNSCALE_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      rejection: { kind: "too_large", byteLength: size, maxBytes: LOCKER_IMAGE_MAX_SOURCE_BYTES },
    };
  }

  const original = new Uint8Array(await readFile(sourcePath));
  const validation = validateLockerImageBytes(original);
  if (!validation.ok) return { ok: false, rejection: validation.rejection };

  const derived = downscaleLockerImage(original);
  // Still a refusal: a file that our own decoder cannot open is not an image we
  // can stand behind on either launchpad, whatever its magic bytes claim.
  if (derived.kind === "undecodable") {
    return {
      ok: false,
      rejection: {
        kind: "unsupported_format",
        reason: "the file could not be decoded as an image",
      },
    };
  }

  const digest = digestOf(original);
  // `exhausted` is NOT a refusal any more: the image is stored with no on-chain
  // copy, which is the truthful record of "usable on pools.fun, not on Trench".
  const variantBytes = derived.kind === "optimized" ? derived.bytes : null;
  const onchainByteLength =
    derived.kind === "unchanged"
      ? validation.byteLength
      : variantBytes === null
        ? null
        : variantBytes.byteLength;
  const onchainDigest =
    derived.kind === "unchanged" ? digest : variantBytes === null ? null : digestOf(variantBytes);

  const imageId = newLockerImageId();
  await writeImageBytes(imageId, original);
  if (variantBytes !== null) await writeOnchainVariantBytes(imageId, variantBytes);
  try {
    const row = await insertLaunchImage({
      imageId,
      label: deriveLockerImageLabel(sourcePath),
      byteLength: validation.byteLength,
      mime: validation.mime,
      width: validation.width,
      height: validation.height,
      // The digest of the ORIGINAL, which is what is on disk under this id and
      // what a pools.fun launch uploads.
      digest,
      // The digest of the bytes a TRENCH launch will write on-chain. It travels
      // into that launch's authorization and is compared on the signing path.
      onchainByteLength,
      onchainDigest,
    });
    const image = toLockerImage(row);
    if (image === null) {
      throw new Error("launch_images: the inserted row does not satisfy the C2 shape");
    }
    if (derived.kind === "optimized" && variantBytes !== null) {
      log.info(
        `[images:store] on-chain copy derived ${derived.originalByteLength}B -> ${variantBytes.byteLength}B`,
      );
      return {
        ok: true,
        image,
        onchainVariant: {
          originalByteLength: derived.originalByteLength,
          variantByteLength: variantBytes.byteLength,
        },
      };
    }
    if (derived.kind === "exhausted") {
      log.info(`[images:store] no on-chain copy could be derived; the image is pools-only`);
    }
    return { ok: true, image };
  } catch (cause) {
    await removeImageBytes(imageId).catch(() => undefined);
    await removeOnchainVariantBytes(imageId).catch(() => undefined);
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
    const image = toLockerImage(row);
    if (image !== null) images.push(image);
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
  return row === null ? null : toLockerImage(row);
}

export type DeleteLockerImageOutcome = DeleteLaunchImageResult;

/**
 * Explicit deletion. The repo is the gate (see the header note on ordering);
 * this function's only added responsibility is removing the bytes once the
 * row is provably gone.
 */
export async function deleteLockerImage(imageId: string): Promise<DeleteLockerImageOutcome> {
  const outcome = await deleteLaunchImage(imageId);
  if (outcome.deleted) {
    await removeImageBytes(imageId);
    // Idempotent, and absent for every image that was its own on-chain copy.
    await removeOnchainVariantBytes(imageId);
  }
  return outcome;
}

/**
 * The TRENCH ON-CHAIN COPY's bytes, fully verified, or `null`.
 *
 * THE ONE OWNER of "which file holds the on-chain copy, and is it intact". Both
 * consumers — the launch byte resolver and the thumbnail — go through it, so
 * the digest-equality rule that encodes "no second file" is written once.
 *
 * `null` covers three cases the callers each handle by name: no such image, no
 * on-chain copy was ever derived, or the bytes on disk no longer match the
 * digest the locker recorded. The last one is deliberately NOT distinguished
 * from a missing image on the signing path: an image swapped on disk between
 * authorization and execution must look exactly like an absent one, which is a
 * refusal the caller already has.
 */
export async function readLockerImageOnchainBytes(
  imageId: string,
): Promise<{ readonly bytes: Uint8Array; readonly digest: string } | null> {
  const row = await getLaunchImage(imageId);
  if (row === null) return null;
  if (row.onchainDigest === null || row.onchainByteLength === null) return null;

  const isOriginal = row.onchainDigest === row.digest;
  const bytes = isOriginal
    ? await readImageBytes(imageId)
    : await readOnchainVariantBytes(imageId);
  if (bytes === null) return null;

  if (digestOf(bytes) !== row.onchainDigest) {
    // Structural log only — never the digests themselves, which are content
    // fingerprints of user material.
    log.error("[images] the on-chain copy does not match its recorded digest; refusing it");
    return null;
  }
  if (bytes.byteLength !== row.onchainByteLength) {
    log.error("[images] the on-chain copy's length disagrees with the recorded metadata; refusing");
    return null;
  }
  return { bytes, digest: row.onchainDigest };
}

/**
 * A `data:` URL for the sidebar card's thumbnail grid, over the TRENCH ON-CHAIN
 * COPY.
 *
 * IT IS NOT THE ORIGINAL, and that is the point: originals are now unbounded in
 * practice, and base64 of a 2 MB photo on the IPC bus for every tile is a cost
 * nobody asked for. The copy is ≤20 KB by construction. An image with no copy
 * has no cheap thumbnail at all and answers `null` rather than being rendered
 * expensively.
 *
 * The MIME is SNIFFED from the bytes being rendered rather than read from the
 * metadata row, because the row describes the ORIGINAL: a PNG whose copy the
 * ladder re-encoded to JPEG would otherwise be labelled `image/png` in the
 * `data:` URL. Sniffing is the same magic-byte rule the upload path uses.
 *
 * `null` means the id, its copy, or its bytes are gone.
 */
export async function readLockerImageDataUrl(imageId: string): Promise<string | null> {
  const resolved = await readLockerImageOnchainBytes(imageId);
  if (resolved === null) return null;
  const validation = validateLockerImageBytes(resolved.bytes);
  if (!validation.ok) {
    log.warn(`[images] the on-chain copy is not a renderable image; refusing to render it`);
    return null;
  }
  return `data:${validation.mime};base64,${Buffer.from(resolved.bytes).toString("base64")}`;
}

export type { LaunchImageRow, LiveIntentReference };
