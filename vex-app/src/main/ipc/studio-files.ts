/**
 * `vex.files.*` - the Vex Studio project-file surface (stage B3a).
 *
 * Four handlers, all through `registerHandler`, so each one gets sender and
 * subframe validation, a strict input schema, output validation and a redacted
 * `Result` for free. What is specific to this surface:
 *
 *  - THE WINDOW IDENTITY COMES FROM THE EVENT, never from the payload. A
 *    subscription belongs to the window that asked for it, and `unwatchFile`
 *    refuses an id another window owns. Reading `ctx.event.sender.id` is what
 *    makes that ownership check mean anything - a payload field would let a
 *    renderer claim to be a different window.
 *  - NO CHANNEL HERE ACCEPTS A PATH. Every request addresses an opaque node
 *    token, and the domain re-derives and re-checks the path on every call.
 *  - EVERY OUTCOME IS A SUCCESSFUL `Result` CARRYING A DISCRIMINATED OUTCOME.
 *    "That file is binary" and "the project was deleted" are answers the UI
 *    renders as statements about the file or the project, not as errors.
 *    Genuine infrastructure failure still travels as `Result.error`.
 *  - READ-ONLY. There is no write, create, rename or delete channel, and that
 *    is a product decision rather than an omission: mutating a user's
 *    repository from a tree is an approval-gated action that does not yet have
 *    an approval.
 */

import {
  filesAckResultSchema,
  filesListChildrenInputSchema,
  filesListChildrenResultSchema,
  filesReadFileInputSchema,
  filesReadFileResultSchema,
  filesUnwatchInputSchema,
  filesWatchInputSchema,
  filesWatchResultSchema,
} from "@shared/schemas/files.js";
import { CH } from "@shared/ipc/channels.js";
import { ok } from "@shared/ipc/result.js";

import { filesDomain } from "../studio/files/files-composition.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

/** The window this request came from. The payload never gets a say. */
function windowIdOf(ctx: HandlerContext): string {
  return String(ctx.event.sender.id);
}

export function registerStudioFilesHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.files.listChildren,
      domain: "studio",
      inputSchema: filesListChildrenInputSchema,
      outputSchema: filesListChildrenResultSchema,
      handle: async (input) => ok(await filesDomain().listChildren(input)),
    }),

    registerHandler({
      channel: CH.files.readFile,
      domain: "studio",
      inputSchema: filesReadFileInputSchema,
      outputSchema: filesReadFileResultSchema,
      handle: async (input) => ok(await filesDomain().readFile(input)),
    }),

    registerHandler({
      channel: CH.files.watchFile,
      domain: "studio",
      inputSchema: filesWatchInputSchema,
      outputSchema: filesWatchResultSchema,
      handle: async (input, ctx) =>
        ok(await filesDomain().watchFile(windowIdOf(ctx), input)),
    }),

    registerHandler({
      channel: CH.files.unwatchFile,
      domain: "studio",
      inputSchema: filesUnwatchInputSchema,
      outputSchema: filesAckResultSchema,
      handle: async (input, ctx) =>
        ok(await filesDomain().unwatchFile(windowIdOf(ctx), input.subscriptionId)),
    }),
  ];
}
