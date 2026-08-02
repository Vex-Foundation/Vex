import type { Result } from "../../../ipc/result.js";
import type {
  ImagesDeleteInput,
  ImagesDeleteResult,
  ImagesListInput,
  ImagesListResult,
  ImagesReadThumbInput,
  ImagesReadThumbResult,
  ImagesUploadInput,
  ImagesUploadResult,
} from "../../../schemas/images.js";

/**
 * Image locker (C2) — the GLOBAL, persistent library of pre-staged
 * token-launch images, shared by the user's sidebar card and the agent's
 * `trench.images` read tool. It exists because an agent filling a launch form
 * has no image and a Vex launch REQUIRES one (our product rule, not the
 * Diamond's), so a fully autonomous mission depends on images staged in
 * advance by a human who is no longer present.
 *
 * FOUR THINGS THIS INTERFACE DELIBERATELY DOES NOT OFFER:
 *  - a path, in either direction;
 *  - raw bytes, in either direction;
 *  - a session scope — the locker is global, so there is nothing to narrow
 *    (or to widen) it by;
 *  - an upload input. `upload` takes an EMPTY payload because MAIN opens the
 *    file picker itself. The renderer cannot name a file, which is why this
 *    surface has no traversal to filter.
 *
 * `upload` resolves to `internal.cancelled` when the user dismisses the
 * picker — an ordinary outcome the UI should absorb quietly, not an error.
 *
 * `delete` fails with `images.in_use` while a LIVE launch intent references
 * the image, and the message names it. That refusal is the C2 lifecycle
 * guarantee: cancelling or expiring an intent never deletes an image, and an
 * explicit deletion never pulls bytes out from under a launch that may still
 * be about to sign over their digest.
 *
 * `readThumb` returns a `data:` URL over the already-validated stored bytes
 * (≤20 KB). It is separate from `list` so the metadata read stays cheap; the
 * card fetches thumbnails per tile rather than in one batch.
 */
export interface ImagesBridge {
  readonly list: (input: ImagesListInput) => Promise<Result<ImagesListResult>>;
  readonly upload: (input: ImagesUploadInput) => Promise<Result<ImagesUploadResult>>;
  readonly delete: (input: ImagesDeleteInput) => Promise<Result<ImagesDeleteResult>>;
  readonly readThumb: (
    input: ImagesReadThumbInput,
  ) => Promise<Result<ImagesReadThumbResult>>;
}
