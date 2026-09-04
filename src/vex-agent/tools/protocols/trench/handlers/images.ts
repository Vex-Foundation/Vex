/**
 * `trench.images` handler - READ-ONLY listing of the user's image locker (C2).
 *
 * METADATA ONLY, and that is a rule rather than an optimisation (rule 07):
 * the bytes live in the desktop app's own store under userData, they are
 * never serialised into a tool result, and nothing here can reach them. The
 * model chooses an `imageId`; the BYTES are resolved later, main-side, on the
 * signing path through the C2b resolver seam, where the recorded digest is
 * verified against the authorization record before anything is signed.
 *
 * The metadata itself is an ordinary DB-backed read through
 * `db/repos/launch-images.ts` (Lane A) - deliberately NOT a new
 * `ProtocolExecutionContext` seam. The locker is GLOBAL, so the read is
 * unscoped: an image belongs to the user, not to a session or a mission.
 *
 * THE EMPTY CASE IS THE IMPORTANT ONE. An empty locker is not an error and is
 * not a failure: it is a `success` result whose payload tells the agent, in
 * words it can pass straight to the user, that a human has to upload an image
 * on the right side of the app before any launch can proceed. Returning
 * `fail` here would read to the model as "the tool is broken, try something
 * else", when the correct behaviour is to stop and ask.
 */

import { listLaunchImages } from "../../../../db/repos/launch-images.js";
import { ok, fail, num } from "../../handler-helpers.js";
import { trenchFailureDetail } from "./failure.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** What the model sees. No path, no bytes, no digest. */
interface LockerImageRow {
  imageId: string;
  label: string;
  mime: string;
  byteLength: number;
  width: number;
  height: number;
  uploadedAt: string;
}

const EMPTY_LOCKER_GUIDANCE =
  "The image locker is empty. A Trench launch requires an image and you cannot upload one - " +
  "ask the user to add an image in the TRENCH PHOTOS card on the right side of the app, then " +
  "check again. Do not attempt a launch until an image is available.";

export async function trenchImagesHandler(p: Record<string, unknown>) {
  const requested = num(p, "limit");
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > MAX_LIMIT)) {
    return fail(`"limit" must be a whole number between 1 and ${MAX_LIMIT}.`);
  }
  const limit = requested ?? DEFAULT_LIMIT;

  let rows;
  try {
    rows = await listLaunchImages();
  } catch (err) {
    return fail(
      `The image locker could not be read (${trenchFailureDetail("trench__images_list", err)}). ` +
        `Do not launch without confirming an image - retry the listing first.`,
    );
  }

  // The repo already orders most-recent-first; slicing keeps that order.
  const images: LockerImageRow[] = rows.slice(0, limit).map((row) => ({
    imageId: row.imageId,
    label: row.label,
    mime: row.mime,
    byteLength: row.byteLength,
    width: row.width,
    height: row.height,
    uploadedAt: row.uploadedAt,
  }));

  // Pagination class `bounded_non_pageable` (parameter-vocabulary.md section
  // 4.1): this read takes `limit` and offers NO continuation, so the only
  // honest thing the reply can do about the rows it dropped is say that it
  // dropped them and name the knob that brings them back. Both counts were
  // already in hand; nothing here reads the locker a second time.
  const dropped = rows.length - images.length;
  const truncated = dropped > 0;

  return ok({
    count: images.length,
    totalAvailable: rows.length,
    truncated,
    ...(truncated
      ? {
        truncationNote:
            `${dropped === 1 ? "1 more image exists" : `${dropped} more images exist`} in the locker beyond this reply. `
            + "There is no continuation through this tool - no cursor, no page - so "
            + (limit < MAX_LIMIT
              ? `raise \`limit\` (maximum ${MAX_LIMIT}) to see them.`
              : `the locker holds more than the maximum \`limit\` of ${MAX_LIMIT}, and the rest are `
                + "unreachable here; ask the user which image they mean if it is not listed."),
      }
      : {}),
    images,
    ...(images.length === 0 ? { guidance: EMPTY_LOCKER_GUIDANCE } : {}),
  });
}
