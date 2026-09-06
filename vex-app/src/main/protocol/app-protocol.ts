/**
 * Custom app://vex/ protocol handler (post-Electron 25 protocol.handle API).
 *
 * Per skill §3, §7: avoid production file://; use a privileged custom scheme.
 * Schema must be registered as `privileged` BEFORE app.ready (see register()).
 *
 * Path safety: every URL is run through `resolveAppUrl` from
 * `../security/url.ts`, which handles traversal rejection, host check,
 * post-decode `..` detection, and asar-prefix containment.
 *
 * ONE RESERVED ROUTE sits in front of the renderer root: `/user-backdrop/<id>`
 * serves the user's own wallpaper from the CONFIG_DIR byte store
 * (`../shell-backdrop/serve.ts`). `containsTraversal` still runs FIRST, on
 * the raw URL, before the route is even matched; the route's id is anchored
 * (`bg_<32 hex>`) and the store re-checks containment before reading. A
 * request under the reserved prefix never falls through to the renderer
 * root, well-formed or not.
 */

import { net, protocol } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { containsTraversal, resolveAppUrl } from "../security/url.js";
import { matchUserBackdropRoute, serveUserBackdrop } from "../shell-backdrop/serve.js";

const SCHEME = "app";
const EXPECTED_HOST = "vex";

export function registerAppProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: false,
        codeCache: true,
      },
    },
  ]);
}

export function installAppProtocolHandler(rendererRoot: string): void {
  const normalizedRoot = path.resolve(rendererRoot);

  protocol.handle(SCHEME, handleAppRequest(normalizedRoot));
}

/**
 * The request responder, built separately from `installAppProtocolHandler`
 * so a test can drive the real chain (traversal gate, reserved route,
 * renderer-root resolution) without a live `protocol` object.
 */
export function handleAppRequest(
  normalizedRoot: string,
): (request: Pick<Request, "url">) => Response | Promise<Response> {
  return (request) => {
    if (containsTraversal(request.url)) {
      return new Response("Forbidden", { status: 403 });
    }
    const backdrop = matchUserBackdropRoute(request.url, EXPECTED_HOST);
    if (backdrop.kind === "backdrop") return serveUserBackdrop(backdrop.imageId);
    if (backdrop.kind === "refused") return new Response("Not found", { status: 404 });

    const decision = resolveAppUrl({
      rawUrl: request.url,
      expectedHost: EXPECTED_HOST,
      normalizedRoot,
      resolve: path.resolve,
      sep: path.sep,
    });

    switch (decision.kind) {
      case "ok":
        return net.fetch(pathToFileURL(decision.absolutePath).toString());
      case "forbidden":
        return new Response("Forbidden", { status: 403 });
      case "not_found":
        return new Response("Not found", { status: 404 });
      case "bad_request":
        return new Response("Bad request", { status: 400 });
    }
  };
}

export const APP_ORIGIN = `${SCHEME}://${EXPECTED_HOST}`;
