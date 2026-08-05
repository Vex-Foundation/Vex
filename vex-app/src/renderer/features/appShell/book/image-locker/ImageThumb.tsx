/**
 * One locker tile — the thumbnail, its label, and its delete affordance.
 *
 * Its own `data:` URL is fetched here rather than by the card, so the metadata
 * list stays a cheap read and a growing locker never turns one render into one
 * enormous payload. The bytes behind an `imageId` are immutable, so the query
 * never refetches.
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
import { Trash2Icon, VexIcon } from "../../../../components/icons/index.js";
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
  const thumb = useLockerImageThumb(image.imageId);
  const result = thumb.data;
  const dataUrl = result?.ok === true ? result.data.dataUrl : null;

  return (
    <li className="group relative aspect-square overflow-hidden rounded-lg border border-[var(--vex-line)] bg-[var(--vex-surface-0)]">
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
          className="flex h-full w-full items-center justify-center font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]"
        >
          {thumb.isLoading ? "…" : "—"}
        </span>
      )}

      {/* The label rides a bottom scrim rather than a solid bar so a light
       * image stays readable without hiding what the user chose. */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-[var(--vex-surface-0)] to-transparent px-1.5 pb-1 pt-3 text-[9.5px] text-[var(--vex-text-2)]">
        {image.label}
      </span>

      <button
        type="button"
        onClick={() => onDelete(image.imageId)}
        disabled={deleting}
        // Always reachable by keyboard (focus-visible), revealed on hover for
        // the mouse — a destructive control that only exists on hover is a
        // control a keyboard user does not have.
        className="absolute right-1 top-1 rounded-full bg-[var(--vex-surface-0)]/90 p-1 text-[var(--vex-text-3)] opacity-0 transition-opacity hover:text-[var(--vex-warn-text)] focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
        aria-label={`Remove ${image.label} from the locker`}
      >
        <VexIcon icon={Trash2Icon} size={12} aria-hidden />
      </button>
    </li>
  );
}
