/**
 * HOW A LAUNCH NAMES ITS PICTURE, per consent surface.
 *
 * SHARED, not any one launchpad's. Every launchpad Vex supports needs exactly
 * the same thing from the caller - one picture, named in the only way the
 * surface can name it - and the byte resolver beside this file was moved to
 * `shared/` for that same reason. A second launchpad reaching into the first
 * one's input parser would be a cross-feature import with no owner.
 *
 * THE TWO SURFACES ARE NOT THE SAME PLACE, and that is the whole design.
 *
 *   `in_app_form`  The user is at the Vex desktop app. Pictures live in the
 *                  IMAGE LOCKER they staged, so the parameter is an `imageId`
 *                  and the agent's only job is to name one the locker already
 *                  holds. It cannot create or upload one; only the user can.
 *
 *   `studio_mcp`   An external coding agent is working inside a codebase. It
 *                  has no locker, no image card, and no way to ask a human to
 *                  stage a file - but it does have the project's own files. So
 *                  the parameter is an `imagePath` INSIDE the project root, and
 *                  Vex publishes those bytes itself.
 *
 * A URL IS NEVER AN ACCEPTED INPUT, on either surface (coordinator decision
 * I1). The launchpad writes the image URL on chain; a URL the model supplied
 * could serve different bytes tomorrow, and the picture the user approved and
 * the picture the world later sees would be two different things with nothing
 * on chain able to tell them apart. Vex publishes the bytes itself to a
 * content-addressed host, so the URL IS the hash of the bytes that were
 * approved. The mutable-URL fallback was considered and rejected.
 *
 * THE WRONG SURFACE'S PARAMETER IS REFUSED BY NAME, never dropped (rule 90).
 * Silently ignoring an `imageId` on the Studio surface would launch a token
 * with the wrong picture, or none, while the agent believed it had chosen one.
 */

import type { ApprovalSurface, ProtocolExecutionContext } from "../types.js";
import { resolveProjectRootPath } from "../../../mcp/project-root.js";
import {
  openImageInsideRoot,
  NO_FOLLOW_IMAGE_MAX_BYTES,
  type NoFollowRefusal,
} from "../../../studio/files/no-follow-open.js";

/** The one parameter each surface accepts, and the one it refuses. */
export const LAUNCH_IMAGE_PARAM_BY_SURFACE: Readonly<Record<ApprovalSurface, "imageId" | "imagePath">> = {
  in_app_form: "imageId",
  studio_mcp: "imagePath",
};

/** Which picture a launch was told to use, in the form its surface names it. */
export type LaunchImageSelection =
  | { readonly kind: "locker"; readonly imageId: string }
  | { readonly kind: "project_file"; readonly imagePath: string };

export type LaunchImageSelectionResult =
  | { readonly ok: true; readonly selection: LaunchImageSelection }
  /** No picture was named, and the caller said one was not required. */
  | { readonly ok: true; readonly selection: null }
  | { readonly ok: false; readonly reason: string };

export interface ReadLaunchImageSelectionOptions {
  /**
   * Refuse when no picture is named. Set by the tool that actually LAUNCHES; a
   * preview or a form leaves it false, because the picture is chosen later.
   */
  readonly required: boolean;
  /** The public name of the tool that lists the locker, for the remedy sentence. */
  readonly lockerListTool: string;
  /** The public name of the launching tool, so a refusal says what refused. */
  readonly toolName: string;
}

