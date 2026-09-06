/**
 * `launchpads.image_publish` handler - one locker picture becomes a permanent
 * public URL a launch can put on chain.
 *
 * WHAT IT COMMITS. The bytes leave the user's machine and become fetchable by
 * anyone holding the link, with no authentication, until the user withdraws
 * them. It signs nothing and spends no gas, but it is MUTATING and irreversible
 * in the only sense that matters here: bytes cannot be un-published from the
 * copies other people already have. That is why the manifest declares
 * `mutating: true` and `actionKind: "external_post"` and the ordinary approval
 * card asks a human first.
 *
 * WHY THE URL IS A HASH (coordinator decision I1). The launchpad writes this
 * URL on chain. A mutable URL would let the bytes change after the approval was
 * signed, so the picture the user consented to and the picture the world later
 * sees could differ with nothing on chain able to tell them apart. The host
 * addresses every asset by the sha256 of its bytes, and the CLIENT re-derives
 * that hash locally before trusting the URL: a host answering a different
 * content id is refused by name rather than believed.
 *
 * IDEMPOTENT BY CONTENT, AND ONCE PER IMAGE. If the locker row already carries
 * a public URL this returns it and uploads nothing. If it does not, the upload
 * itself is still idempotent at the host (identical bytes answer with the same
 * id), so a caller that lost the reply may safely ask again. Nothing here
 * retries on its own: a retry loop around an upload is the caller's decision,
 * not this handler's.
 *
 * SURFACE. This tool is not exported to the Studio MCP surface (see
 * `mcp/export-scope.ts`): an external coding agent has no locker to publish
 * from and supplies a path from its own project instead. The check below is the
 * privileged executor's own recheck of that decision (rule 04) - admission
 * refuses first, and this refuses again rather than trusting that it did.
 */

import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail, str } from "../../handler-helpers.js";
import { launchpadsFailureDetail } from "./failure.js";
import { getLaunchImage, recordPublicAsset } from "../../../../db/repos/launch-images.js";
import {
  resolveLaunchAssetsPublisher,
  type UploadOutcome,
} from "../../../../agentscan/assets-client.js";
import {
  resolveLaunchImageBytes,
  LaunchImageResolverUnavailableError,
} from "../../shared/launch-image-byte-resolver.js";

const TOOL_ID = "launchpads__image_publish";

/**
 * The sentence the agent must pass on. It states the consequence in the words a
 * user needs, not the mechanism: what is public, for how long, and how to undo
 * it. Kept as one authored constant so the wording is reviewed as product copy
 * rather than assembled differently on each branch.
 */
const PUBLIC_DISCLOSURE =
  "These bytes are now public: anyone with the link can fetch this picture without signing in, "
  + "and it stays hosted until it is withdrawn. The link is the picture's own sha256 hash, so it "
  + "can never serve a different picture later. The user can withdraw it from the image card in "
  + "the app.";

const UNCONFIGURED_REASON =
  "Vex has no image host configured, so this picture cannot be given a public address and no "
  + "launch that needs one can proceed. Nothing was uploaded. Tell the user that the AgentScan "
  + "service URL is unset in Vex's settings.";

const UNREGISTERED_REASON =
  "This Vex install has not completed its AgentScan handshake yet, so it holds no credential the "
  + "image host will accept. Nothing was uploaded. The handshake runs on its own once the service "
  + "is reachable; tell the user to try again shortly rather than retrying in a loop.";

