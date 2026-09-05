/**
 * Turning the caller's staged picture into the PUBLIC URL that goes on chain.
 *
 * ## The invariant this module exists to hold
 *
 * `BondingV5.preLaunch` writes `img_` into contract storage, permanently, and
 * every explorer and the venue's own site render it as an image. It must
 * therefore address bytes that CANNOT CHANGE after the approval was signed -
 * otherwise the picture a person consented to and the picture the world later
 * sees can differ, with nothing on chain able to tell them apart. That is owner
 * decision I1: a content-addressed host, and no mutable-URL fallback.
 *
 * A caller-supplied URL is rejected by name in `./params.ts`, before this
 * module runs. This module only ever produces a URL the launch-assets client
 * verified against the sha256 of the bytes it uploaded.
 *
 * ## Two surfaces, two sources, ONE verification
 *
 *   in_app_form  the picture lives in the user's local image locker. It must
 *                already be published: `launchpads__image_publish` is the
 *                owner of that step, and this refuses BY NAME pointing at it
 *                rather than publishing a second way. One owner for "bytes
 *                become public" means one place a user's consent to publishing
 *                is asked for, and the publish tool is approval-gated for
 *                exactly that reason.
 *   studio_mcp   an external coding agent has no locker; it names a file inside
 *                its own project. There is no locker row to record a publish
 *                against and no second consent surface to route through, so the
 *                bytes are read through the contained no-follow reader and
 *                uploaded here - through the SAME client, with the same local
 *                re-derivation of the content id.
 *
 * The upload is idempotent by content at the host, so a Studio caller that
 * retries a launch does not accumulate assets.
 */

import {
  resolveLaunchAssetsPublisher,
  type UploadOutcome,
} from "../../../../../agentscan/assets-client.js";
import { getLaunchImage } from "../../../../../db/repos/launch-images.js";
import {
  readLaunchImageSelection,
  resolveProjectFileLaunchImage,
  LAUNCH_IMAGE_PARAM_BY_SURFACE,
} from "../../../shared/launch-image-input.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { LAUNCH_EXECUTE_PUBLIC_NAME } from "./tool-ids.js";

export interface ResolvedLaunchImage {
  /** The content-addressed https URL written into `preLaunch`. */
  readonly url: string;
  /** The host's content id, when this path knows one. */
  readonly cid: string | null;
  /** The locker image this launch captured, when the surface has one. */
  readonly imageId: string | null;
  /** What to show a person: the locker label or the project-relative path. */
  readonly label: string;
}

export type ResolveLaunchImageResult =
  | { readonly ok: true; readonly image: ResolvedLaunchImage }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the caller's image parameter to a public URL.
 *
 * REQUIRED ON BOTH TOOLS, including the preview, and that is a deliberate
 * departure from the pools lane where a preview may omit it. The reason is this
 * lane's binding: a Virtuals preview seals the FINGERPRINT of the exact
 * `preLaunch` calldata, the image URL is inside that calldata, and the execute
 * refuses when its freshly built fingerprint differs. A preview without a
 * picture would therefore hand back a fingerprint no execute could ever match -
 * an answer that looks like a plan and is not one. The underlying product rule
 * is the same one pools learned as an incident (PPV, 2026-08-19): a launch
 * without a picture mints a token that renders blank forever.
 */
export async function resolveLaunchImage(input: {
  readonly params: Readonly<Record<string, unknown>>;
  readonly context: ProtocolExecutionContext;
}): Promise<ResolveLaunchImageResult> {
  // Same default the shared reader applies (`surfaceOf`): a dispatch with no
  // declared surface is the in-app agent, which is the locker's owner.
  const surface = input.context.approvalSurface ?? "in_app_form";
  const selection = readLaunchImageSelection(input.params, input.context, {
    required: true,
    lockerListTool: "launchpads__images_list",
    toolName: LAUNCH_EXECUTE_PUBLIC_NAME,
  });
  if (!selection.ok) return { ok: false, reason: selection.reason };
  if (selection.selection === null) {
    return {
      ok: false,
      reason:
        `No image was named. Pass ${LAUNCH_IMAGE_PARAM_BY_SURFACE[surface]}; the agent's picture is written on chain `
        + "at launch and cannot be added afterwards.",
    };
  }

  if (selection.selection.kind === "locker") {
    return await resolveFromLocker(selection.selection.imageId);
  }
  return await resolveFromProjectFile(selection.selection.imagePath, input.context);
}

