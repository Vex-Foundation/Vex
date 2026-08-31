/**
 * `vex.terminal.*` - the Vex Studio terminal CONTROL plane (stage B2).
 *
 * Nine handlers, all through `registerHandler`, so each one gets sender and
 * subframe validation, a strict input schema, output validation and a redacted
 * `Result` for free. What is specific to this surface:
 *
 *  - THE WINDOW IDENTITY COMES FROM THE EVENT, never from the payload. Every
 *    handler derives `windowId` from `ctx.event.sender.id`, so a renderer
 *    cannot claim to be another window by writing a different number into its
 *    own request. That single line is what makes the ownership check downstream
 *    mean anything.
 *  - EVERY OUTCOME IS A SUCCESSFUL `Result` CARRYING A DISCRIMINATED OUTCOME.
 *    "The project has hit its terminal limit" is an answer, not an error, and
 *    the renderer renders it as a prompt to close one rather than as a failure.
 *    Genuine infrastructure failure still travels as `Result.error`.
 *  - `acquirePort` transfers a `MessagePort`. It is the one handler whose real
 *    effect happens through `webContents.postMessage` rather than through its
 *    return value; the returned nonce is what lets preload match the two.
 */

import { z } from "zod";
import { CH, EV } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  terminalAckResultSchema,
  terminalCreateInputSchema,
  terminalCreateResultSchema,
  terminalHostAvailabilitySchema,
  terminalIdInputSchema,
  terminalPortTicketSchema,
  terminalResizeInputSchema,
  terminalWorkspaceLayoutSchema,
  terminalWorkspaceRestoreSchema,
  terminalWriteInputSchema,
  terminalOutcomeSchema,
  type TerminalHostAvailability,
} from "@shared/schemas/terminal.js";
import { terminalDomain } from "../studio/terminal-domain.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

const empty = z.object({}).strict();
const projectInput = z.object({ projectId: z.string().min(1).max(64) }).strict();
const confirmInput = z.object({ nonce: z.string().min(16).max(128) }).strict();
const persistInput = z
  .object({ layout: terminalWorkspaceLayoutSchema })
  .strict();

/**
 * A revived workspace, or `null` when the project has none to revive.
 *
 * `null` is a real answer and not an absence of one: a project opened for the
 * first time, and a project whose snapshot was discarded, both legitimately
 * have no workspace, and the renderer starts empty rather than showing an
 * error.
 */
const terminalWorkspaceRestoreResultSchema = terminalOutcomeSchema(
  terminalWorkspaceRestoreSchema.nullable(),
);

/** The window this request came from. The payload never gets a say. */
function windowIdOf(ctx: HandlerContext): string {
  return String(ctx.event.sender.id);
}

/**
 * The host's outcome is `TerminalOutcome<unknown>`; each channel's schema then
 * validates the success shape. Passing it through unchanged keeps ONE
 * definition of every refusal code, at the cost of one cast at the seam where
 * a generic outcome meets a specific schema.
 */
function asOutcome<T>(outcome: unknown): T {
  return outcome as T;
}

export function registerStudioTerminalHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.terminal.create,
      domain: "studio",
      inputSchema: terminalCreateInputSchema,
      outputSchema: terminalCreateResultSchema,
      handle: async (input, ctx) =>
        ok(
          asOutcome<z.infer<typeof terminalCreateResultSchema>>(
            await terminalDomain().create(
              windowIdOf(ctx),
              input.projectId,
              input.cols,
              input.rows,
            ),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.write,
      domain: "studio",
      inputSchema: terminalWriteInputSchema,
      outputSchema: terminalAckResultSchema,
      handle: async (input, ctx) =>
        ok(
          asOutcome<z.infer<typeof terminalAckResultSchema>>(
            await terminalDomain().write(
              windowIdOf(ctx),
              input.terminalId,
              input.data,
            ),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.resize,
      domain: "studio",
      inputSchema: terminalResizeInputSchema,
      outputSchema: terminalAckResultSchema,
      handle: async (input, ctx) =>
        ok(
          asOutcome<z.infer<typeof terminalAckResultSchema>>(
            await terminalDomain().resize(
              windowIdOf(ctx),
              input.terminalId,
              input.cols,
              input.rows,
            ),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.kill,
      domain: "studio",
      inputSchema: terminalIdInputSchema,
      outputSchema: terminalAckResultSchema,
      handle: async (input, ctx) =>
        ok(
          asOutcome<z.infer<typeof terminalAckResultSchema>>(
            await terminalDomain().kill(windowIdOf(ctx), input.terminalId),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.acquirePort,
      domain: "studio",
      inputSchema: empty,
      outputSchema: terminalPortTicketSchema,
      handle: async (_input, ctx) =>
        ok(
          asOutcome<z.infer<typeof terminalPortTicketSchema>>(
            await terminalDomain().acquirePort(ctx.event.sender, EV.terminal.port),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.confirmPort,
      domain: "studio",
      inputSchema: confirmInput,
      outputSchema: terminalAckResultSchema,
      handle: (input, ctx) =>
        Promise.resolve(
          ok(
            asOutcome<z.infer<typeof terminalAckResultSchema>>(
              terminalDomain().confirmPort(windowIdOf(ctx), input.nonce),
            ),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.persistWorkspace,
      domain: "studio",
      inputSchema: persistInput,
      outputSchema: terminalAckResultSchema,
      handle: async (input) =>
        ok(
          asOutcome<z.infer<typeof terminalAckResultSchema>>(
            await terminalDomain().persistWorkspace(
              input.layout.projectId,
              input.layout,
            ),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.readWorkspace,
      domain: "studio",
      inputSchema: projectInput,
      // OPEN, which now REVIVES rather than only reading. The channel name is
      // unchanged because the renderer's question is unchanged - "what is this
      // project's terminal workspace" - but the answer is no longer a file's
      // contents. It is the layout on ids that name LIVE ptys, plus the
      // old-to-new map, because ids from a previous session name nothing a
      // running host has ever heard of.
      outputSchema: terminalWorkspaceRestoreResultSchema,
      handle: async (input, ctx) =>
        ok(
          asOutcome<z.infer<typeof terminalWorkspaceRestoreResultSchema>>(
            await terminalDomain().openWorkspace(windowIdOf(ctx), input.projectId),
          ),
        ),
    }),

    registerHandler({
      channel: CH.terminal.availability,
      domain: "studio",
      inputSchema: empty,
      outputSchema: terminalHostAvailabilitySchema,
      handle: (): Promise<Result<TerminalHostAvailability>> =>
        Promise.resolve(ok(terminalDomain().availability)),
    }),
  ];
}
