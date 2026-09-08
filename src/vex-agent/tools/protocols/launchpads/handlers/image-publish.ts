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
 * TWO SURFACES, ONE CONSENT QUESTION. The picture is named the way each
 * surface can name it - `imageId` in the Vex app, where the user staged it in
 * the image locker, and `imagePath` over the Vex Studio MCP surface, where an
 * external coding agent has no locker and only its own project files. The
 * shared per-surface table (`protocols/shared/launch-image-input.ts`) owns that
 * routing, and the wrong surface's parameter is refused BY NAME rather than
 * dropped. Everything downstream of the parameter is identical: the same
 * approval card, the same disclosure sentence, the same content-addressed
 * upload, the same recorded row.
 *
 * WHY THE STUDIO ARM EXISTS AT ALL. It used to refuse, and the refusal closed a
 * product path: a launch writes the picture's URL on chain, a launch will not
 * publish as a side effect (that decision belongs to a human), and with no
 * publish tool on Studio an agent working in a codebase could never launch
 * anything with a picture. The answer is not a quieter launch; it is this tool,
 * asking the same question about the same bytes on the surface the agent is
 * actually on.
 *
 * WHAT THE STUDIO ARM MAY READ is decided by the no-follow reader
 * (`studio/files/no-follow-open.ts`), not here: inside the project root, no
 * symbolic links, a regular file, a byte ceiling, and a format sniffed from
 * magic bytes rather than from the extension. This module supplies no path
 * logic of its own, because a second containment boundary is a second place to
 * get it wrong.
 *
 * WHERE STUDIO BYTES LIVE. There is no second store. The bytes stay in the
 * user's own project file, and the copy Vex creates is the one on the
 * content-addressed host - which is what the locker row records. The row
 * carries the cid as its digest, so `findLaunchImageByPublicCid` can answer
 * "these exact bytes are already published" for a later call or a later launch
 * without uploading anything again. It carries no locker byte file, because
 * only the desktop app's locker writes those and this handler is not the
 * locker.
 */

import { randomBytes } from "node:crypto";

import type { ApprovalSurface, ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { launchpadsFailureDetail } from "./failure.js";
import {
  findLaunchImageByPublicCid,
  getLaunchImage,
  insertLaunchImage,
  recordPublicAsset,
  type LaunchImageMime,
} from "../../../../db/repos/launch-images.js";
import {
  deriveAssetContentId,
  resolveLaunchAssetsPublisher,
  type UploadOutcome,
} from "../../../../agentscan/assets-client.js";
import {
  resolveLaunchImageBytes,
  LaunchImageResolverUnavailableError,
} from "../../shared/launch-image-byte-resolver.js";
import {
  readLaunchImageSelection,
  resolveProjectFileLaunchImage,
  type LaunchImageSelection,
  type ResolvedLaunchImageBytes,
} from "../../shared/launch-image-input.js";

const TOOL_ID = "launchpads__image_publish";

/**
 * What did NOT happen when this tool refuses. Handed to the shared per-surface
 * reader so its refusals speak about publishing rather than about launching:
 * an agent told "Nothing was launched" would go looking for a launch to retry.
 */
const NOTHING_WAS_UPLOADED = "Nothing was uploaded.";

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
  const surface: ApprovalSurface = context.approvalSurface ?? "in_app_form";
  const selection = readLaunchImageSelection(p, context, {
    // Not `required`: the shared reader's missing-picture sentence is a
    // LAUNCH's ("a token launched without a picture renders blank forever"),
    // and nothing is being launched here. This tool states its own.
    required: false,
    lockerListTool: "launchpads__images_list",
    toolName: TOOL_ID,
    nothingHappened: NOTHING_WAS_UPLOADED,
  });
  if (!selection.ok) return fail(selection.reason);
  if (selection.selection === null) return fail(missingPictureReason(surface));

  return selection.selection.kind === "locker"
    ? await publishLockerImage(selection.selection.imageId)
    : await publishProjectFile(selection.selection, context);
}

/** The parameter this surface needed and did not get, named as the surface names it. */
function missingPictureReason(surface: ApprovalSurface): string {
  if (surface === "in_app_form") {
    return (
      `"imageId" is required: pass the id of a picture already in the locker, as listed by `
      + `launchpads__images_list. You can never supply image bytes or a URL yourself. ${NOTHING_WAS_UPLOADED}`
    );
  }
  return (
    `"imagePath" is required: pass the path of an image file inside this project, and Vex will read `
    + `those bytes itself and publish them. You can never supply image bytes or a URL yourself. `
    + `${NOTHING_WAS_UPLOADED}`
  );
}

/**
 * The in-app arm: a picture the USER staged, named by its locker id.
 *
 * Unchanged in every respect by the Studio arm below it. The bytes come from
 * the locker's own byte seam, which is the one place that can prove which bytes
 * an id stands for.
 */
