/**
 * Image locker IPC (C2) — `list`, `upload`, `delete`, `readThumb`.
 *
 * THE BOUNDARY THIS FILE DEFENDS: no filesystem path and no caller-supplied
 * bytes ever enter these handlers.
 *  - `upload` takes an EMPTY payload and opens `dialog.showOpenDialog` here in
 *    main (precedent: `onboarding/wallets/restore.ts`). The renderer neither
 *    sends nor learns a path, so path traversal is designed out of the
 *    contract rather than filtered out of a parameter.
 *  - every other handler takes an OPAQUE `imageId` (`img_<32 hex>`), which the
 *    shared schema rejects before the handler runs and which the byte store
 *    re-checks for containment before touching disk.
 *
 * LOGGING records the operation, the resulting/incoming image COUNT, the
 * refusal reason, and `correlationId` only. Never a path, never a label (a
 * user's file name), never a digest (a content fingerprint), never bytes.
 *
 * The locker is GLOBAL by contract (C2), so there is deliberately no session
 * scope to check here — an image belongs to the user, not to a conversation.
 * Sender trust is still enforced for every call by `registerHandler`'s
 * `assertTrustedSender`, which is the ownership check that applies to a
 * global resource.
 */

import { BrowserWindow, dialog } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  imagesDeleteInputSchema,
  imagesDeleteResultSchema,
  imagesListInputSchema,
  imagesListResultSchema,
  imagesReadThumbInputSchema,
  imagesReadThumbResultSchema,
  imagesUploadInputSchema,
  imagesUploadResultSchema,
  LOCKER_IMAGE_MAX_BYTES,
  type ImagesDeleteResult,
  type ImagesListResult,
  type ImagesReadThumbResult,
  type ImagesUploadResult,
} from "@shared/schemas/images.js";
import {
  deleteLockerImage,
  listLockerImages,
  readLockerImageDataUrl,
  storeLockerImageFromFile,
  type LockerImageRejection,
} from "../images/index.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

