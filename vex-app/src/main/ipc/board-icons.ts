/**
 * BOARD TOKEN ICON IPC - `read`.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer names an OPAQUE icon handle and
 * nothing else. It cannot name a host, a path, a size, a timeout or a format;
 * every one of those is main's, and they are constants in
 * `main/images/board-icon-service.ts` rather than parameters, so there is no
 * knob on this channel for a caller to turn. A well-formed id is still not an
 * authorization to fetch anything: the service composes the URL itself and the
 * DexScreener bridge's allowlist checks the host and path prefix on the exact
 * URL it is about to open.
 *
 * ABSENCE IS A SUCCESS. About half of the pools a board can carry have no
 * profile artwork, so "no icon" rides the ok path as a named union member and
 * the card draws its monogram. A `Result` error from this handler therefore
 * means only invalid input or an untrusted sender, which is what makes those
 * two worth alerting on.
 *
 * LOGGING records the outcome KIND and the correlation id. Never the icon id
 * (it identifies a token a user is looking at), never a URL, never bytes.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  boardIconReadInputSchema,
  boardIconReadResultSchema,
  type BoardIconReadResult,
} from "@shared/schemas/board-icons.js";
import { resolveBoardIcon } from "../images/index.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

export function registerBoardIconHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.boardIcons.read,
      domain: "images",
      inputSchema: boardIconReadInputSchema,
      outputSchema: boardIconReadResultSchema,
      handle: async (input, ctx): Promise<Result<BoardIconReadResult>> => {
        const icon = await resolveBoardIcon(input.iconId);
        if (icon.kind !== "image") {
          log.info(
            `[ipc:vex:boardIcons:read] ${icon.kind} reason=${icon.reason} ` +
              `correlationId=${ctx.requestId}`,
          );
        }
        return ok({
          iconId: input.iconId,
          // Re-shaped rather than forwarded: the service's resolution type is a
          // main-side type and this one is the wire contract. They agree today,
          // and this is the seam that makes a future divergence a compile
          // error instead of an unnoticed schema violation.
          icon:
            icon.kind === "image"
              ? { kind: "image", dataUrl: icon.dataUrl }
              : icon.kind === "absent"
                ? { kind: "absent", reason: icon.reason }
                : icon.kind === "refused_by_policy"
                  ? { kind: "refused_by_policy", reason: icon.reason }
                  : { kind: "unavailable", reason: icon.reason },
        });
      },
    }),
  ];
}