async function publishLockerImage(imageId: string) {
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
 * The Studio arm: a picture that is a FILE in the agent's own project.
 *
 * The order of the steps is the contract, and each step exists because of what
 * would otherwise happen:
 *
 *  1. CONTAINMENT FIRST. The path came from a model, so the no-follow reader
 *     decides what may be opened at all, before anything else runs.
 *  2. THE LOCKER'S OWN FORMAT RULE. A published picture is recorded as a locker
 *     row, and that table accepts PNG, JPEG and WebP. A GIF is refused BY NAME
 *     here, before the upload, rather than uploaded and then found unfilable.
 *  3. THE CONTENT ID IS DERIVED LOCALLY, so "already published" is answered
 *     from our own record without spending a request, a quota slot or a second
 *     copy of the user's bytes in flight.
 *  4. THE ROW IS WRITTEN AFTER THE HOST ANSWERS (rule 05). Publication is the
 *     commit point; a row written before it would claim a publication that may
 *     never have happened.
 */
async function publishProjectFile(
  selection: Extract<LaunchImageSelection, { kind: "project_file" }>,
  context: ProtocolExecutionContext,
) {
  const resolved = await resolveProjectFileLaunchImage(selection, context, {
    nothingHappened: NOTHING_WAS_UPLOADED,
  });
  if (!resolved.ok) return fail(resolved.reason);
  const image = resolved.image;

  const mime = lockerMimeOf(image.mime);
  if (mime === null) {
    return fail(
      `"${image.displayLabel}" is a GIF, and Vex records a published picture as a PNG, JPEG or WebP. `
        + `${NOTHING_WAS_UPLOADED} Convert the picture to one of those three and pass that file instead.`,
    );
  }

  // The host addresses every asset by the sha256 of its bytes, so this is the
  // SAME id the upload would come back with - derivable before any request.
  // Derived through the client's own definition, because a launch later asks
  // the same question of a file on disk and both sides must agree byte for byte.
  const cid = deriveAssetContentId(image.bytes);

  let published;
  try {
    published = await findLaunchImageByPublicCid(cid);
  } catch (err) {
    return fail(
      `Vex could not check whether this picture is already published `
        + `(${launchpadsFailureDetail(TOOL_ID, err)}). ${NOTHING_WAS_UPLOADED} This is worth trying again.`,
    );
  }
  if (published !== null && published.publicUrl !== null && published.publicCid !== null) {
    // ALREADY PUBLIC, by content. Answered from our own record: no request, no
    // second copy of the user's bytes in flight, and the same URL as before,
    // because the URL is the hash of these exact bytes.
    return ok({
      imageId: published.imageId,
      imagePath: image.displayLabel,
      imageUrl: published.publicUrl,
      contentId: published.publicCid,
      alreadyPublished: true,
      byteLength: image.bytes.byteLength,
      mime: image.mime,
      disclosure: PUBLIC_DISCLOSURE,
    });
  }

  const publisher = await resolveLaunchAssetsPublisher();
  if (publisher.kind === "agentscan_unconfigured") return fail(UNCONFIGURED_REASON);
  if (publisher.kind === "install_unregistered") return fail(UNREGISTERED_REASON);

  const outcome = await publisher.client.uploadAsset({
    ingestToken: publisher.ingestToken,
    bytes: image.bytes,
  });
  if (outcome.kind !== "ok") return fail(describeUploadFailure(outcome));
  if (outcome.cid !== cid) {
    // The client already refuses a host whose answer does not address the bytes
    // it sent; this is the same invariant asserted against the id THIS arm
    // derived, so a future divergence between the two derivations cannot pass
    // an unverifiable URL to a launch.
    return fail(
      "The image host answered with an address that does not match the bytes Vex read from this file, "
        + "so the URL was REFUSED and nothing was recorded. A launch must never point at an address Vex "
        + "cannot prove holds the approved picture. Do not retry; report this.",
    );
  }

  const answer = {
    imagePath: image.displayLabel,
    imageUrl: outcome.url,
    contentId: outcome.cid,
    alreadyPublished: outcome.alreadyPublished,
    byteLength: outcome.bytes,
    mime: outcome.type,
    disclosure: PUBLIC_DISCLOSURE,
  };

  // THE BYTES ARE PUBLIC FROM HERE ON. Every failure below is reported as a
  // success carrying a warning, never as a failure: telling the agent nothing
  // happened would be false and would invite a second upload of bytes the host
  // already holds.
  const imageId = newPublishedImageId();
  try {
    await insertLaunchImage({
      imageId,
      label: image.displayLabel,
      byteLength: image.bytes.byteLength,
      mime,
      width: outcome.width,
      height: outcome.height,
      // The digest of the bytes that were published, which for a
      // content-addressed host IS the content id.
      digest: cid,
      // No derived on-chain copy: that variant belonged to a retired launchpad
      // and the desktop ladder is the only thing that ever made one.
      onchainByteLength: null,
      onchainDigest: null,
    });
  } catch (err) {
    return ok({
      ...answer,
      imageId: null,
      warning:
        "The picture was published successfully, but Vex could not record it against this install "
        + `(${launchpadsFailureDetail(TOOL_ID, err)}). Use the URL above; publishing the same file `
        + "again would return the same one.",
    });
  }

  try {
    await recordPublicAsset(imageId, { cid: outcome.cid, url: outcome.url });
  } catch (err) {
    return ok({
      ...answer,
      imageId,
      warning:
        "The picture was published successfully, but Vex could not file the address against the "
        + `record it created (${launchpadsFailureDetail(TOOL_ID, err)}). Use the URL above; publishing `
        + "the same file again would return the same one.",
    });
  }

  return ok({ ...answer, imageId });
}

/**
 * The locker's MIME allowlist, as the table's CHECK states it.
 *
 * `null` is the honest answer for a GIF: the no-follow reader sniffs one
 * (it is a real image and the host accepts it), and this table does not hold
 * one. Widening the reader or the table is a separate, deliberate change; a
 * cast here would produce a raw Postgres constraint violation with nothing the
 * caller could act on.
 */
function lockerMimeOf(mime: ResolvedLaunchImageBytes["mime"]): LaunchImageMime | null {
  switch (mime) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
      return mime;
    default:
      return null;
  }
}

/** A fresh opaque id, in the shape the locker's own byte store recognises. */
function newPublishedImageId(): string {
  return `img_${randomBytes(16).toString("hex")}`;
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
