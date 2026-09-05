/**
 * User backdrop IPC - `pick`, `clear`, `read`.
 *
 * THE BOUNDARY THIS FILE DEFENDS: no filesystem path and no caller-supplied
 * bytes ever enter these handlers. `pick` takes an EMPTY payload and opens
 * `dialog.showOpenDialog` here in main (precedent: `ipc/images.ts`), so the
 * renderer neither sends nor learns a path; `clear` and `read` take an empty
 * payload too, because there is exactly one backdrop and nothing to name.
 *
 * ONE PICKER AT A TIME PER WINDOW, joined as single-flight rather than
 * refused: a second `pick` from the same sender while the dialog is open
 * resolves with the SAME outcome as the first, so a double-click on the
 * settings button cannot stack two native dialogs and cannot surface an
 * error for something that is not one.
 *
 * LOGGING records the operation, the refusal reason, structural facts and
 * `correlationId` only. Never a path, never a file name, never bytes.
 *
 * The backdrop is GLOBAL by contract (it belongs to the installation, like
 * the launch locker), so there is deliberately no session scope. Sender trust
 * is enforced for every call by `registerHandler`'s `assertTrustedSender`.
 */

import { BrowserWindow, dialog } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  SHELL_BACKDROP_MAX_SOURCE_BYTES,
  SHELL_BACKDROP_MIN_HEIGHT,
  SHELL_BACKDROP_MIN_WIDTH,
  SHELL_BACKDROP_PICKER_EXTENSIONS,
  shellBackdropClearInputSchema,
  shellBackdropClearResultSchema,
  shellBackdropPickInputSchema,
  shellBackdropPickResultSchema,
  shellBackdropReadInputSchema,
  shellBackdropReadResultSchema,
  type ShellBackdropClearResult,
  type ShellBackdropPickResult,
  type ShellBackdropReadResult,
} from "@shared/schemas/shell-backdrop.js";
import { log } from "../logger/index.js";
import {
  clearShellBackdrop,
  installShellBackdropFromFile,
  readShellBackdrop,
  type ShellBackdropRejection,
} from "../shell-backdrop/index.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

