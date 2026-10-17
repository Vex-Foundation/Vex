/**
 * LAUNCHPAD on the Portfolio page: the image locker AND the launch opener, as
 * ONE section (docs/design/R3-MINIMAL.md section 9.1; "Launchpad" with the
 * venue's mark, the images as a grid of square tiles, "Add image" and the
 * launch opener under it).
 *
 * This is the ONE place the user and the agent see the same library. A token
 * launch REQUIRES an image (our product rule), and an agent running a mission
 * cannot produce one. So this section is not a convenience: it is the only way
 * a fully autonomous launch can happen with nobody present, because the
 * picture has to be staged by a human in advance. The empty state says exactly
 * that, rather than a decorative "no images yet".
 *
 * THE MERGE (owner brief section 8): the locker and "Launch a token" are one
 * section, under the mark of the launchpad a launch actually goes to. A launch
 * REQUIRES an image from this locker, so two sections sent the user hunting for
 * the reason a launch refused. `TokenLaunchButton` is composed unchanged; the
 * agent-driven `AgentLaunchFormHost` path is a separate flow and keeps working.
 *
 * THREE SCOPES, TWO MODES. The locker is GLOBAL (`useLockerImages` takes no
 * scope), so every page scope SEES the same images.
 *
 *  - session ("This chat"): read, upload, delete AND the launch action. A
 *    user-origin launch is attributed to a session id on the signing path,
 *    so the launch is offered only where there is one;
 *  - global (the whole inventory, or one wallet): read, upload and delete;
 *    the launch seat says where a launch is signed from, and, while a chat is
 *    open, that its "This chat" scope launches from it;
 *  - project ("This project"): BROWSE-ONLY by decision (Studio parity decree,
 *    2026-09-04): the read alone, non-deletable tiles, and the sentence that
 *    says where a launch is signed from. A project has no session of its own
 *    that this section may borrow.
 *
 * The modes are two components rather than one with branches because hooks
 * cannot be conditional: a browse-only scope must not instantiate the upload
 * and delete mutations at all, and the only way to prove that is for the
 * component it mounts not to call them.
 */

import { useState, type JSX, type ReactNode } from "react";
import type { VexError } from "@shared/ipc/result.js";
import type { ImageOnchainVariant } from "@shared/schemas/images.js";
import { LinePlus } from "../../../components/icons/line/index.js";
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
 * What the section is shown for. Closed: no host may hand it a scope it would
 * have to invent a session for.
 */
export type ImageLockerScope =
  | { readonly kind: "global" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/** What a scope without a session says in the seat the launch action holds. */
export const LAUNCH_FROM_AGENT_SESSION_NOTE =
  "A token launch is signed from an Agent session. Images staged here are ready for one.";

/** The global seat's second sentence, while a chat is open to launch from. */
export const LAUNCH_FROM_THIS_CHAT_NOTE =
  "Choose This chat above to launch from the open chat.";

/** What an EMPTY locker says on a browse-only scope, where nothing can be added. */
export const PROJECT_LOCKER_EMPTY_NOTE =
  "No images in the locker yet. A launch needs an image, and the agent can't make one; stage one from an Agent session's Launchpad.";

export function ImageLockerCard({
  scope,
  chatOpen = false,
}: {
  /** Decides the section's mode: `session` can launch, `global` stages, `project` browses. */
  readonly scope: ImageLockerScope;
  /** A chat is open, so the global seat can say how to launch from it. */
  readonly chatOpen?: boolean;
}): JSX.Element {
  switch (scope.kind) {
    case "session":
      return (
        <EditableLocker
          launch={
            // The ONLY way a user reaches the launch dialog, inside the section
            // that holds the image every launch needs. There is no launchpad
            // chooser any more: migration 108 retired Trench Express and
            // pools.fun is the only lane.
            <TokenLaunchButton sessionId={scope.sessionId} />
          }
        />
      );
    case "global":
      return (
        <EditableLocker
          launch={
            <p data-vex-area="launchpad-browse-note" className="vex-pf-note">
              {chatOpen
                ? `${LAUNCH_FROM_AGENT_SESSION_NOTE} ${LAUNCH_FROM_THIS_CHAT_NOTE}`
                : LAUNCH_FROM_AGENT_SESSION_NOTE}
            </p>
          }
        />
      );
    case "project":
      return <ProjectLocker />;
  }
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
      title="Launchpad"
      leading={<ProtocolMark mark={resolveProtocolMark(LAUNCHPAD)} size={16} />}
      note={images.length > 0 ? ` · ${String(images.length)}` : undefined}
    >
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">Couldn&apos;t read your image locker.</CardStateNote>
      ) : images.length === 0 ? (
        <CardStateNote>{emptyNote}</CardStateNote>
      ) : (
        <ul className="vex-pf-thumbs">
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
      {/* The seat the launch action holds for a session. A PROJECT has no
          session to sign from, so it carries the sentence that says so. */}
      <div className="vex-pf-launch">
        <p data-vex-area="launchpad-browse-note" className="vex-pf-note">
          {LAUNCH_FROM_AGENT_SESSION_NOTE}
        </p>
      </div>
    </LockerFrame>
  );
}

/**
 * The EDITABLE mode: the locker the user stages from (read, upload, delete),
 * and in the launch seat whatever the scope hands in (the launch opener for a
 * chat, the sentence that says where a launch is signed from otherwise).
 */
function EditableLocker({ launch }: { readonly launch: ReactNode }): JSX.Element {
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
      {notice !== null ? <p className="vex-pf-note">{notice}</p> : null}

      <button
        type="button"
        onClick={runUpload}
        disabled={busy}
        className="vex-pf-add"
      >
        <LinePlus size={14} />
        {busy ? "Adding…" : "Add image"}
      </button>

      <div className="vex-pf-launch">{launch}</div>
    </LockerFrame>
  );
}

/**
 * A cancelled file picker is not a problem and must stay silent - the user
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
