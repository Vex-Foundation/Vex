/**
 * One locker tile - the thumbnail, its label, and, where the rail may delete,
 * its delete affordance.
 *
 * REMOVAL IS A CAPABILITY THE HOST HANDS IN, not a fact about the tile. A
 * session rail may delete; a project LAUNCHPAD is browse-only (Studio parity
 * decree, 2026-09-04) and hands in `null`, and the tile then renders NO delete
 * control at all - not a disabled one, not a hidden one. A control that exists
 * but cannot act is a promise the rail cannot keep.
 *
 * Its own `data:` URL is fetched here rather than by the card, so the metadata
 * list stays a cheap read and a growing locker never turns one render into one
 * enormous payload. The bytes behind an `imageId` are immutable, so the query
 * never refetches.
 *
 * THE THUMBNAIL IS THE SMALL DERIVED COPY, which is why an image that has no
 * such copy shows none: the original may be megabytes, and rendering it would
 * push that over IPC for every tile. Such an image is not broken and it is not
 * unusable - it launches exactly like any other - so the tile says NO PREVIEW
 * rather than leaving the user with an empty square and no reason, and it does
 * not ask main for a thumbnail it knows does not exist.
 *
 * THE BADGE USED TO SAY "POOLS ONLY", and that stopped being true. The derived
 * copy was the bytes Trench Express wrote into `create()` calldata, so an image
 * without one really was refused by that launchpad; migration 108 retired it and
 * the only remaining launchpad publishes the ORIGINAL. Keeping the old wording
 * would tell a user their picture is limited when nothing limits it.
 *
 * The thumbnail is `aria-hidden` and the tile is labelled by the image's own
 * label instead: a screen reader gains nothing from "image" and everything
 * from "moon.png, 12.4 KB". A thumbnail that fails to load leaves the tile in
 * place with its label - the metadata is still true even when the bytes are
 * not readable, and silently dropping the tile would hide that from the user.
 *
 * The tile is drawn on the page's paper (`.vex-pf-thumb`, book.css): a square
 * with a 1px rule, the label on a paper strip at its foot in 11px sans, the
 * delete key a 24px line icon key at its corner. No radius, no shadow.
 */

import type { JSX } from "react";
import type { LockerImage } from "@shared/schemas/images.js";
import { LineTrash } from "../../../../components/icons/line/index.js";
import { useLockerImageThumb } from "../../../../lib/api/images.js";

/** What a rail that may delete hands the tile; `null` on a browse-only rail. */
export interface ImageThumbRemoval {
  readonly onDelete: (imageId: string) => void;
  readonly deleting: boolean;
}

export function ImageThumb({
  image,
  removal,
}: {
  readonly image: LockerImage;
  readonly removal: ImageThumbRemoval | null;
}): JSX.Element {
  // `null` when there is no on-chain copy: the hook is disabled rather than
  // asked for something main would answer `images.not_found` to.
  const hasOnchainCopy = image.onchainByteLength !== null;
  const thumb = useLockerImageThumb(hasOnchainCopy ? image.imageId : null);
  const result = thumb.data;
  const dataUrl = result?.ok === true ? result.data.dataUrl : null;

  return (
    <li className="vex-pf-thumb">
      {dataUrl !== null ? (
        <img
          src={dataUrl}
          alt=""
          aria-hidden
          className="vex-pf-thumb__img"
        />
      ) : (
        <span aria-hidden className="vex-pf-thumb__none">
          {hasOnchainCopy && thumb.isLoading ? "…" : "-"}
        </span>
      )}

      {/* Named on the tile, not only in a tooltip: an empty square with no
       * explanation reads as a broken image rather than a missing preview. */}
      {!hasOnchainCopy ? (
        <span
          title="Too large for a preview thumbnail. The full image is stored and launches normally."
          className="vex-pf-thumb__tag"
        >
          no preview
        </span>
      ) : null}

      {/* The label rides a bottom scrim rather than a solid bar so a light
       * image stays readable without hiding what the user chose. */}
      <span className="vex-pf-thumb__label">
        {image.label}
      </span>

      {removal !== null ? (
        <button
          type="button"
          onClick={() => removal.onDelete(image.imageId)}
          disabled={removal.deleting}
          // Always reachable by keyboard (focus-visible), revealed on hover for
          // the mouse - a destructive control that only exists on hover is a
          // control a keyboard user does not have.
          className="vex-pf-thumb__del"
          aria-label={`Remove ${image.label} from the locker`}
        >
          <LineTrash size={14} />
        </button>
      ) : null}
    </li>
  );
}
