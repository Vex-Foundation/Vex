/**
 * LAUNCHPAD - the image locker AND the launch opener, as ONE card.
 *
 * This is the ONE place the user and the agent see the same library. A token
 * launch REQUIRES an image (our product rule), and an agent running a mission
 * cannot produce one. So this card is not a convenience: it is the only way a
 * fully autonomous launch can happen with nobody present, because the picture
 * has to be staged by a human in advance.
 *
 * The empty state says exactly that, rather than a decorative "no images yet".
 * A user who does not understand why this card exists will not use it, and the
 * mission will stall at the point where it can no longer be fixed.
 *
 * Card grammar is `PortfolioCard` (the shared glass chrome + eyebrow, which
 * uppercases to LAUNCHPAD). This file declares NO glass of its own: the
 * blur is inherited from that wrapper, which is the single design-guard
 * whitelisted entry, and a second one anywhere under `features/appShell` is a
 * red build. (The guard is a raw TEXT scan, so even naming the banned utility
 * in a comment trips it — hence the circumlocution.)
 *
 * THE MERGE (owner brief §8): the locker and "Launch a token" are one card,
 * under the mark of the launchpad a launch actually goes to. A
 * launch REQUIRES an image from this locker, so two cards sent the user hunting
 * for the reason a launch refused. `TokenLaunchButton` is composed unchanged -
 * the agent-driven `AgentLaunchFormHost` path is a separate flow and keeps
 * working.
 *
 * TWO SCOPES, TWO COMPONENTS (Studio parity decree, 2026-09-04).
 * The locker is GLOBAL - `useLockerImages` takes no scope - so a
 * project rail SEES the same images a session rail does. It may do nothing
 * else with them. A user-origin launch is attributed to a session id on the
 * signing path, and a project has none of its own that this card may borrow
 * (its `backingSessionId` is an owner decision, not a rail's); and a project
 * LAUNCHPAD is BROWSE-ONLY by decision, so upload and delete are not offered
 * there either. The scope decides the card's MODE here, in one place:
 * `session` mounts `SessionLocker` (read, upload, delete and the launch
 * action); `project` mounts `ProjectLocker`, which calls ONLY
 * the read query, renders non-deletable tiles, and says where a launch is
 * signed from. The split is two components rather than one with branches
 * because hooks cannot be conditional: a browse-only rail must not instantiate
 * the upload and delete mutations at all, and the only way to prove that is
 * for the component it mounts not to call them.
 */

import { useState, type JSX, type ReactNode } from "react";
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

/**
 * The venue whose mark this card wears. A CONSTANT rather than a prop: there is
 * one launchpad, and a card that took the venue from its host could wear a mark
 * for a lane the Launch button does not open.
 */
const LAUNCHPAD = "pools";
import { TokenLaunchButton } from "../token-launch/TokenLaunchButton.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";
import { ImageThumb, type ImageThumbRemoval } from "./image-locker/ImageThumb.js";

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

/** What an EMPTY locker says on a browse-only rail, where nothing can be added. */
export const PROJECT_LOCKER_EMPTY_NOTE =
  "No images in the locker yet. A launch needs an image, and the agent can't make one; stage one from an Agent session's Launchpad.";

export function ImageLockerCard({
  scope,
}: {
  /** Decides the card's mode: `session` can launch, `project` browses. */
  readonly scope: ImageLockerScope;
}): JSX.Element {
  return scope.kind === "session" ? (
    <SessionLocker sessionId={scope.sessionId} />
  ) : (
    <ProjectLocker />
  );
}

/**
 * The card's shell and its read states, shared by both modes. What differs
 * between the modes is what a tile may do, what the empty state asks for, and
 * what sits under the grid; each mode hands those in.
 */
