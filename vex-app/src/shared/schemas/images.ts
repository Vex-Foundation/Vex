/**
 * Image locker schemas (contract C2) — the GLOBAL, persistent library of
 * pre-uploaded token-launch images.
 *
 * WHY IT EXISTS: an agent filling a Trench launch form itself has no image,
 * and a Vex launch REQUIRES one (our product rule — the Diamond accepts empty
 * image bytes, `launch_preview` proves it, so the requirement is enforced in
 * OUR handler, never assumed from the contract). The locker lets the user
 * pre-stage images so a FULL-autonomy mission can launch with nobody present.
 *
 * THE BOUNDARY LAW OF THIS FILE: no filesystem path and no raw bytes ever
 * appear in any shape below.
 *  - `upload` takes NOTHING. Main opens its own `dialog.showOpenDialog`
 *    (precedent: `main/ipc/onboarding/wallets/restore.ts`), so the renderer
 *    never learns, sends, or guesses a path — the whole traversal class is
 *    designed out rather than filtered.
 *  - `imageId` is OPAQUE: a main-generated `img_<32 hex>` token that is not
 *    derived from, and cannot be decoded into, a filename.
 *  - `readThumb` returns a `data:` URL built from the TRENCH ON-CHAIN COPY
 *    (≤20 KB by construction, so this is cheap) and never from the stored
 *    original, which since the 2026-08-19 per-lane decision may be megabytes.
 *    An image with no such copy has no cheap thumbnail and reports as missing
 *    rather than shipping multi-MB base64 over IPC. `index.html`'s CSP is
 *    `img-src 'self' data:`, so the card renders it without a path or a
 *    custom protocol.
 *
 * VALIDATION happens main-side on the RAW file, with NO decode and NO
 * transcode: no runtime image codec is packaged (`sharp` is devDependencies-
 * only and must not be added). See `main/images/image-validation.ts` for the
 * matrix. These schemas describe the RESULT of that validation; they are not
 * the validation.
 *
 * LIFECYCLE (C2): locker images are INDEPENDENT GLOBAL records. A launch
 * intent stores only an `imageId` reference; cancelling or expiring an intent
 * NEVER deletes an image. Explicit deletion REFUSES while a live (non-terminal)
 * intent references the image, and names it.
 */

import { z } from "zod";
import { TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES } from "@vex-lib/token-metadata-limits.js";

/**
 * The TRENCH budget for the derived on-chain copy. Not a UI nicety and NOT a
 * locker limit: on Trench the image bytes are embedded in the `create` calldata
 * of a real, irreversible on-chain transaction, so their size is directly a gas
 * cost the user pays. 20 KB is the launchpad's own practical ceiling
 * (`trench.launch_preview` documents that larger reverts on-chain).
 *
 * It is 20 000, slightly under the 20 480 hard ceiling
 * ({@link TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES}), so the ladder has somewhere
 * to land that no `>` / `>=` disagreement between modules can turn into a
 * failure.
 *
 * IT DOES NOT BIND POOLS.FUN, which hosts images off-chain (owner decision
 * 2026-08-19). Applying it to an ingest, an upload, or a stored original is the
 * bug this rename exists to make hard to write.
 */
export const TRENCH_ONCHAIN_IMAGE_MAX_BYTES = 20_000;

/**
 * The largest file the locker will read or record. 25 MiB.
 *
 * A RESOURCE BOUND, NOT A PRODUCT LIMIT (owner decree 2026-08-19). Nothing
 * about a launch says an image must be under 25 MiB; this exists so a
 * multi-gigabyte pick cannot be pulled into memory through the file picker or
 * written into a row. It is the same number as `DOWNSCALE_MAX_SOURCE_BYTES`
 * (which refuses from `stat`, before a byte is read) and as the
 * `launch_images.byte_length` CHECK in migration 080.
 */
export const LOCKER_IMAGE_MAX_SOURCE_BYTES = 26_214_400;

/** Empty files are rejected explicitly rather than sniffed and mis-reported. */
export const LOCKER_IMAGE_MIN_BYTES = 16;

/**
 * MIME allowlist. Decided by the MAGIC BYTES of the file, never by its
 * extension and never by anything the caller claims.
 */
export const LOCKER_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type LockerImageMime = (typeof LOCKER_IMAGE_MIME_TYPES)[number];

/**
 * Dimension plausibility band. A header that decodes to 0 or to something
 * absurd is a malformed/hostile header, not a small image — refuse rather
 * than record a number we cannot stand behind.
 */
export const LOCKER_IMAGE_MIN_DIMENSION = 1;
export const LOCKER_IMAGE_MAX_DIMENSION = 8192;

/** Display label length cap (derived main-side from the chosen file name). */
export const LOCKER_IMAGE_LABEL_MAX_LENGTH = 80;

/**
 * Opaque image id. `img_` + 32 lowercase hex chars. The pattern is anchored
 * and contains no `/`, `\`, or `.`, so an id can never be a relative path
 * segment even before the store's own containment check runs.
 */
export const LOCKER_IMAGE_ID_PATTERN = /^img_[0-9a-f]{32}$/;

export const lockerImageIdSchema = z
  .string()
  .regex(LOCKER_IMAGE_ID_PATTERN, "Not a locker image id.");

/** sha256 of the STORED bytes, lowercase hex. Bound into the C0 authorization. */
export const lockerImageDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Not a sha256 digest.");

