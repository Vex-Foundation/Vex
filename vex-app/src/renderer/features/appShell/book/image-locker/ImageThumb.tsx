/**
 * One locker tile — the thumbnail, its label, and its delete affordance.
 *
 * Its own `data:` URL is fetched here rather than by the card, so the metadata
 * list stays a cheap read and a growing locker never turns one render into one
 * enormous payload. The bytes behind an `imageId` are immutable, so the query
 * never refetches.
 *
 * THE THUMBNAIL IS THE TRENCH ON-CHAIN COPY, which is why an image that has no
 * such copy shows none: the original may be megabytes, and rendering it would
 * push that over IPC for every tile. Such an image is not broken - it launches
 * fine on pools.fun - so the tile says POOLS ONLY rather than leaving the user
 * with an empty square and no reason, and it does not ask main for a thumbnail
 * it knows does not exist.
 *
 * The thumbnail is `aria-hidden` and the tile is labelled by the image's own
 * label instead: a screen reader gains nothing from "image" and everything
 * from "moon.png, 12.4 KB". A thumbnail that fails to load leaves the tile in
 * place with its label — the metadata is still true even when the bytes are
 * not readable, and silently dropping the tile would hide that from the user.
 *
 * This tile declares no glass of its own — the blur is inherited from
 * `PortfolioCard`, the single design-guard whitelisted wrapper, and a second
 * glass surface anywhere under `features/appShell` is a red build.
 */

import type { JSX } from "react";
import type { LockerImage } from "@shared/schemas/images.js";
import { IconTrash } from "../../../../components/icons/index.js";
import { useLockerImageThumb } from "../../../../lib/api/images.js";

export function ImageThumb({
  image,
  onDelete,
  deleting,
}: {
  readonly image: LockerImage;
  readonly onDelete: (imageId: string) => void;
  readonly deleting: boolean;
}): JSX.Element {
  // `null` when there is no on-chain copy: the hook is disabled rather than
  // asked for something main would answer `images.not_found` to.
  const hasOnchainCopy = image.onchainByteLength !== null;
  const thumb = useLockerImageThumb(hasOnchainCopy ? image.imageId : null);
  const result = thumb.data;
  const dataUrl = result?.ok === true ? result.data.dataUrl : null;

  return (
    <li className="group relative aspect-square overflow-hidden rounded-lg border border-line-2 bg-surface-base">
      {dataUrl !== null ? (
        <img
          src={dataUrl}
          alt=""
          aria-hidden
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex h-full w-full items-center justify-center font-doto text-[9px] uppercase tracking-[0.14em] text-ink-tertiary"
        >
          {hasOnchainCopy && thumb.isLoading ? "…" : "—"}
        </span>
      )}

      {/* Named on the tile, not only in a tooltip: the user finds out here or
       * at the moment a Trench launch refuses, and the second is too late. */}
      {!hasOnchainCopy ? (
        <span
          title="Too large for a Trench launch, which stores the image on-chain. Usable on pools.fun."
          className="pointer-events-none absolute left-1 top-1 rounded-full bg-surface-base/90 px-1.5 py-0.5 font-doto text-[8px] uppercase tracking-[0.14em] text-ink-tertiary"
        >
          pools only
        </span>
      ) : null}

      {/* The label rides a bottom scrim rather than a solid bar so a light
       * image stays readable without hiding what the user chose. */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-surface-base to-transparent px-1.5 pb-1 pt-3 text-[9.5px] text-ink-secondary">
        {image.label}
      </span>

      <button
        type="button"
        onClick={() => onDelete(image.imageId)}
        disabled={deleting}
        // Always reachable by keyboard (focus-visible), revealed on hover for
        // the mouse — a destructive control that only exists on hover is a
        // control a keyboard user does not have.
        className="absolute right-1 top-1 rounded-full bg-surface-base/90 p-1 text-ink-tertiary opacity-0 transition-opacity hover:text-warning-label focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
        aria-label={`Remove ${image.label} from the locker`}
      >
        <IconTrash size={12} />
      </button>
    </li>
  );
}
