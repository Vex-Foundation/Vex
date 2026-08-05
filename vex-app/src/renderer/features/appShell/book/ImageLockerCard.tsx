/**
 * TRENCH EXPRESS — the image locker AND the launch opener, as ONE card.
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
 * THE MERGE (owner brief §8): the locker and "Launch a token" are one card,
 * under the Trench Express mark the app already pairs with that name
 * (`TokenLaunchDialog` renders the same resolution beside the same words). A
 * launch REQUIRES an image from this locker, so two cards sent the user hunting
 * for the reason a launch refused. `TokenLaunchButton` is composed unchanged —
 * the agent-driven `AgentLaunchFormHost` path is a separate flow and keeps
 * working.
 */

import { useState, type JSX } from "react";
import type { VexError } from "@shared/ipc/result.js";
import type { ImageOptimization } from "@shared/schemas/images.js";
import { Add01Icon, VexIcon } from "../../../components/icons/index.js";
import {
  useDeleteLockerImage,
  useLockerImages,
  useUploadLockerImage,
} from "../../../lib/api/images.js";
import { ProtocolMark } from "../../../components/common/ProtocolMark.js";
import { resolveProtocolMark } from "../../../lib/protocol-marks.js";
import { TokenLaunchButton } from "../token-launch/TokenLaunchButton.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import { ImageThumb } from "./image-locker/ImageThumb.js";

export function ImageLockerCard({
  sessionId,
}: {
  /**
   * Scopes a user-origin launch to the open session. REQUIRED-nullable: every
   * host must decide, because `null` means "this launch answers no session"
   * and that is a lifecycle fact, not an omission.
   */
  readonly sessionId: string | null;
}): JSX.Element {
  const query = useLockerImages();
  const upload = useUploadLockerImage();
  const remove = useDeleteLockerImage();
  // The last thing the user should still be looking at: a refusal, or the
  // report that their picture was optimized. Cleared whenever a new attempt
  // starts, so a stale message never sits under a fresh upload.
  const [notice, setNotice] = useState<string | null>(null);

  const result = query.data;
  const images = result?.ok === true ? result.data.images : [];
  const busy = upload.isPending;

  function runUpload(): void {
    setNotice(null);
    upload.mutate(undefined, {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          setNotice(uploadNotice(outcome.error));
          return;
        }
        // An oversized picture is now OPTIMIZED rather than refused. Say so —
        // silently altering a user's image and showing nothing would leave them
        // to discover the change from a thumbnail that looks softer than the
        // file they picked.
        setNotice(optimizationNotice(outcome.data.optimization));
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
      eyebrow="Trench Express"
      leading={<ProtocolMark mark={resolveProtocolMark("trench")} size={16} />}
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

      {/* The ONLY way a user reaches the launch dialog, now inside the card
          that holds the image every launch needs. */}
      <div className="mt-2.5 border-t border-[var(--vex-line)] pt-2.5">
        <TokenLaunchButton sessionId={sessionId} />
      </div>
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

/**
 * The optimization report, in the same place a refusal would appear.
 *
 * Absent optimization means the file was stored EXACTLY as picked, and that
 * deserves no message at all — an upload that changed nothing is just an
 * upload. Sizes are shown as measured, so the user can see what was traded.
 *
 * THE CROP IS NAMED. Optimizing always squares the image (Trench renders 1:1
 * tiles), and that is a visible change to the user's picture. Reporting only
 * the byte reduction would let them find the missing edges in the thumbnail
 * and wonder what else happened silently.
 */
function optimizationNotice(optimization: ImageOptimization | undefined): string | null {
  if (optimization === undefined) return null;
  return (
    `Optimized: ${formatKb(optimization.originalByteLength)} → ` +
    `${formatKb(optimization.storedByteLength)}, cropped to square. The image is stored ` +
    `inside the launch transaction, so its size is gas you pay.`
  );
}

function formatKb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} KB`;
}