/** The C2 record. This is the ONLY shape the renderer and the agent ever see. */
export const lockerImageSchema = z
  .object({
    imageId: lockerImageIdSchema,
    label: z.string().min(1).max(LOCKER_IMAGE_LABEL_MAX_LENGTH),
    byteLength: z
      .number()
      .int()
      .min(LOCKER_IMAGE_MIN_BYTES)
      .max(LOCKER_IMAGE_MAX_SOURCE_BYTES),
    mime: z.enum(LOCKER_IMAGE_MIME_TYPES),
    width: z
      .number()
      .int()
      .min(LOCKER_IMAGE_MIN_DIMENSION)
      .max(LOCKER_IMAGE_MAX_DIMENSION),
    height: z
      .number()
      .int()
      .min(LOCKER_IMAGE_MIN_DIMENSION)
      .max(LOCKER_IMAGE_MAX_DIMENSION),
    digest: lockerImageDigestSchema,
    /**
     * Size of the derived TRENCH on-chain copy, or `null` when none could be
     * derived.
     *
     * The smallest honest shape for what the renderer has to know: `null` is
     * the only signal that an image is pools-only, and the card badges it so a
     * user does not discover it at the moment a Trench launch refuses. The
     * variant's DIGEST is deliberately NOT here — it is signing material, main
     * keeps it, and the renderer has no use for it.
     */
    onchainByteLength: z
      .number()
      .int()
      .positive()
      .max(TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES)
      .nullable(),
    uploadedAt: z.string().datetime(),
  })
  .strict();

export type LockerImage = z.infer<typeof lockerImageSchema>;

// ── `images.list` ─────────────────────────────────────────────────────────

/**
 * No input. The locker is GLOBAL by contract, so there is deliberately no
 * `sessionId` to narrow (or to widen) it by.
 */
export const imagesListInputSchema = z.object({}).strict();
export type ImagesListInput = z.infer<typeof imagesListInputSchema>;

export const imagesListResultSchema = z
  .object({ images: z.array(lockerImageSchema) })
  .strict();
export type ImagesListResult = z.infer<typeof imagesListResultSchema>;

// ── `images.upload` ───────────────────────────────────────────────────────

/**
 * Deliberately empty: main owns the file picker. A renderer-supplied path is
 * not merely unnecessary here, it is the thing this design refuses to accept.
 * A user cancelling the picker returns `internal.cancelled`, not an error the
 * UI should shout about.
 */
export const imagesUploadInputSchema = z.object({}).strict();
export type ImagesUploadInput = z.infer<typeof imagesUploadInputSchema>;

/**
 * What was derived for Trench, when a derivation actually happened.
 *
 * THE ORIGINAL IS ALWAYS STORED VERBATIM now, so this is no longer the claim
 * "we changed your image" — it is the claim "we ALSO made a small square copy
 * for Trench". OPTIONAL AND ABSENT when the original was already inside the
 * on-chain budget and is therefore its own copy, and absent as well when no
 * copy could be derived at all (`image.onchainByteLength === null` says that,
 * and says it permanently rather than only on the upload that created it).
 *
 * Both figures are raw byte counts so the UI can state the actual sizes rather
 * than a percentage nobody can check.
 */
export const imageOnchainVariantSchema = z
  .object({
    originalByteLength: z.number().int().positive().max(LOCKER_IMAGE_MAX_SOURCE_BYTES),
    variantByteLength: z
      .number()
      .int()
      .positive()
      .max(TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES),
  })
  .strict();
export type ImageOnchainVariant = z.infer<typeof imageOnchainVariantSchema>;

export const imagesUploadResultSchema = z
  .object({ image: lockerImageSchema, onchainVariant: imageOnchainVariantSchema.optional() })
  .strict();
export type ImagesUploadResult = z.infer<typeof imagesUploadResultSchema>;

// ── `images.delete` ───────────────────────────────────────────────────────

export const imagesDeleteInputSchema = z
  .object({ imageId: lockerImageIdSchema })
  .strict();
export type ImagesDeleteInput = z.infer<typeof imagesDeleteInputSchema>;

export const imagesDeleteResultSchema = z
  .object({ imageId: lockerImageIdSchema })
  .strict();
export type ImagesDeleteResult = z.infer<typeof imagesDeleteResultSchema>;

// ── `images.readThumb` ────────────────────────────────────────────────────

export const imagesReadThumbInputSchema = z
  .object({ imageId: lockerImageIdSchema })
  .strict();
export type ImagesReadThumbInput = z.infer<typeof imagesReadThumbInputSchema>;

/**
 * `dataUrl` is `data:<mime>;base64,<...>` over the TRENCH ON-CHAIN COPY, never
 * over the stored original. Bounded by construction: that copy is ≤20 KB, so
 * the base64 expansion is ≈27 KB — small enough for a structured-clone IPC
 * reply and for the card to hold a handful in memory. Reading the original
 * instead would put a multi-megabyte string on the IPC bus for every tile.
 *
 * An image with no on-chain copy therefore has no thumbnail, and the handler
 * answers `images.not_found` rather than inventing an expensive one.
 */
export const imagesReadThumbResultSchema = z
  .object({
    imageId: lockerImageIdSchema,
    dataUrl: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),
  })
  .strict();
export type ImagesReadThumbResult = z.infer<typeof imagesReadThumbResultSchema>;
