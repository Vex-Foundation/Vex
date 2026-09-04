/**
 * The app-protocol ROUTE for the user backdrop: `app://vex/user-backdrop/<id>`.
 *
 * Two halves, kept apart so the first is testable as a table:
 *  - `matchUserBackdropRoute` is PURE: given the raw request URL it says
 *    whether this request is for the backdrop route at all, and if so
 *    whether the id is well-formed. It never touches the disk.
 *  - `serveUserBackdrop` resolves the id through the store's two-gate
 *    resolver, re-sniffs the bytes it is about to send (the Content-Type is
 *    derived from the MAGIC BYTES of what is on disk, never from a name), and
 *    answers with `Cache-Control: no-store`. The id changes on every pick, so
 *    there is nothing to revalidate and nothing to keep.
 *
 * `containsTraversal` runs in the protocol handler BEFORE either half, as it
 * does for every other app:// request (url.ts). A backdrop request that
 * matched the route with a malformed id is a 404, not a fall-through into
 * the renderer-root resolver: the prefix is reserved for this owner.
 *
 * Imports only the store and the pure validation so the protocol handler
 * never depends on the service (and its preferences dependency): serving a
 * file must not wait behind a picker.
 */

import {
  SHELL_BACKDROP_ID_PATTERN,
  SHELL_BACKDROP_ROUTE_PREFIX,
} from "@shared/schemas/shell-backdrop.js";
import { validateLockerImageBytes } from "../images/index.js";
import { log } from "../logger/index.js";
import { BackdropPathEscapeError, readBackdropBytes } from "./store.js";

export type UserBackdropRoute =
  /** Not a backdrop request: the handler continues with the renderer root. */
  | { readonly kind: "none" }
  /** The backdrop prefix with a well-formed id. */
  | { readonly kind: "backdrop"; readonly imageId: string }
  /** The backdrop prefix with anything else after it: reserved, refused. */
  | { readonly kind: "refused" };

export function matchUserBackdropRoute(rawUrl: string, expectedHost: string): UserBackdropRoute {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "none" };
  }
  if (url.host !== expectedHost) return { kind: "none" };
  if (!url.pathname.startsWith(SHELL_BACKDROP_ROUTE_PREFIX)) return { kind: "none" };
  const imageId = url.pathname.slice(SHELL_BACKDROP_ROUTE_PREFIX.length);
  if (!SHELL_BACKDROP_ID_PATTERN.test(imageId)) return { kind: "refused" };
  return { kind: "backdrop", imageId };
}

/**
 * Serve one backdrop. 404 for an unknown id; 403 if the id could ever name a
 * path outside the store (unreachable while the matcher's pattern holds, and
 * pinned so a loosened pattern fails closed); 404 for bytes on disk that no
 * longer sniff as PNG or JPEG, because a Content-Type is a promise about the
 * body and this handler will not make one it cannot prove.
 */
export async function serveUserBackdrop(imageId: string): Promise<Response> {
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readBackdropBytes(imageId);
  } catch (cause) {
    if (cause instanceof BackdropPathEscapeError) {
      return new Response("Forbidden", { status: 403 });
    }
    log.warn(
      `[shell-backdrop] serve read failed type=${
        cause instanceof Error ? cause.name : typeof cause
      }`,
    );
    return new Response("Not found", { status: 404 });
  }
  if (bytes === null) return new Response("Not found", { status: 404 });
  const sniffed = validateLockerImageBytes(bytes);
  if (!sniffed.ok || (sniffed.mime !== "image/png" && sniffed.mime !== "image/jpeg")) {
    log.warn("[shell-backdrop] serve refused: stored bytes are not PNG or JPEG");
    return new Response("Not found", { status: 404 });
  }
  return new Response(bytes.buffer, {
    status: 200,
    headers: {
      "Content-Type": sniffed.mime,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