function storeUnavailable(correlationId: string, cause: unknown): Result<never, VexError> {
  // Structural log only: a store failure can carry a path in its message, and
  // a path is the one thing this boundary exists to keep on this side.
  log.warn(
    `[ipc:vex:shellBackdrop] store failure correlationId=${correlationId} type=${
      cause instanceof Error ? cause.name : typeof cause
    }`,
  );
  return err({
    code: "shellBackdrop.store_unavailable",
    domain: "shellBackdrop",
    message:
      "Your background image could not be saved or read. Retry, and check that " +
      "the Vex configuration folder is writable.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Map a validation refusal onto its public error. Every message says what to
 * do next, because each of these is something only the user can fix, and the
 * format one is honest that Vex does not convert: no image codec ships with
 * the app, and WebP is refused because this Electron's decoder cannot prove
 * it (measured), not because of a preference.
 */
function rejectionError(
  rejection: ShellBackdropRejection,
  correlationId: string,
): Result<never, VexError> {
  const base = {
    domain: "shellBackdrop",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  } as const;
  switch (rejection.kind) {
    case "too_large":
      return err({
        ...base,
        code: "shellBackdrop.too_large",
        message:
          `That file is ${formatMb(rejection.byteLength)}, over the ` +
          `${formatMb(rejection.maxBytes)} a background image can be. Export a ` +
          `smaller PNG or JPEG and pick it again.`,
      });
    case "too_small":
      return err({
        ...base,
        code: "shellBackdrop.too_small",
        message: "That file is empty or too short to be an image. Pick a PNG or JPEG.",
      });
    case "unsupported_format":
      return err({
        ...base,
        code: "shellBackdrop.unsupported_format",
        message:
          `Vex could not accept that file: ${rejection.reason}. Use a PNG or JPEG ` +
          `under ${formatMb(SHELL_BACKDROP_MAX_SOURCE_BYTES)}. Vex does not convert ` +
          `images, so the file has to already be one of those.`,
      });
    case "undecodable":
      return err({
        ...base,
        code: "shellBackdrop.undecodable",
        message:
          `Vex could not use that image: ${rejection.reason}. A background needs a ` +
          `readable PNG or JPEG of at least ${SHELL_BACKDROP_MIN_WIDTH}x` +
          `${SHELL_BACKDROP_MIN_HEIGHT}.`,
      });
  }
}

/** In-flight pickers, one per sender. See the file header. */
const pickersInFlight = new Map<number, Promise<Result<ShellBackdropPickResult>>>();

function senderKey(ctx: HandlerContext): number {
  const id = (ctx.event.sender as { readonly id?: unknown } | undefined)?.id;
  return typeof id === "number" ? id : 0;
}

async function runPicker(ctx: HandlerContext): Promise<Result<ShellBackdropPickResult>> {
  const parentWindow = BrowserWindow.fromWebContents(ctx.event.sender);
  const pickerOptions = {
    title: "Choose a background image for Vex",
    // A convenience filter for the picker, NOT the validation. The file's
    // magic bytes decide what it is, and the decoder proves it; the list is
    // PNG and JPEG because that is the set this Electron's nativeImage
    // decodes (measured 2026-09-04; WebP reports empty).
    filters: [{ name: "PNG or JPEG image", extensions: [...SHELL_BACKDROP_PICKER_EXTENSIONS] }],
    properties: ["openFile" as const],
  };
  // `showOpenDialog` splits its overloads on the parent argument; passing
  // `undefined` into the BaseWindow position does not typecheck, so pick the
  // parentless overload instead of widening the type.
  const picked = parentWindow
    ? await dialog.showOpenDialog(parentWindow, pickerOptions)
    : await dialog.showOpenDialog(pickerOptions);
  const sourcePath = picked.canceled ? undefined : picked.filePaths[0];

  if (sourcePath === undefined) {
    // An ordinary outcome: echo what is current so the caller's record stays
    // trustworthy, and say nothing changed.
    try {
      const current = await readShellBackdrop();
      log.info(`[ipc:vex:shellBackdrop:pick] cancelled correlationId=${ctx.requestId}`);
      return ok({ backdrop: current, cancelled: true });
    } catch (cause) {
      return storeUnavailable(ctx.requestId, cause);
    }
  }

  let outcome;
  try {
    outcome = await installShellBackdropFromFile(sourcePath);
  } catch (cause) {
    return storeUnavailable(ctx.requestId, cause);
  }
  if (!outcome.ok) {
    log.info(
      `[ipc:vex:shellBackdrop:pick] refused reason=${outcome.rejection.kind} ` +
        `correlationId=${ctx.requestId}`,
    );
    return rejectionError(outcome.rejection, ctx.requestId);
  }
  log.info(
    `[ipc:vex:shellBackdrop:pick] ok mime=${outcome.backdrop.mime} ` +
      `bytes=${outcome.backdrop.byteLength} correlationId=${ctx.requestId}`,
  );
  return ok({ backdrop: outcome.backdrop, cancelled: false });
}

function registerPickHandler(): () => void {
  return registerHandler({
    channel: CH.shellBackdrop.pick,
    domain: "shellBackdrop",
    inputSchema: shellBackdropPickInputSchema,
    outputSchema: shellBackdropPickResultSchema,
    handle: async (_input, ctx): Promise<Result<ShellBackdropPickResult>> => {
      const key = senderKey(ctx);
      const joined = pickersInFlight.get(key);
      if (joined !== undefined) {
        log.info(`[ipc:vex:shellBackdrop:pick] joined in-flight picker correlationId=${ctx.requestId}`);
        return joined;
      }
      const run = runPicker(ctx).finally(() => {
        pickersInFlight.delete(key);
      });
      pickersInFlight.set(key, run);
      return run;
    },
  });
}

function registerClearHandler(): () => void {
  return registerHandler({
    channel: CH.shellBackdrop.clear,
    domain: "shellBackdrop",
    inputSchema: shellBackdropClearInputSchema,
    outputSchema: shellBackdropClearResultSchema,
    handle: async (_input, ctx): Promise<Result<ShellBackdropClearResult>> => {
      try {
        await clearShellBackdrop();
      } catch (cause) {
        return storeUnavailable(ctx.requestId, cause);
      }
      log.info(`[ipc:vex:shellBackdrop:clear] ok correlationId=${ctx.requestId}`);
      return ok({ backdrop: null });
    },
  });
}

function registerReadHandler(): () => void {
  return registerHandler({
    channel: CH.shellBackdrop.read,
    domain: "shellBackdrop",
    inputSchema: shellBackdropReadInputSchema,
    outputSchema: shellBackdropReadResultSchema,
    handle: async (_input, ctx): Promise<Result<ShellBackdropReadResult>> => {
      try {
        const backdrop = await readShellBackdrop();
        return ok({ backdrop });
      } catch (cause) {
        return storeUnavailable(ctx.requestId, cause);
      }
    },
  });
}

export function registerShellBackdropHandlers(): ReadonlyArray<() => void> {
  return [registerPickHandler(), registerClearHandler(), registerReadHandler()];
}
