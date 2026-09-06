/**
 * The `launchpads` namespace manifest bundle.
 *
 * WHAT THIS NAMESPACE OWNS: the things that are true of a token launch on ANY
 * launchpad, and therefore belong to none of them. Today that is the image
 * locker - one store of the user's staged pictures, shared by pools.fun and
 * Virtuals alike, plus the publication of one of those pictures to a public
 * content-addressed URL a launch can put on chain.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: launching. A launch is a venue's own
 * contract, fee model, verifier and settlement, and those stay with the venue
 * namespace that can be held responsible for them.
 */

import type { ProtocolToolManifest } from "../types.js";
import { LAUNCHPADS_IMAGES_TOOLS } from "./manifests/images.js";
import { LAUNCHPADS_IMAGE_PUBLISH_TOOLS } from "./manifests/image-publish.js";

export const LAUNCHPADS_TOOLS: readonly ProtocolToolManifest[] = [
  ...LAUNCHPADS_IMAGES_TOOLS,
  ...LAUNCHPADS_IMAGE_PUBLISH_TOOLS,
];
