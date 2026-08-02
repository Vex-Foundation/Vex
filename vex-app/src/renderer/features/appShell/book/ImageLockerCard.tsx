/**
 * TRENCH PHOTOS — the image locker card (C2), for the BOTTOM of the BOOK rail.
 *
 * This is the ONE place the user and the agent see the same library. A Trench
 * token launch REQUIRES an image (our product rule — the Diamond itself
 * accepts empty image bytes; we refuse to), and an agent running a mission
 * cannot produce one. So this card is not a convenience: it is the only way a
 * fully autonomous launch can happen with nobody present, because the picture
 * has to be staged by a human in advance.
 *
 * The empty state says exactly that, rather than a decorative "no images yet".
 * A user who does not understand why this card exists will not use it, and the
 * mission will stall at the point where it can no longer be fixed.
 *
 * Card grammar is `PortfolioCard` (the shared glass chrome + eyebrow, which
 * uppercases to TRENCH PHOTOS). This file declares NO glass of its own: the
 * blur is inherited from that wrapper, which is the single design-guard
 * whitelisted entry, and a second one anywhere under `features/appShell` is a
 * red build. (The guard is a raw TEXT scan, so even naming the banned utility
 * in a comment trips it — hence the circumlocution.)
 *
 * READY TO MOUNT, NOT MOUNTED: `BookPanel.tsx` composition is coordinator-
 * owned, so this exports the symbol and touches nothing else.
 */

import { useState, type JSX } from "react";
import type { VexError } from "@shared/ipc/result.js";
import { Add01Icon, VexIcon } from "../../../components/icons/index.js";
import {
  useDeleteLockerImage,
  useLockerImages,
  useUploadLockerImage,
} from "../../../lib/api/images.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import { ImageThumb } from "./image-locker/ImageThumb.js";

export function ImageLockerCard(): JSX.Element {
  const query = useLockerImages();
  const upload = useUploadLockerImage();
  const remove = useDeleteLockerImage();
  // The last refusal the user should still be looking at. Cleared whenever a
  // new attempt starts, so a stale "that file was too large" never sits under
  // a successful upload.
  const [notice, setNotice] = useState<string | null>(null);

  const result = query.data;
  const images = result?.ok === true ? result.data.images : [];
  const busy = upload.isPending;

  function runUpload(): void {
    setNotice(null);
    upload.mutate(undefined, {
      onSuccess: (outcome) => {
        if (!outcome.ok) setNotice(uploadNotice(outcome.error));
      },
    });
  }

  function runDelete(imageId: string): void {
    setNotice(null);
    remove.mutate(
      { imageId },
      {
        onSuccess: (outcome) => {
          // A refusal ("a live launch still uses this image") arrives as a
          // failed Result and is shown verbatim — main already wrote a message
          // that names the launch holding it.
          if (!outcome.ok) setNotice(outcome.error.message);
        },
      },
    );
  }

  return (
    <PortfolioCard
      eyebrow="Trench Photos"
      trailing={images.length > 0 ? `${images.length}` : undefined}
    >
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">Couldn&apos;t read your image locker.</CardStateNote>
      ) : images.length === 0 ? (
        <CardStateNote>
          A Trench launch needs an image, and the agent can&apos;t make one. Add one
          here so a mission can launch without you.
        </CardStateNote>
      ) : (
        <ul className="grid grid-cols-3 gap-1.5">
          {images.map((image) => (
            <ImageThumb
              key={image.imageId}
              image={image}
              onDelete={runDelete}
              deleting={remove.isPending}
            />
          ))}
        </ul>
      )}

      {notice !== null ? (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--vex-warn-text)]">
          {notice}
        </p>
      ) : null}

      <button
        type="button"
        onClick={runUpload}
        disabled={busy}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-full border border-[var(--vex-line)] py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--vex-text-2)] transition-colors hover:text-[var(--vex-text)] disabled:opacity-50"
      >
        <VexIcon icon={Add01Icon} size={12} aria-hidden />
        {busy ? "Adding…" : "Add image"}
      </button>
    </PortfolioCard>
  );
}

/**
 * A cancelled file picker is not a problem and must stay silent — the user
 * closed a dialog they opened. Everything else is main's already-public,
 * already-redacted message, which is more specific than anything this
 * component could invent.
 */
function uploadNotice(error: VexError): string | null {
  return error.code === "internal.cancelled" ? null : error.message;
}
