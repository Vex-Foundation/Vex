import type { ProtocolToolManifest } from "../../types.js";
import { LAUNCHPADS_IMAGES_DISCOVERY } from "../../embeddings/launchpads/images.js";

// `launchpads.images` - READ-ONLY listing of the pictures the user has staged
// in the app's image locker (contract C2). METADATA ONLY: the bytes live in the
// desktop app's own store and never enter the model's context (rule 07).
//
// LAUNCHPAD-NEUTRAL BY NAME AND BY WORDING. There is one locker, shared by
// every launchpad Vex supports; the byte resolver that reads it
// (`shared/launch-image-byte-resolver.ts`) was moved to `shared/` for exactly
// this reason, and this tool is the same responsibility one layer up. A name
// prefixed with a single launchpad taught the model that the locker belonged
// to that launchpad, which was never true.
//
// The description carries the PLANNING obligation, not just the capability.
// An agent that discovers an empty locker at signing time has already wasted
// the mission; an agent that checks during planning can ask the user for an
// image while they are still present. That is the whole reason the locker
// exists, so it is stated where the model reads it.

export const LAUNCHPADS_IMAGES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "launchpads.images",
    publicName: "launchpads__images_list",
    namespace: "launchpads",
    lifecycle: "active",
    description:
      "List the pictures the user has staged in the app's image locker, and pick one for a token launch. The locker is SHARED by every launchpad Vex supports, so one picture serves any of them. A launch REQUIRES an image, and you cannot create or upload one - only the user can, from the image card on the right side of the app. CHECK THIS WHILE PLANNING a launch, never at the moment of launching: if the locker is empty, stop and tell the user to add an image on the right side before the mission can proceed. Returns `count`, `totalAvailable`, `truncated` and `images` - metadata only (image id, the user's label, byte size, format, dimensions, and whether the picture has already been published to a public URL), never the picture itself. Pass the chosen imageId to the launch tool. THERE IS NO CONTINUATION HERE, no cursor and no page: `truncated` is true when the locker holds more images than `limit` returned, and a `truncationNote` then says how many were dropped and how to reach them: raise `limit` (maximum 50) while it is below the maximum; at `limit` 50 the images beyond it are unreachable through this tool, so ask the user which image they mean. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "limit",
        type: "number",
        description: "Optional maximum number of images to return, most recently uploaded first (1-50, default 20).",
      },
    ],
    exampleParams: {},
    discovery: LAUNCHPADS_IMAGES_DISCOVERY["launchpads.images"],
  },
];