/** Normalized once, exactly as `runtime/gates.ts` normalizes it. */
function surfaceOf(context: ProtocolExecutionContext): ApprovalSurface {
  return context.approvalSurface ?? "in_app_form";
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Read the picture parameter for the surface this dispatch is running on.
 *
 * Pure: it parses and refuses, and touches neither the database nor the disk.
 * Resolving the selection to bytes is `resolveLaunchImageBytesForSurface`.
 */
export function readLaunchImageSelection(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  options: ReadLaunchImageSelectionOptions,
): LaunchImageSelectionResult {
  const surface = surfaceOf(context);
  const accepted = LAUNCH_IMAGE_PARAM_BY_SURFACE[surface];
  const forbidden = accepted === "imageId" ? "imagePath" : "imageId";

  // THE FORBIDDEN PARAMETER IS NAMED, not dropped. An agent that passed the
  // other surface's parameter believes it chose a picture; telling it nothing
  // and launching anyway is how a token gets the wrong art, permanently.
  if (!isAbsent(params[forbidden])) {
    return {
      ok: false,
      reason:
        surface === "in_app_form"
          ? `"imagePath" is not accepted here. This call is running in the Vex app, where pictures come `
            + `from the user's image locker and not from a file path. Nothing was launched. List the `
            + `staged pictures with ${options.lockerListTool} and pass the "imageId" of the one the user wants.`
          : `"imageId" is not accepted here. This call is running over the Vex Studio MCP surface, which `
            + `has no image locker. Nothing was launched. Pass "imagePath" instead: a path to an image `
            + `file inside this project, which Vex will publish to a public content-addressed URL.`,
    };
  }

  const raw = params[accepted];
  if (!isAbsent(raw) && typeof raw !== "string") {
    return {
      ok: false,
      reason:
        accepted === "imageId"
          ? `"imageId" must be the string id of an image already in the locker.`
          : `"imagePath" must be a string path to an image file inside this project.`,
    };
  }
  const trimmed = isAbsent(raw) ? "" : (raw as string).trim();

  if (trimmed === "") {
    if (!options.required) return { ok: true, selection: null };
    return { ok: false, reason: missingImageReason(surface, options) };
  }

  return {
    ok: true,
    selection:
      accepted === "imageId"
        ? { kind: "locker", imageId: trimmed }
        : { kind: "project_file", imagePath: trimmed },
  };
}

/**
 * The refusal an execute gets when it was given no picture at all.
 *
 * THE PPV INCIDENT (2026-08-19) IS WHY THIS IS A REFUSAL AND NOT A WARNING: the
 * agent omitted the image, the launchpad pinned metadata with no image key, and
 * the token renders blank forever. An optional parameter plus a warning did not
 * stop it.
 */
export function missingImageReason(
  surface: ApprovalSurface,
  options: Pick<ReadLaunchImageSelectionOptions, "lockerListTool" | "toolName">,
): string {
  const consequence =
    "A token launched without a picture renders blank on its launchpad forever, and that cannot be undone.";
  if (surface === "in_app_form") {
    return (
      `${options.toolName} requires a picture from the user's image locker, and this call had no `
      + `"imageId". Nothing was launched. List the staged pictures with ${options.lockerListTool} and pass `
      + `the id of the one the user wants, or ask the user to stage one on the image card if the locker is `
      + `empty. You can never create or supply a picture yourself. ${consequence}`
    );
  }
  return (
    `${options.toolName} requires a picture, and this call had no "imagePath". Nothing was launched. `
    + `Pass the path of an image file inside this project (PNG, JPEG, WebP or GIF, at most `
    + `${NO_FOLLOW_IMAGE_MAX_BYTES} bytes) and Vex will publish it to a public content-addressed URL. `
    + `You cannot supply a URL: the launchpad writes it on chain, so it must be one Vex can prove holds `
    + `exactly the approved bytes. ${consequence}`
  );
}

/** Bytes for a chosen picture, plus what a human-visible card should show. */
export interface ResolvedLaunchImageBytes {
  readonly bytes: Uint8Array;
  readonly source: "locker" | "project_file";
  /**
   * What the approval card names. For the locker this is the image id; for a
   * project file it is the path RELATIVE to the project root, never the
   * absolute one, which would reveal the user's directory layout to the model.
   */
  readonly displayLabel: string;
  /** The sniffed or recorded media type, when the source knows it. */
  readonly mime: string | null;
}

export type ResolveLaunchImageBytesResult =
  | { readonly ok: true; readonly image: ResolvedLaunchImageBytes }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a selection to bytes, through the owner appropriate to its surface.
 *
 * A locker selection goes through the registered byte-resolver seam; a project
 * file goes through the no-follow reader, which is the containment boundary for
 * a path the MODEL supplied (rule 07, filesystem path resolution). This
 * function never widens that boundary: it supplies the root and reports the
 * refusal, and owns no path logic of its own.
 *
 * The locker arm is DELIBERATELY not implemented here. Its caller already holds
 * a resolved `LaunchImageBytes` on every existing launch path (the pools
 * prepare lane reads it beside the metadata it must verify the digest against),
 * and duplicating that call here would give the digest check a second, weaker
 * home. Pass `locker` selections to the existing resolver at the call site.
 */
export async function resolveProjectFileLaunchImage(
  selection: Extract<LaunchImageSelection, { kind: "project_file" }>,
  context: ProtocolExecutionContext,
): Promise<ResolveLaunchImageBytesResult> {
  const projectId = context.studioProjectId ?? null;
  if (projectId === null) {
    // Fail closed. Without a project there is no root, and without a root there
    // is nothing to contain the path to; guessing a root here would be the
    // whole vulnerability this module exists to prevent.
    return {
      ok: false,
      reason:
        "An image path can only be read inside a Vex Studio project, and this call carries no project. "
        + "Nothing was launched.",
    };
  }

  let root;
  try {
    root = await resolveProjectRootPath(projectId);
  } catch {
    return {
      ok: false,
      reason:
        "Vex could not read this project's record, so it could not establish which directory the image "
        + "path is allowed to be inside. Nothing was launched. This is worth trying again.",
    };
  }
  if (root.kind === "unknown_project") {
    return {
      ok: false,
      reason: "This Vex Studio project no longer exists, so no file in it can be read. Nothing was launched.",
    };
  }
  if (root.kind === "no_root_recorded") {
    return {
      ok: false,
      reason:
        "This Vex Studio project has no directory recorded, so there is nothing to read an image path "
        + "inside. Nothing was launched.",
    };
  }

  const opened = await openImageInsideRoot({
    projectRoot: root.rootPath,
    requestedPath: selection.imagePath,
  });
  if (!opened.ok) return { ok: false, reason: describeNoFollowRefusal(opened.refusal) };

  return {
    ok: true,
    image: {
      bytes: opened.bytes,
      source: "project_file",
      displayLabel: opened.relativePath,
      mime: opened.mime,
    },
  };
}

/**
 * Every no-follow refusal, in the words the agent needs to fix it.
 *
 * Exhaustive by construction: a new refusal kind is a compile error here rather
 * than a silent fall-through to a generic sentence.
 */
function describeNoFollowRefusal(refusal: NoFollowRefusal): string {
  const nothing = "Nothing was launched.";
  switch (refusal.kind) {
    case "not_absolute_root":
      return `Vex could not establish this project's directory (${refusal.detail}). ${nothing}`;
    case "escapes_root":
      return (
        `That path is outside this project, and Vex only reads image files from inside the project it `
        + `is working in. ${nothing} Give a path to a file within the project instead.`
      );
    case "symlink":
      return (
        `That path is a symbolic link, and Vex never follows one when reading an image: a link can be `
        + `repointed after it is checked. ${nothing} Give the path of the real file.`
      );
    case "not_found":
      return `No file exists at that path. ${nothing} Check the path and try again.`;
    case "not_a_regular_file":
      return `That path is not an ordinary file (${refusal.detail}). ${nothing}`;
    case "permission_denied":
      return `That file exists but Vex is not allowed to read it. ${nothing}`;
    case "too_large":
      return (
        `That image is ${refusal.byteLength} bytes and the limit is ${refusal.maxBytes}. ${nothing} `
        + `Use a smaller image.`
      );
    case "empty_file":
      return `That file is empty, so there is no picture to publish. ${nothing}`;
    case "unsupported_image":
      return `${refusal.detail} ${nothing}`;
    case "read_failed":
      return `That image could not be read (${refusal.detail}). ${nothing}`;
  }
}

/** Re-exported so callers state one cap, not three. */
export { NO_FOLLOW_IMAGE_MAX_BYTES };