/**
 * The in-app path: the locker row must ALREADY carry a public URL.
 *
 * Refusing here rather than publishing is the whole point. Publishing makes
 * bytes fetchable by anyone forever, `launchpads__image_publish` is the
 * approval-gated tool that asks a person about exactly that, and a launch
 * handler that quietly published as a side effect would take the decision away
 * from the surface built to ask it.
 */
async function resolveFromLocker(imageId: string): Promise<ResolveLaunchImageResult> {
  let row: Awaited<ReturnType<typeof getLaunchImage>>;
  try {
    row = await getLaunchImage(imageId);
  } catch {
    return { ok: false, reason: `The image locker could not be read for image ${imageId}. Nothing was signed.` };
  }
  if (row === null) {
    return {
      ok: false,
      reason:
        `No staged image with id ${imageId}. List what is staged with launchpads__images_list and pass one of those `
        + "ids.",
    };
  }
  if (row.publicUrl === null || row.publicCid === null) {
    return {
      ok: false,
      reason:
        `Image ${imageId} has not been published yet. A Virtuals launch writes the picture's URL into contract `
        + "storage permanently, so it must be a content-addressed URL of bytes that cannot change. Call "
        + `launchpads__image_publish with imageId "${imageId}" first - it asks for your approval, because publishing `
        + "makes the bytes fetchable by anyone - then retry the launch.",
    };
  }
  return {
    ok: true,
    image: {
      url: row.publicUrl,
      cid: row.publicCid,
      imageId,
      label: row.label,
    },
  };
}

/** The Studio path: contained project bytes, uploaded through the verified client. */
async function resolveFromProjectFile(
  imagePath: string,
  context: ProtocolExecutionContext,
): Promise<ResolveLaunchImageResult> {
  const bytes = await resolveProjectFileLaunchImage({ kind: "project_file", imagePath }, context);
  if (!bytes.ok) return { ok: false, reason: bytes.reason };

  const publisher = await resolveLaunchAssetsPublisher();
  if (publisher.kind !== "ready") {
    return { ok: false, reason: describePublisherUnavailable(publisher.kind) };
  }

  const outcome = await publisher.client.uploadAsset({
    ingestToken: publisher.ingestToken,
    bytes: bytes.image.bytes,
  });
  if (outcome.kind !== "ok") return { ok: false, reason: describeUploadFailure(outcome) };

  return {
    ok: true,
    image: {
      url: outcome.url,
      cid: outcome.cid,
      imageId: null,
      label: bytes.image.displayLabel,
    },
  };
}

function describePublisherUnavailable(kind: "agentscan_unconfigured" | "install_unregistered"): string {
  if (kind === "agentscan_unconfigured") {
    return (
      "The Vex launch-assets host is not configured for this install, so there is nowhere to publish the picture to. "
      + "A Virtuals launch cannot write a mutable URL on chain, so nothing was signed."
    );
  }
  return (
    "This install is not registered with the Vex launch-assets host yet, so the picture cannot be published. Nothing "
    + "was signed."
  );
}

/**
 * Every failure the host can answer with, said as a sentence a person can act
 * on. Exhaustive by construction: a new outcome kind fails to compile here.
 */
function describeUploadFailure(outcome: Exclude<UploadOutcome, { kind: "ok" }>): string {
  switch (outcome.kind) {
    case "cid_mismatch":
      return (
        "The launch-assets host answered with a URL that does not address the bytes Vex uploaded "
        + `(${outcome.reason}). Vex re-derives the content hash locally and refuses a mismatch rather than writing an `
        + "unverified URL on chain. Nothing was signed."
      );
    case "unsupported_image":
      return "That file is not an image type the host accepts (png, jpeg, webp or gif, checked by magic bytes).";
    case "too_large":
      return "That image is larger than the 2 MB the launch-assets host accepts. Use a smaller picture.";
    case "deleted":
      return (
        "Those exact bytes were published before and then permanently withdrawn, so the host will not serve them "
        + "again. Use a different picture."
      );
    case "quota_exceeded":
      return "This install has reached its launch-assets quota. Delete a published asset or wait for the quota window.";
    case "unauthorized":
      return "The launch-assets host rejected this install's credential. Nothing was signed.";
    case "invalid":
      return "The launch-assets host rejected the upload as malformed. Nothing was signed.";
    case "unavailable":
      return "The launch-assets host could not be reached, so the picture could not be published. Nothing was signed.";
    default: {
      const exhaustive: never = outcome;
      return `The picture could not be published (${JSON.stringify(exhaustive)}). Nothing was signed.`;
    }
  }
}
