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
 * ## THIS MODULE NEVER PUBLISHES
 *
 * Publishing makes bytes fetchable by anyone, forever. That is a consent
 * decision, and `launchpads__image_publish` is the approval-gated tool that
 * owns it. So both surfaces resolve to a picture that is ALREADY public - a
 * `launch_images` row carrying the public URL and content id that tool
 * recorded - and anything else is refused BY NAME, pointing at the tool that
 * asks the question.
 *
 * IT USED TO PUBLISH, on the Studio surface, and the 2026-09-06 final review
 * measured the cost. The upload sat behind `virtuals__agent_launch_preview`,
 * which the manifest classifies `local_write` and describes as spending
 * nothing and sending nothing, and behind `simulateOnly`, which promises that
 * no preview is claimed and nothing is broadcast. A person reading either
 * sentence would not learn that a private file in their repository had just
 * been published to a public host. A second publishing path is also a second
 * place the consent question could be skipped, which is exactly what happened.
 *
 * ## HOW EACH SURFACE NAMES AN ALREADY-PUBLIC PICTURE
 *
 * The two surfaces differ only in what they can name, never in what they are
 * allowed to do:
 *
 *   `in_app_form`  an `imageId`: the locker row the user staged, which must
 *                  already carry the public URL and cid that publish recorded.
 *
 *   `studio_mcp`   an `imagePath`: a file in the agent's own project. The bytes
 *                  are read through the SAME contained no-follow reader the
 *                  publish tool uses, hashed with the SAME content-address
 *                  function, and that hash is looked up in our own record. A
 *                  hit means these exact bytes are already public and the
 *                  launch may point at them; a miss is refused BY NAME, telling
 *                  the agent to publish this same path first.
 *
 * THE HASH IS THE WHOLE BINDING on the Studio side. It is derived from the
 * bytes ON DISK RIGHT NOW, so a file edited after it was published simply does
 * not match any row and is refused - which is the correct answer, because the
 * on-chain URL would otherwise address a picture the project no longer holds.
 * Nothing here trusts a path, a name or a timestamp to stand for bytes.
 */

import { deriveAssetContentId } from "../../../../../agentscan/assets-client.js";
import {
  findLaunchImageByPublicCid,
  getLaunchImage,
} from "../../../../../db/repos/launch-images.js";
import {
  readLaunchImageSelection,
  resolveProjectFileLaunchImage,
  LAUNCH_IMAGE_PARAM_BY_SURFACE,
  type LaunchImageSelection,
} from "../../../shared/launch-image-input.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { LAUNCH_EXECUTE_PUBLIC_NAME } from "./tool-ids.js";

/**
 * The public name of the tool that owns the consent decision. Written once so
 * every refusal that points at it names the same tool.
 */
const IMAGE_PUBLISH_TOOL = "launchpads__image_publish";

/** What did NOT happen when this lane refuses, in the launch's own words. */
const NOTHING_WAS_SIGNED = "Nothing was signed.";

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
  return await resolveFromProjectFile(selection.selection, input.context);
}

/**
 * The Studio surface named a file in its project. It must ALREADY be public.
 *
 * The order of the steps is the contract:
 *
 *  1. CONTAINMENT FIRST, and it is the no-follow reader's, not this module's.
 *     The path came from a model, so what may be opened at all is decided
 *     before anything else runs, and a second containment boundary here would
 *     be a second place to get it wrong (rule 07, path resolution).
 *  2. THE BYTES ON DISK ARE HASHED, with the host's own content-address
 *     function - the same one `launchpads__image_publish` derives its cid
 *     with. A path or a filename could never stand in for this: the file may
 *     have been edited since it was published.
 *  3. OUR OWN RECORD ANSWERS, and no request is made. A row whose `public_cid`
 *     is this hash is proof these exact bytes are already fetchable at a URL
 *     that can never serve anything else.
 *  4. A MISS IS A REFUSAL, never an upload. It names the publishing tool and
 *     quotes the path AS THE AGENT WROTE IT, so the remedy is a call the agent
 *     can make verbatim - and never the resolved absolute path, which would
 *     hand the model the user's directory layout.
 */
async function resolveFromProjectFile(
  selection: Extract<LaunchImageSelection, { kind: "project_file" }>,
  context: ProtocolExecutionContext,
): Promise<ResolveLaunchImageResult> {
  const resolved = await resolveProjectFileLaunchImage(selection, context, {
    nothingHappened: NOTHING_WAS_SIGNED,
  });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const image = resolved.image;

  const cid = deriveAssetContentId(image.bytes);

  let published: Awaited<ReturnType<typeof findLaunchImageByPublicCid>>;
  try {
    published = await findLaunchImageByPublicCid(cid);
  } catch {
    // NOT the same as "not published". Treating an unreadable record as a miss
    // would send the agent to publish bytes that are already public, and a
    // second publication of the same file is a second consent question the user
    // never needed to answer.
    return {
      ok: false,
      reason:
        `Vex could not check whether "${selection.imagePath}" has already been published, so it will not launch `
        + `against it. ${NOTHING_WAS_SIGNED} This is worth trying again.`,
    };
  }
  if (published === null || published.publicUrl === null || published.publicCid === null) {
    return { ok: false, reason: refuseUnpublishedProjectFile(selection.imagePath) };
  }

  return {
    ok: true,
    image: {
      url: published.publicUrl,
      cid: published.publicCid,
      imageId: published.imageId,
      // The PROJECT-RELATIVE path the reader resolved, never the absolute one:
      // this string is shown to a person and read by the model.
      label: image.displayLabel,
    },
  };
}

/**
 * The bytes at that path are not public, so no launch can point at them yet.
 *
 * The refusal is specific about WHAT is missing (a picture that is already
 * public), WHO may make it public (the approval-gated publish tool, on this
 * very surface), and WITH WHICH ARGUMENT - the agent's own path, quoted back
 * unchanged - because an agent that is only told "no" will try the same call
 * again with a different path.
 */
function refuseUnpublishedProjectFile(imagePath: string): string {
  return (
    `"${imagePath}" has not been published, and a launch will never publish it for you: nothing was uploaded. A `
    + "Virtuals launch writes the picture's URL into contract storage permanently, so it must address bytes that "
    + "are already public and cannot change - and making bytes public is a decision only the person whose files "
    + `they are can take. Call ${IMAGE_PUBLISH_TOOL} with imagePath "${imagePath}" first (it asks for that `
    + `approval), then retry this launch with the same imagePath. ${NOTHING_WAS_SIGNED}`
  );
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
