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
 * THE CONSEQUENCE IS NAMED RATHER THAN HIDDEN: `launchpads__image_publish` is
 * not available over the Vex Studio MCP surface (there is no image locker
 * there), so a Virtuals launch cannot currently be driven end to end from
 * Studio. The refusal says so and says where the launch CAN be done, instead
 * of publishing on the user's behalf to keep a path open.
 */

import { getLaunchImage } from "../../../../../db/repos/launch-images.js";
import {
  readLaunchImageSelection,
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
  return refuseUnpublishedProjectFile(selection.selection.imagePath);
}

/**
 * The Studio surface named a file in its project. Vex will not publish it.
 *
 * The refusal is specific about WHAT is missing (a picture that is already
 * public), WHO may make it public (the approval-gated publish tool) and WHERE
 * that tool runs (the Vex app), because an agent that is only told "no" will
 * try the same call again with a different path.
 */
function refuseUnpublishedProjectFile(imagePath: string): ResolveLaunchImageResult {
  return {
    ok: false,
    reason:
      `Vex will not publish "${imagePath}" as part of a launch, and nothing was uploaded. A Virtuals launch writes `
      + "the picture's URL into contract storage permanently, so it must address bytes that are already public and "
      + "cannot change - and making bytes public is a decision only the person whose files they are can take. "
      + "launchpads__image_publish is the tool that asks for that approval, and it runs in the Vex app, where the "
      + "picture is staged in the image locker. Publish the picture there and launch the agent from the Vex app. "
      + "Nothing was signed.",
  };
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
