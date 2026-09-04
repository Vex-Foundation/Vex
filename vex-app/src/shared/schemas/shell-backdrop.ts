/**
 * USER BACKDROP - the IPC contract for the user's own wallpaper under the
 * glass shell.
 *
 * THE BOUNDARY LAW OF THIS FILE, the same one the image locker (`images.ts`)
 * follows: no filesystem path and no raw bytes ever appear in any shape below,
 * in either direction.
 *  - `pick` takes NOTHING. Main opens its own `dialog.showOpenDialog`, so the
 *    renderer never learns, sends, or guesses a path; the traversal class is
 *    designed out of the contract rather than filtered out of a parameter.
 *  - `read` and `clear` take NOTHING either: there is exactly ONE backdrop per
 *    installation (no library), so there is no id for the renderer to name.
 *  - what comes back is an OPAQUE main-minted id (`bg_<32 hex>`), the
 *    validated dimensions and mime, and the `app://vex/user-backdrop/<id>` URL
 *    the app protocol serves the bytes from. `index.html` pins
 *    `img-src 'self'` and `app://vex` IS the document origin, so the image
 *    loads with no CSP change and no `data:` URL the size of the file.
 *
 * ACCEPTED FORMATS ARE PNG AND JPEG ONLY, and that set is a MEASUREMENT, not a
 * preference (2026-09-04, Electron 42.0.0, `nativeImage.createFromBuffer`
 * probed with a real VP8 lossy, a real VP8L lossless and the app's own
 * `midnight-lake.webp`): every WebP reports `isEmpty() === true` while PNG and
 * JPEG decode with their true size. The decode proof is the last gate on the
 * ingest path, and a format the decoder cannot prove is not offered in the
 * picker filter, not in this schema, and not in the copy. No header-only
 * acceptance for a format the decoder cannot prove (coordinator decision,
 * glass-decisions item 2).
 *
 * VALIDATION happens main-side: `stat` size gate BEFORE any byte is read,
 * magic-byte sniff (the extension is never trusted), a decode through
 * `nativeImage`, and a dimension band on the DECODED size. These schemas
 * describe the RESULT of that validation; they are not the validation.
 */

import { z } from "zod";

/**
 * The largest file the backdrop will read. 8 MiB, checked from `stat` before
 * a byte is read. A RESOURCE bound: a wallpaper is decoded into a bitmap in
 * the main process and painted full-window by the renderer, and 8 MiB of PNG
 * or JPEG already covers an 8K photograph.
 */
export const SHELL_BACKDROP_MAX_SOURCE_BYTES = 8_388_608;

/** Empty files are refused by name rather than sniffed and mis-reported. */
export const SHELL_BACKDROP_MIN_BYTES = 16;

/**
 * Dimension band, applied to the DECODED size (the decoder's truth, not the
 * header's claim). The floor is the smallest image that still reads as a
 * wallpaper across the whole window rather than as a tile; the ceiling is the
 * same 8192 the image locker uses, past which the decoded bitmap alone is a
 * quarter of a gigabyte.
 */
export const SHELL_BACKDROP_MIN_WIDTH = 640;
export const SHELL_BACKDROP_MIN_HEIGHT = 360;
export const SHELL_BACKDROP_MAX_DIMENSION = 8192;

/**
 * MIME allowlist. Decided by the MAGIC BYTES of the file and PROVEN by a
 * decode; never by the extension and never by anything the caller claims.
 * See the file header for why WebP is absent.
 */
export const SHELL_BACKDROP_MIME_TYPES = ["image/png", "image/jpeg"] as const;
export type ShellBackdropMime = (typeof SHELL_BACKDROP_MIME_TYPES)[number];

/**
 * Extensions the main-side picker OFFERS. A convenience filter, never the
 * validation: the magic bytes decide. Kept beside the mime list so the two
 * cannot drift apart silently (a table test pins them to each other).
 */
export const SHELL_BACKDROP_PICKER_EXTENSIONS = ["png", "jpg", "jpeg"] as const;