export async function launchpadsImagePublishHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  if (context.approvalSurface === "studio_mcp") {
    return fail(
      "launchpads__image_publish is not available over the Vex Studio MCP surface: there is no image "
        + "locker there to publish from. Pass the launch tool an `imagePath` inside this project "
        + "instead, and it will publish those bytes itself.",
    );
  }

  const imageId = str(p, "imageId").trim();
  if (imageId === "") {
    return fail(
      `"imageId" is required: pass the id of a picture already in the locker, as listed by `
        + `launchpads__images_list. You can never supply image bytes or a URL yourself.`,
    );
  }

  let row;
  try {
    row = await getLaunchImage(imageId);
  } catch (err) {
    return fail(
      `The image locker could not be read (${launchpadsFailureDetail(TOOL_ID, err)}). Nothing was uploaded.`,
    );
  }
  if (row === null) {
    return fail(
      `No image with id "${imageId}" is in the locker. Nothing was uploaded. List the staged pictures `
        + `with launchpads__images_list and use one of those ids.`,
    );
  }

  // ALREADY PUBLISHED. The locker row is the record of a publication that
  // already happened, so this answers from it and touches no network. The row
  // cannot be half-set: the migration's pairing CHECK makes cid, url and time
  // all-or-nothing, which is what lets this branch read one field and trust the
  // other.
  if (row.publicUrl !== null && row.publicCid !== null) {
    return ok({
      imageId: row.imageId,
      imageUrl: row.publicUrl,
      contentId: row.publicCid,
      alreadyPublished: true,
      byteLength: row.byteLength,
      mime: row.mime,
      disclosure: PUBLIC_DISCLOSURE,
    });
  }

  const publisher = await resolveLaunchAssetsPublisher();
  if (publisher.kind === "agentscan_unconfigured") return fail(UNCONFIGURED_REASON);
  if (publisher.kind === "install_unregistered") return fail(UNREGISTERED_REASON);

  let bytes;
  try {
    bytes = await resolveLaunchImageBytes(imageId);
  } catch (err) {
    if (err instanceof LaunchImageResolverUnavailableError) {
      return fail(
        "The image store is not mounted in this process, so the picture's bytes cannot be read. "
          + "Nothing was uploaded. This is a Vex startup problem, not something to work around.",
      );
    }
    return fail(
      `The picture's bytes could not be read (${launchpadsFailureDetail(TOOL_ID, err)}). Nothing was uploaded.`,
    );
  }
  if (bytes === null) {
    return fail(
      `The locker has metadata for "${imageId}" but its bytes are missing, so nothing could be `
        + `published. Ask the user to re-add the picture on the image card.`,
    );
  }

  const outcome = await publisher.client.uploadAsset({
    ingestToken: publisher.ingestToken,
    bytes: bytes.bytes,
  });
  if (outcome.kind !== "ok") return fail(describeUploadFailure(outcome));

  // RECORDED AFTER THE COMMIT POINT, never before (rule 05): the row claims a
  // publication only once the host has answered with an id this process
  // re-derived from the very bytes it sent.
  try {
    await recordPublicAsset(imageId, { cid: outcome.cid, url: outcome.url });
  } catch (err) {
    // The picture IS public now. Failing the tool here would tell the agent
    // nothing happened, which is false and would invite a second upload; the
    // honest answer is the URL plus the fact that Vex could not file it.
    return ok({
      imageId: row.imageId,
      imageUrl: outcome.url,
      contentId: outcome.cid,
      alreadyPublished: outcome.alreadyPublished,
      byteLength: outcome.bytes,
      mime: outcome.type,
      disclosure: PUBLIC_DISCLOSURE,
      warning:
        "The picture was published successfully, but Vex could not record the address against the "
        + `locker image (${launchpadsFailureDetail(TOOL_ID, err)}). Use the URL above; publishing `
        + "again would return the same one.",
    });
  }

  return ok({
    imageId: row.imageId,
    imageUrl: outcome.url,
    contentId: outcome.cid,
    alreadyPublished: outcome.alreadyPublished,
    byteLength: outcome.bytes,
    mime: outcome.type,
    disclosure: PUBLIC_DISCLOSURE,
  });
}

/**
 * Every non-ok upload outcome, mapped to a sentence that names the real cause
 * and what to do about it. Exhaustive by construction: a new outcome arm is a
 * compile error here rather than a silent fall-through to a generic message.
 */
function describeUploadFailure(outcome: Exclude<UploadOutcome, { kind: "ok" }>): string {
  switch (outcome.kind) {
    case "unauthorized":
      return "The image host rejected this Vex install's credential, so nothing was uploaded. Vex "
        + "renews it on its own; tell the user to try again shortly rather than retrying in a loop.";
    case "unsupported_image":
      return "The image host could not read this file as a picture, so nothing was published. Ask "
        + "the user to re-add it as a PNG, JPEG, WebP or GIF on the image card.";
    case "too_large":
      return `The picture is ${outcome.byteLength} bytes and the image host accepts at most `
        + `${outcome.maxBytes}. Nothing was uploaded. Ask the user to add a smaller picture.`;
    case "deleted":
      return "This exact picture was published before and then withdrawn by its owner, and the host "
        + "will never serve it again, for anyone. Nothing was uploaded. Ask the user for a "
        + "different picture.";
    case "quota_exceeded":
      return "This Vex install has reached its image-hosting quota"
        + (outcome.axis === "unknown" ? "" : ` (${outcome.axis})`)
        + ", so nothing was uploaded. The user can withdraw a picture they no longer need from the "
        + "image card to free room.";
    case "cid_mismatch":
      return "The image host answered with an address that does not match the bytes Vex sent, so "
        + "the URL was REFUSED and nothing was recorded. A launch must never point at an address "
        + "Vex cannot prove holds the approved picture. Do not retry; report this.";
    case "invalid":
      return `The image host refused the upload as invalid (${outcome.detail}). Nothing was `
        + "uploaded. Do not retry the identical call.";
    case "unavailable":
      return "The image host could not be reached, so nothing was uploaded"
        + (outcome.status === null ? "" : ` (HTTP ${outcome.status})`)
        + ". This one is worth trying again"
        + (outcome.retryAfterSeconds === null ? "." : ` after about ${outcome.retryAfterSeconds}s.`);
  }
}