function LockerFrame({
  query,
  removal,
  emptyNote,
  children,
}: {
  readonly query: ReturnType<typeof useLockerImages>;
  readonly removal: ImageThumbRemoval | null;
  readonly emptyNote: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const result = query.data;
  const images = result?.ok === true ? result.data.images : [];

  return (
    <PortfolioCard
      eyebrow="Launchpad"
      leading={<ProtocolMark mark={resolveProtocolMark(LAUNCHPAD)} size={16} />}
      trailing={images.length > 0 ? `${images.length}` : undefined}
    >
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">Couldn&apos;t read your image locker.</CardStateNote>
      ) : images.length === 0 ? (
        <CardStateNote>{emptyNote}</CardStateNote>
      ) : (
        <ul className="grid grid-cols-3 gap-1.5">
          {images.map((image) => (
            <ImageThumb key={image.imageId} image={image} removal={removal} />
          ))}
        </ul>
      )}
      {children}
    </PortfolioCard>
  );
}

/**
 * The PROJECT mode: one read, no mutation. Nothing here may subscribe to an
 * upload or a delete, and nothing here renders a control that would need one.
 */
function ProjectLocker(): JSX.Element {
  const query = useLockerImages();
  return (
    <LockerFrame
      query={query}
      removal={null}
      emptyNote={PROJECT_LOCKER_EMPTY_NOTE}
    >
      {/* The seat the launch action holds for a session. A PROJECT rail has
          no session to sign from, so it carries the sentence that says so. */}
      <div className="mt-2.5 border-t border-line-2 pt-2.5">
        <p
          data-vex-area="launchpad-browse-note"
          className="text-[11px] leading-relaxed text-ink-tertiary"
        >
          {LAUNCH_FROM_AGENT_SESSION_NOTE}
        </p>
      </div>
    </LockerFrame>
  );
}

/** The SESSION mode: the locker the user stages from, and the launch opener. */
function SessionLocker({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const query = useLockerImages();
  const upload = useUploadLockerImage();
  const remove = useDeleteLockerImage();
  // The last thing the user should still be looking at: a refusal, or the
  // report that a display copy was prepared. Cleared whenever a new attempt
  // starts, so a stale message never sits under a fresh upload.
  const [notice, setNotice] = useState<string | null>(null);

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
        // been prepared for the grid. Say so - the thumbnail grid renders that
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
          // failed Result and is shown verbatim - main already wrote a message
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
    <LockerFrame
      query={query}
      removal={{ onDelete: runDelete, deleting: remove.isPending }}
      emptyNote={
        <>
          A launch needs an image, and the agent can&apos;t make one. Add one
          here so a mission can launch without you.
        </>
      }
    >
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

      {/* The ONLY way a user reaches the launch dialog, inside the card that
          holds the image every launch needs. There is no launchpad chooser any
          more: migration 108 retired Trench Express and pools.fun is the only
          lane, so a chooser with one chip would state a decision nobody makes. */}
      <div className="mt-2.5 flex flex-col gap-2 border-t border-line-2 pt-2.5">
        <TokenLaunchButton sessionId={sessionId} />
      </div>
    </LockerFrame>
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
 * The display-copy report, in the same place a refusal would appear.
 *
 * WHAT IT MUST NOT SAY is that the picture was optimized. The ORIGINAL is
 * stored at full quality and is exactly what a launch publishes; what the
 * ladder produced is an additional small square COPY, and reporting that as
 * "optimized" would tell the user their file was degraded when it was not.
 *
 * Absent report means no copy had to be made - the file was already inside the
 * derivative's budget and is its own copy - and that deserves no message at all.
 *
 * THE CROP IS NAMED, because the thumbnail grid renders that copy: a user who
 * sees a square tile of a wide photo would otherwise be left wondering what
 * happened to the edges.
 *
 * WHAT IT NO LONGER CLAIMS is that the copy is gas. It was, on Trench Express,
 * which carried the image bytes inside the create transaction; migration 108
 * retired that protocol and pools.fun hosts its metadata off-chain, so the
 * derivative is now a thumbnail and nothing else. Saying otherwise would name a
 * cost the user does not pay.
 */
function onchainVariantNotice(variant: ImageOnchainVariant | undefined): string | null {
  if (variant === undefined) return null;
  return (
    `Stored at full quality (${formatKb(variant.originalByteLength)}). Vex also ` +
    `prepared a ${formatKb(variant.variantByteLength)} square copy to render in ` +
    `this grid. Your launch uses the original.`
  );
}

function formatKb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} KB`;
}
