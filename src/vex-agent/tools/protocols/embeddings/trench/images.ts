/**
 * Retrieval metadata for `trench.images`. Read-only metadata listing — no
 * mutating action verb, and no image bytes anywhere in the passage. English-
 * only.
 *
 * The passage deliberately encodes the PLANNING obligation as well as the
 * capability: the locker must be checked while a launch is still being
 * planned, so an empty locker becomes "ask the user to upload one" instead of
 * a failure discovered at signing time.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_IMAGES_DISCOVERY = {
  "trench.images": {
    embeddingText: embeddingText(
      `List the images the user has pre-uploaded to their Trench image locker, so a token launch can pick one. ` +
      `A Trench token launch REQUIRES an image and you have no way to create or upload one yourself — only the user can, from the Trench Photos card on the right side of the app. ` +
      `Check this list while you are still PLANNING a launch, not at the moment of launching: if the locker is empty, stop and ask the user to upload an image on the right side before the mission can go any further. ` +
      `Returns metadata only — an image id, the user's label for it, its size, format, and dimensions. It never returns the picture itself. ` +
      `Use the image id you choose here as the image for a launch. ` +
      `Example queries: what images can I use to launch a token, check the trench image locker, do I have a picture for the token launch.`,
    ),
    aliases: ["image locker", "trench photos", "launch images", "available token images", "uploaded images"],
    exampleIntents: ["what images do I have for a token launch", "check the trench image locker", "list my uploaded launch images"],
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(TRENCH_IMAGES_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_IMAGES_DISCOVERY has ${Object.keys(TRENCH_IMAGES_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
