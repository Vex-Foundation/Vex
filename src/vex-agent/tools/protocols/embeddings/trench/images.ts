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
      `List the images the user pre-uploaded to their Trench image locker, so a launch can pick one. A Trench launch REQUIRES an image and you cannot create one — only the user can, from the Trench Photos card on the right of the app. Use this when PLANNING a launch, not when launching: if the locker is empty, stop and ask the user to upload one first. Returns metadata only, never the picture. Example queries: what images can I use to launch a token, check the trench image locker, do I have a picture for the launch.`,
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
