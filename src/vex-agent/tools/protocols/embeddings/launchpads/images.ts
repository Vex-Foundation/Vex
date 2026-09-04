/**
 * Retrieval metadata for `launchpads.images`. Read-only metadata listing, no
 * mutating action verb, and no image bytes anywhere in the passage.
 * English-only.
 *
 * The passage encodes the PLANNING obligation as well as the capability: the
 * locker must be checked while a launch is still being planned, so an empty
 * locker becomes "ask the user to upload one" instead of a failure discovered
 * at signing time.
 *
 * It is deliberately LAUNCHPAD-NEUTRAL. The nearest neighbours in this space
 * are the per-launchpad launch tools, and a passage that names one launchpad
 * teaches the retriever that the locker belongs to it. The locker is shared.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { LAUNCHPADS_CHAINS } from "../../launchpads/discovery-text.js";

export const LAUNCHPADS_IMAGES_DISCOVERY = {
  "launchpads.images": {
    embeddingText: embeddingText(
      `List the pictures the user has staged in the app's image locker, so a token launch can pick one. The locker is shared by every launchpad Vex supports, so the same picture serves a pools.fun launch and a Virtuals launch alike. A launch REQUIRES an image and you cannot create or upload one: only the user can, from the image card on the right of the app. Use this when PLANNING a launch, not at the moment of launching. If the locker is empty, stop and ask the user to add a picture first. Returns metadata only, never the picture itself. Example queries: what images can I use to launch a token, check the image locker, what pictures are staged, do I have a staged picture for the launch.`,
    ),
    aliases: [
      "image locker",
      "launch images",
      "staged images",
      "available token images",
      "uploaded images",
      "token artwork",
    ],
    exampleIntents: [
      "what images do I have for a token launch",
      "check the image locker",
      "list my staged launch images",
    ],
    chains: LAUNCHPADS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(LAUNCHPADS_IMAGES_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `LAUNCHPADS_IMAGES_DISCOVERY has ${Object.keys(LAUNCHPADS_IMAGES_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
