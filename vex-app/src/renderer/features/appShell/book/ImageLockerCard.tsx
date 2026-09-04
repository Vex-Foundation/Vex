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
 * for the reason a launch refused. `TokenLaunchButton` is composed unchanged -
 * the agent-driven `AgentLaunchFormHost` path is a separate flow and keeps
 * working.
 *
 * TWO SCOPES, ONE DECISION (Studio parity decree, 2026-09-04). The locker is
 * GLOBAL - `useLockerImages` takes no scope - so the card browses, adds and
 * deletes images for a project rail exactly as for a session rail. The LAUNCH
 * is not: a user-origin launch is attributed to a session id on the signing
 * path, and a project has none of its own that this card may borrow (its
 * `backingSessionId` is an owner decision, not a rail's). So the scope decides
 * the card's MODE here, in one place: `session` renders the launch action;
 * `project` renders one sentence saying where a launch is signed from.
 */

import { useState, type JSX } from "react";
import type { VexError } from "@shared/ipc/result.js";
import type { ImageOnchainVariant } from "@shared/schemas/images.js";
import { IconPlus } from "../../../components/icons/index.js";
import {
  useDeleteLockerImage,
  useLockerImages,
  useUploadLockerImage,
} from "../../../lib/api/images.js";
import { ProtocolMark } from "../../../components/common/ProtocolMark.js";
import { resolveProtocolMark } from "../../../lib/protocol-marks.js";
import { TokenLaunchButton } from "../token-launch/TokenLaunchButton.js";
import {
  LaunchPlatformChips,
  type LaunchPlatform,
} from "../TokenLaunchDialog/LaunchPlatformChips.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import { ImageThumb } from "./image-locker/ImageThumb.js";

/**
 * What the rail is mounted for. Closed: the card has a real read for both,
 * and no host may hand it a scope it would have to invent a session for.
 */
export type ImageLockerScope =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/** What a project rail says in the seat the launch action holds for a session. */
export const LAUNCH_FROM_AGENT_SESSION_NOTE =
  "A token launch is signed from an Agent session. Images staged here are ready for one.";

export function ImageLockerCard({
  scope,
}: {
  /** Decides the card's mode: `session` can launch, `project` browses. */
  readonly scope: ImageLockerScope;
}): JSX.Element {
  const query = useLockerImages();
  const upload = useUploadLockerImage();
  const remove = useDeleteLockerImage();
  // Which launchpad the next launch goes to. Owned HERE because the choice has
  // to be visible while the user picks a picture, not only after the dialog
  // opens. Not persisted: a launchpad is a per-launch decision, and reviving
  // yesterday's choice under a Launch button is how a token lands on the wrong
  // one.
  const [platform, setPlatform] = useState<LaunchPlatform>("trench");
  // The last thing the user should still be looking at: a refusal, or the
  // report that a Trench copy was prepared. Cleared whenever a new attempt
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
        // The original is stored untouched, but a SECOND, smaller copy may have
        // been prepared for Trench. Say so - the thumbnail grid renders that
        // copy, so a user who is shown a softer, square tile would otherwise
        // conclude Vex quietly degraded the file they picked.
        setNotice(onchainVariantNotice(outcome.data.onchainVariant));
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
          // that names the launch holding it and what state it is in.
          if (!outcome.ok) setNotice(outcome.error.message);
        },
        // A THROWN delete is the one case that used to be invisible: the
        // mutation rejected, `onSuccess` never ran, and the tile simply stayed
        // put with nothing on screen. A destructive control that silently does
        // nothing reads as a broken app, so the transport failure is named.
        onError: () => {
          setNotice(
            "Vex could not reach the image locker to delete that image. Nothing was removed. Retry, and check that Vex services are running.",
          );
        },
      },
    );
  }

  return (
    <PortfolioCard
      eyebrow="Launchpad"
      leading={<ProtocolMark mark={resolveProtocolMark(platform)} size={16} />}
      trailing={images.length > 0 ? `${images.length}` : undefined}
    >
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">Couldn&apos;t read your image locker.</CardStateNote>
      ) : images.length === 0 ? (
        <CardStateNote>
          A launch needs an image, and the agent can&apos;t make one. Add one
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
        <p className="mt-2 text-[11px] leading-relaxed text-warning-label">
          {notice}
        </p>
      ) : null}

      <button
        type="button"
        onClick={runUpload}
        disabled={busy}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-full border border-line-2 py-1.5 vex-micro-label vex-micro-label--wide uppercase text-ink-secondary transition-colors hover:text-ink-primary disabled:opacity-50"
      >
        <IconPlus size={12} />
        {busy ? "Adding…" : "Add image"}
      </button>

      {/* The ONLY way a user reaches the launch dialog, now inside the card
          that holds the image every launch needs. The chips sit beside it so
          the launchpad is chosen where the picture is. A PROJECT rail has no
          session to sign from, so this seat carries the sentence that says
          so instead of a launch it cannot attribute. */}
      <div className="mt-2.5 flex flex-col gap-2 border-t border-line-2 pt-2.5">
        {scope.kind === "session" ? (
          <>
            <LaunchPlatformChips value={platform} onChange={setPlatform} />
            <TokenLaunchButton
              sessionId={scope.sessionId}
              platform={platform}
              onPlatformChange={setPlatform}
            />
          </>
        ) : (
          <p
            data-vex-area="launchpad-browse-note"
            className="text-[11px] leading-relaxed text-ink-tertiary"
          >
            {LAUNCH_FROM_AGENT_SESSION_NOTE}
          </p>
        )}
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
 * The on-chain-copy report, in the same place a refusal would appear.
 *
 * WHAT IT MUST NOT SAY ANY MORE is that the picture was optimized. Since the
 * per-lane decision the ORIGINAL is stored at full quality and is exactly what
 * a pools.fun launch publishes; what the ladder produced is an additional
 * small square COPY that only Trench uses. Reporting that as "optimized" would
 * tell the user their file was degraded when it was not.
 *
 * Absent report means no copy had to be made - the file was already inside the
 * Trench budget and is its own copy - and that deserves no message at all.
 *
 * THE CROP IS NAMED, because the thumbnail grid renders that copy: a user who
 * sees a square tile of a wide photo would otherwise be left wondering what
 * happened to the edges.
 *
 * THE GAS SENTENCE NAMES TRENCH, because it is only true there. A Trench launch
 * carries the image bytes inside the transaction; pools.fun hosts its metadata
 * off-chain, so the same picture costs no gas on that launchpad.
 */
function onchainVariantNotice(variant: ImageOnchainVariant | undefined): string | null {
  if (variant === undefined) return null;
  return (
    `Stored at full quality (${formatKb(variant.originalByteLength)}). For Trench ` +
    `launches Vex also prepared a ${formatKb(variant.variantByteLength)} square copy, ` +
    `because a Trench launch carries the image inside the transaction and its size ` +
    `is gas you pay. pools.fun uses your original.`
  );
}

function formatKb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} KB`;
}