/**
 * Opaque backdrop id. `bg_` + 32 lowercase hex chars. Anchored, and free of
 * `/`, `\` and `.`, so an id can never be a relative path segment even before
 * the store's own containment check runs.
 */
export const SHELL_BACKDROP_ID_PATTERN = /^bg_[0-9a-f]{32}$/;

export const shellBackdropIdSchema = z
  .string()
  .regex(SHELL_BACKDROP_ID_PATTERN, "Not a backdrop id.");

/**
 * The app-protocol route the bytes are served from, relative to the
 * `app://vex` origin. ONE home for the prefix: main composes the served URL
 * and matches the incoming request against this same string.
 */
export const SHELL_BACKDROP_ROUTE_PREFIX = "/user-backdrop/";

export const SHELL_BACKDROP_URL_PATTERN = new RegExp(
  `^app://vex${SHELL_BACKDROP_ROUTE_PREFIX}bg_[0-9a-f]{32}$`,
);

export const shellBackdropMimeSchema = z.enum(SHELL_BACKDROP_MIME_TYPES);

const dimensionSchema = z
  .number()
  .int()
  .min(1)
  .max(SHELL_BACKDROP_MAX_DIMENSION);

/**
 * THE POINTER OF RECORD, persisted in `preferences.json` under
 * `shell.backdrop`. It is the ONLY record of which file is the backdrop and
 * what the validation proved about it; the byte file on disk carries a
 * neutral `.bin` name and no metadata of its own, so there is exactly one
 * place a later reader can learn the mime, and it is the place that was
 * written AFTER the bytes were proven.
 */
export const shellBackdropPointerSchema = z
  .object({
    imageId: shellBackdropIdSchema,
    mime: shellBackdropMimeSchema,
    width: dimensionSchema,
    height: dimensionSchema,
    byteLength: z.number().int().min(SHELL_BACKDROP_MIN_BYTES).max(SHELL_BACKDROP_MAX_SOURCE_BYTES),
  })
  .strict();
export type ShellBackdropPointer = z.infer<typeof shellBackdropPointerSchema>;

/** The record the renderer sees: the pointer plus the URL main serves it at. */
export const shellBackdropRecordSchema = shellBackdropPointerSchema
  .extend({
    url: z.string().regex(SHELL_BACKDROP_URL_PATTERN, "Not a backdrop URL."),
  })
  .strict();
export type ShellBackdropRecord = z.infer<typeof shellBackdropRecordSchema>;

/** Every input is EMPTY and STRICT: a path or an id smuggled in is refused before any handler runs. */
export const shellBackdropPickInputSchema = z.object({}).strict();
export const shellBackdropClearInputSchema = z.object({}).strict();
export const shellBackdropReadInputSchema = z.object({}).strict();

export type ShellBackdropPickInput = z.infer<typeof shellBackdropPickInputSchema>;
export type ShellBackdropClearInput = z.infer<typeof shellBackdropClearInputSchema>;
export type ShellBackdropReadInput = z.infer<typeof shellBackdropReadInputSchema>;

/**
 * `read` and `clear` answer with the current backdrop (or `null`: the shipped
 * artwork is in use). `clear` is `{ backdrop: null }` by construction.
 */
export const shellBackdropReadResultSchema = z
  .object({ backdrop: shellBackdropRecordSchema.nullable() })
  .strict();
export type ShellBackdropReadResult = z.infer<typeof shellBackdropReadResultSchema>;

export const shellBackdropClearResultSchema = z
  .object({ backdrop: z.null() })
  .strict();
export type ShellBackdropClearResult = z.infer<typeof shellBackdropClearResultSchema>;

/**
 * A dismissed picker is an ORDINARY outcome, not an error: `cancelled: true`
 * rides the ok path and `backdrop` echoes what is CURRENT (unchanged), so a
 * caller can always trust the record it is handed.
 */
export const shellBackdropPickResultSchema = z
  .object({
    backdrop: shellBackdropRecordSchema.nullable(),
    cancelled: z.boolean(),
  })
  .strict();
export type ShellBackdropPickResult = z.infer<typeof shellBackdropPickResultSchema>;
