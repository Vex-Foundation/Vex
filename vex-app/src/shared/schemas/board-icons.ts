/**
 * BOARD TOKEN ICONS - the IPC contract for one board card's logo.
 *
 * WHAT CROSSES, AND WHAT DOES NOT. The renderer sends an OPAQUE `iconId` that
 * it read out of a persisted board and receives either a `data:` URL or a named
 * absence. No host, no URL, no path and no raw byte array appears in any shape
 * below, in either direction. The renderer therefore gains no network
 * authority from this channel: main owns the origin, the allowlist, the byte
 * bound and the image validation, exactly as it owns the file picker on the
 * image locker's `upload`.
 *
 * WHY THE ANSWER IS A SUCCESS UNION AND NOT AN ERROR. Around half of the pools
 * a board can carry have no profile artwork at all, so "there is no icon" is
 * the ORDINARY outcome of this call, not a failure of it. Modelling it as a
 * `Result` error would make the common case look broken to every caller and
 * would flatten four genuinely different facts into one. They stay apart:
 *
 *   image              the bytes were fetched, identified and are in bounds;
 *   absent             settled: the provider has no such icon;
 *   refused_by_policy  settled: the provider HAS one and this app declined it
 *                      (bytes it cannot identify, or past the byte ceiling);
 *   unavailable        nothing was learned. The transport failed, the service
 *                      was busy, or it was not mounted yet. Asking may answer.
 *
 * A `Result` ERROR from this channel therefore means only what it should: the
 * input did not validate, or the sender was not trusted.
 *
 * `dataUrl`'s regex is the same shape the image locker's `readThumb` uses, and
 * for the same reason: `index.html` pins `img-src 'self' data:`, so a base64
 * `data:` URL of an already-validated image is the one way a picture reaches a
 * card without a path, a custom protocol or a CSP change.
 */

import { z } from "zod";
import { BOARD_ICON_ID_PATTERN } from "@vex-lib/board/index.js";

/**
 * The icon handle, re-declared against the SAME pattern the board contract
 * publishes rather than a hand-copied one: `@vex-lib/board` is the single
 * definition and this schema imports it, so the durable document and this
 * boundary can never disagree about what an id may contain.
 *
 * It admits no dot and no slash, so an id cannot be a path segment even before
 * main's own host-and-prefix allowlist runs. Validation is not authorization:
 * a well-formed id still reaches nothing but the one CDN prefix.
 */
export const boardIconIdSchema = z
  .string()
  .regex(BOARD_ICON_ID_PATTERN, "Not a board token icon id.");

export const boardIconReadInputSchema = z
  .object({ iconId: boardIconIdSchema })
  .strict();
export type BoardIconReadInput = z.infer<typeof boardIconReadInputSchema>;

/** Settled ABSENCE: the provider has nothing under this handle. */
export const BOARD_ICON_ABSENT_REASONS = [
  /** The CDN has no icon under this handle (HTTP 404). */
  "not_found",
] as const;

/**
 * Settled REFUSAL: the provider served something and this app declined it.
 *
 * A third class, and not a flavour of either neighbour, because it makes a
 * different claim from both. `absent` says the token has no picture, which is
 * false here - the provider published one. `unavailable` says nothing was
 * learned and asking again may answer, which is also false: the verdict is
 * deterministic for these bytes, so re-asking only re-downloads them.
 */
export const BOARD_ICON_REFUSED_REASONS = [
  /** Served bytes whose declared type, magic bytes or dimensions do not hold up. */
  "unsupported_image",
  /** The body passed the byte ceiling and the transfer was stopped. */
  "over_cap",
] as const;

/** Unknown outcomes: nothing was learned about the icon. */
export const BOARD_ICON_UNAVAILABLE_REASONS = [
  /** The fetch queue was full. Icons yield the pipe to real work. */
  "busy",
  /** Timeout, cancellation, refusal, or a non-200 that says nothing. */
  "transport",
  /** The service is not mounted (early startup, or shutdown in progress). */
  "not_mounted",
] as const;

export const boardIconSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      dataUrl: z
        .string()
        .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("absent"),
      reason: z.enum(BOARD_ICON_ABSENT_REASONS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("refused_by_policy"),
      reason: z.enum(BOARD_ICON_REFUSED_REASONS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum(BOARD_ICON_UNAVAILABLE_REASONS),
    })
    .strict(),
]);
export type BoardIcon = z.infer<typeof boardIconSchema>;

/**
 * The id is echoed so a caller holding several in flight can pair an answer
 * with its request without relying on resolution order.
 */
export const boardIconReadResultSchema = z
  .object({ iconId: boardIconIdSchema, icon: boardIconSchema })
  .strict();
export type BoardIconReadResult = z.infer<typeof boardIconReadResultSchema>;
