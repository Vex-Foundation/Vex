/**
 * `launchpads` handler registry.
 *
 * `launchpads.images` takes no execution context on purpose: the locker is
 * GLOBAL, so its listing is unscoped and has nothing to read from a session.
 * `launchpads.image_publish` does take one, because it must recheck which
 * consent surface it is running on before it makes a user's bytes public.
 */

import type { ProtocolHandler } from "../types.js";
import { launchpadsImagesHandler } from "./handlers/images.js";
import { launchpadsImagePublishHandler } from "./handlers/image-publish.js";

export const LAUNCHPADS_HANDLERS: Readonly<Record<string, ProtocolHandler>> = {
  "launchpads.images": (p) => launchpadsImagesHandler(p),
  "launchpads.image_publish": (p, context) => launchpadsImagePublishHandler(p, context),
};
