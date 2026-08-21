import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_IMAGES_DISCOVERY } from "../../embeddings/trench/images.js";

// `trench.images` — READ-ONLY listing of the user's pre-uploaded launch
// images (contract C2). METADATA ONLY: the bytes live in the desktop app's
// own store and never enter the model's context (rule 07).
//
// The description carries the PLANNING obligation, not just the capability.
// An agent that discovers an empty locker at signing time has already wasted
// the mission; an agent that checks during planning can ask the user for an
// image while they are still present. That is the whole reason the locker
// exists, so it is stated where the model reads it.

export const TRENCH_IMAGES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.images",
    publicName: "trench__images_list",
    namespace: "trench",
    lifecycle: "active",
    description:
      "List the images the user has pre-uploaded to their Trench image locker, and pick one for a token launch. A Trench launch REQUIRES an image, and you cannot create or upload one — only the user can, from the TRENCH PHOTOS card on the right side of the app. CHECK THIS WHILE PLANNING a launch, never at the moment of launching: if the locker is empty, stop and tell the user to upload an image on the right side before the mission can proceed. Returns metadata only (image id, the user's label, byte size, format, dimensions) — never the picture itself. Pass the chosen imageId to the launch tool. Read-only.",
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
    discovery: TRENCH_IMAGES_DISCOVERY["trench.images"],
  },
];
