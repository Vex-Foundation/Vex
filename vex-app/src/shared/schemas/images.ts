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
 *  - `readThumb` returns a `data:` URL built from the ALREADY-VALIDATED stored
 *    bytes (≤20 KB, so this is cheap). `index.html`'s CSP is
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

/**
 * Hard byte cap. Not a UI nicety: the image bytes are embedded in the `create`
 * calldata of a real, irreversible on-chain transaction, so their size is
 * directly a gas cost the user pays. 20 KB is the launchpad's own practical
 * ceiling (`trench.launch_preview` documents that larger reverts on-chain).
 */
export const LOCKER_IMAGE_MAX_BYTES = 20_000;

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
      .max(LOCKER_IMAGE_MAX_BYTES),
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

export const imagesUploadResultSchema = z
  .object({ image: lockerImageSchema })
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
 * `dataUrl` is `data:<mime>;base64,<...>` over the stored bytes. Bounded by
 * construction: the stored bytes already passed the ≤20 KB cap, so the base64
 * expansion is ≈27 KB — small enough for a structured-clone IPC reply and for
 * the card to hold a handful in memory.
 */
export const imagesReadThumbResultSchema = z
  .object({
    imageId: lockerImageIdSchema,
    dataUrl: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),
  })
  .strict();
export type ImagesReadThumbResult = z.infer<typeof imagesReadThumbResultSchema>;