function storeUnavailable(correlationId: string, cause: unknown): Result<never, VexError> {
  // Structural log only: a store failure can carry a path in its message, and
  // a path is the one thing this boundary exists to keep on this side.
  log.warn(
    `[ipc:vex:images] store failure correlationId=${correlationId} type=${
      cause instanceof Error ? cause.name : typeof cause
    }`,
  );
  return err({
    code: "images.store_unavailable",
    domain: "images",
    message: "Your image locker could not be read. Retry, and check that Vex services are running.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function notFound(correlationId: string): Result<never, VexError> {
  return err({
    code: "images.not_found",
    domain: "images",
    message: "That image is no longer in your locker.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

/**
 * Map a validation refusal onto its public error. Each message says what to do
 * next, because every one of these is something only the user can fix — and
 * `unsupported_format` in particular must be honest that we do NOT convert:
 * no image codec ships with the app, so "we'll transcode it for you" is not a
 * capability that exists.
 */
function rejectionError(
  rejection: LockerImageRejection,
  correlationId: string,
): Result<never, VexError> {
  if (rejection.kind === "too_large") {
    return err({
      code: "images.too_large",
      domain: "images",
      message:
        `That image is ${formatKb(rejection.byteLength)} — the limit is ` +
        `${formatKb(rejection.maxBytes)}. The image is stored inside the launch ` +
        `transaction itself, so its size is gas you pay. Shrink it and try again.`,
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    });
  }
  if (rejection.kind === "too_small") {
    return err({
      code: "images.unsupported_format",
      domain: "images",
      message: "That file is empty or too short to be an image.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    });
  }
  return err({
    code: "images.unsupported_format",
    domain: "images",
    message:
      `Vex could not accept that file: ${rejection.reason}. Use a JPEG, PNG, or ` +
      `WebP under ${formatKb(LOCKER_IMAGE_MAX_BYTES)}. Vex does not convert images, ` +
      `so the file has to already be one of those.`,
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function formatKb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} KB`;
}

// ── list ──────────────────────────────────────────────────────────────────

function registerImagesListHandler(): () => void {
  return registerHandler({
    channel: CH.images.list,
    domain: "images",
    inputSchema: imagesListInputSchema,
    outputSchema: imagesListResultSchema,
    handle: async (_input, ctx): Promise<Result<ImagesListResult>> => {
      try {
        const images = await listLockerImages();
        log.info(
          `[ipc:vex:images:list] ok count=${images.length} correlationId=${ctx.requestId}`,
        );
        return ok({ images });
      } catch (cause) {
        return storeUnavailable(ctx.requestId, cause);
      }
    },
  });
}

// ── upload ────────────────────────────────────────────────────────────────

function registerImagesUploadHandler(): () => void {
  return registerHandler({
    channel: CH.images.upload,
    domain: "images",
    inputSchema: imagesUploadInputSchema,
    outputSchema: imagesUploadResultSchema,
    handle: async (_input, ctx): Promise<Result<ImagesUploadResult>> => {
      const parentWindow = BrowserWindow.fromWebContents(ctx.event.sender);
      const pickerOptions = {
        title: "Add a launch image to your Trench locker",
        // A convenience filter for the picker — NOT the validation. The file's
        // magic bytes decide what it is, and an extension proves nothing.
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
        properties: ["openFile" as const],
      };
      // `showOpenDialog` splits its overloads on the parent argument — passing
      // `undefined` into the BaseWindow position does not typecheck, so pick
      // the parentless overload instead of widening the type.
      const picked = parentWindow
        ? await dialog.showOpenDialog(parentWindow, pickerOptions)
        : await dialog.showOpenDialog(pickerOptions);
      const sourcePath = picked.canceled ? undefined : picked.filePaths[0];
      if (sourcePath === undefined) {
        return err({
          code: "internal.cancelled",
          domain: "images",
          message: "No image selected.",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }

      let outcome;
      try {
        outcome = await storeLockerImageFromFile(sourcePath);
      } catch (cause) {
        return storeUnavailable(ctx.requestId, cause);
      }
      if (!outcome.ok) {
        log.info(
          `[ipc:vex:images:upload] refused reason=${outcome.rejection.kind} ` +
            `correlationId=${ctx.requestId}`,
        );
        return rejectionError(outcome.rejection, ctx.requestId);
      }
      log.info(
        `[ipc:vex:images:upload] ok mime=${outcome.image.mime} ` +
          `bytes=${outcome.image.byteLength} correlationId=${ctx.requestId}`,
      );
      return ok({ image: outcome.image });
    },
  });
}

// ── delete ────────────────────────────────────────────────────────────────

/**
 * The C2 lifecycle guarantee lives in the repo's transaction, not here: a
 * check-then-delete in main would leave a window in which a launch intent
 * could be created between the two. This handler's job is to render the
 * repo's verdict — and on refusal, to NAME the launch that is holding the
 * image, so "no" is an explanation rather than an obstacle.
 */
function registerImagesDeleteHandler(): () => void {
  return registerHandler({
    channel: CH.images.delete,
    domain: "images",
    inputSchema: imagesDeleteInputSchema,
    outputSchema: imagesDeleteResultSchema,
    handle: async (input, ctx): Promise<Result<ImagesDeleteResult>> => {
      let outcome;
      try {
        outcome = await deleteLockerImage(input.imageId);
      } catch (cause) {
        return storeUnavailable(ctx.requestId, cause);
      }
      if (outcome.deleted) {
        log.info(`[ipc:vex:images:delete] ok correlationId=${ctx.requestId}`);
        return ok({ imageId: input.imageId });
      }
      if (outcome.reason === "not_found") return notFound(ctx.requestId);

      const names = outcome.intents.map((intent) => intent.name).join(", ");
      log.info(
        `[ipc:vex:images:delete] refused reason=in_use intents=${outcome.intents.length} ` +
          `correlationId=${ctx.requestId}`,
      );
      return err({
        code: "images.in_use",
        domain: "images",
        message:
          `This image is still being used by a launch in progress (${names}). ` +
          `Finish or cancel that launch first — deleting the image now would leave ` +
          `it with nothing to publish.`,
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: ctx.requestId,
      });
    },
  });
}

// ── readThumb ─────────────────────────────────────────────────────────────

function registerImagesReadThumbHandler(): () => void {
  return registerHandler({
    channel: CH.images.readThumb,
    domain: "images",
    inputSchema: imagesReadThumbInputSchema,
    outputSchema: imagesReadThumbResultSchema,
    handle: async (input, ctx): Promise<Result<ImagesReadThumbResult>> => {
      let dataUrl;
      try {
        dataUrl = await readLockerImageDataUrl(input.imageId);
      } catch (cause) {
        return storeUnavailable(ctx.requestId, cause);
      }
      if (dataUrl === null) return notFound(ctx.requestId);
      return ok({ imageId: input.imageId, dataUrl });
    },
  });
}

export function registerImagesHandlers(): ReadonlyArray<() => void> {
  return [
    registerImagesListHandler(),
    registerImagesUploadHandler(),
    registerImagesDeleteHandler(),
    registerImagesReadThumbHandler(),
  ];
}
