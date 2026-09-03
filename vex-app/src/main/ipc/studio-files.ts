/**
 * `vex.files.*` - the Vex Studio project-file surface (stage B3a).
 *
 * Nine handlers, all through `registerHandler`, so each one gets sender and
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
 *  - ONE OF THE NINE IS NOT A RENDERER CAPABILITY. `ackEvent` is the files
 *    surface's flow control and is sent by PRELOAD; `FilesBridge` exposes no
 *    method for it, so renderer code has nothing to call and cannot inflate its
 *    own credit.
 *  - THREE OF THE NINE WRITE (stage EXP-1). `create`, `rename` and `delete`
 *    replaced the "read-only, mutating a user's repository is an approval-gated
 *    action that does not yet have an approval" note this block used to carry.
 *    The approval exists now and it is the USER, in their own window: these are
 *    the user's own files, the actor is the sender of the IPC event, and no
 *    agent surface can reach these channels. The renderer never sends a delete
 *    without its own consent dialog, and the `mode` it carries is the
 *    disposition that dialog described. Everything a write needs beyond that -
 *    name rules, the Vex-managed refusal, the per-project write lock, the trash
 *    and the last-moment re-resolution - belongs to
 *    `studio/files/mutations.ts`; these handlers add only the boundary.
 *  - A WRITE CARRIES THE REQUEST'S SIGNAL. `ctx.signal` reaches the mutation, so
 *    a user who cancels while a write waits for the project's lock gets
 *    `internal.cancelled` and NOTHING is written. An abort after the syscall
 *    begins is ignored: a filesystem offers no safe abandonment point, and an
 *    outcome this process reported without knowing it would be a guess.
 */

import {
  filesAckEventInputSchema,
  filesAckResultSchema,
  filesCreateInputSchema,
  filesCreateResultSchema,
  filesDeleteInputSchema,
  filesDeleteResultSchema,
  filesRenameInputSchema,
  filesRenameResultSchema,
  filesListChildrenInputSchema,
  filesListChildrenResultSchema,
  filesReadFileInputSchema,
  filesReadFileResultSchema,
  filesRevealInFileManagerInputSchema,
  filesRevealInFileManagerResultSchema,
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

    // FLOW CONTROL, not a renderer capability. Preload sends one of these per
    // `changed` batch it has handed to a renderer callback; nothing in
    // `FilesBridge` exposes it, so renderer code cannot reach it. The window
    // identity is the sender's, so an ack cannot credit another window.
    registerHandler({
      channel: CH.files.ackEvent,
      domain: "studio",
      inputSchema: filesAckEventInputSchema,
      outputSchema: filesAckResultSchema,
      handle: (input, ctx) =>
        Promise.resolve(
          ok(filesDomain().ackEvent(windowIdOf(ctx), input.subscriptionId)),
        ),
    }),

    registerHandler({
      channel: CH.files.unwatchFile,
      domain: "studio",
      inputSchema: filesUnwatchInputSchema,
      outputSchema: filesAckResultSchema,
      handle: async (input, ctx) =>
        ok(await filesDomain().unwatchFile(windowIdOf(ctx), input.subscriptionId)),
    }),

    // REVEAL. Read-only, and the only handler whose effect leaves this app:
    // main resolves the node through the domain's own authority chain and asks
    // the desktop to show the resolved path. It takes no path, writes nothing
    // and returns no bytes, so it raises no approval - what it discloses is a
    // location the user is already looking at, to the window that asked.
    //
    // NO SIGNAL IS PASSED, deliberately. The work is one resolution followed by
    // a synchronous platform call with no cancellable window, and handing it a
    // signal would advertise a cancellation that could never be honoured.
    registerHandler({
      channel: CH.files.revealInFileManager,
      domain: "studio",
      inputSchema: filesRevealInFileManagerInputSchema,
      outputSchema: filesRevealInFileManagerResultSchema,
      handle: async (input) => ok(await filesDomain().revealInFileManager(input)),
    }),

    /* ---------------- writes ---------------- */

    registerHandler({
      channel: CH.files.create,
      domain: "studio",
      inputSchema: filesCreateInputSchema,
      outputSchema: filesCreateResultSchema,
      handle: async (input, ctx) =>
        ok(await filesDomain().createNode({ ...input, signal: ctx.signal })),
    }),

    registerHandler({
      channel: CH.files.rename,
      domain: "studio",
      inputSchema: filesRenameInputSchema,
      outputSchema: filesRenameResultSchema,
      handle: async (input, ctx) =>
        ok(await filesDomain().renameNode({ ...input, signal: ctx.signal })),
    }),

    // THE DESTRUCTIVE ONE. `mode` is the disposition the user's confirmation
    // described, and main honours exactly it: a `trash` that the platform
    // refuses answers `trash_unavailable` with the entry untouched, never a
    // permanent delete the user did not agree to.
    registerHandler({
      channel: CH.files.delete,
      domain: "studio",
      inputSchema: filesDeleteInputSchema,
      outputSchema: filesDeleteResultSchema,
      handle: async (input, ctx) =>
        ok(await filesDomain().deleteNode({ ...input, signal: ctx.signal })),
    }),
  ];
}
