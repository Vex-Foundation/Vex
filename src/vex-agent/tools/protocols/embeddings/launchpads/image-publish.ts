/**
 * Retrieval metadata for `launchpads.image_publish`.
 *
 * The passage leads with the CONSEQUENCE, not the mechanism. "Upload an image"
 * is the shared idea every neighbouring passage also carries; what separates
 * this one is that the bytes become PUBLIC and permanent, addressed by their
 * own hash, so the picture the user approved is the picture the world sees.
 * A retriever that learns only "upload" cannot separate this from the locker
 * listing next door.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { LAUNCHPADS_CHAINS } from "../../launchpads/discovery-text.js";

export const LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY = {
  "launchpads.image_publish": {
    embeddingText: embeddingText(
      `Submit one staged picture from the user's image locker to Vex's content-addressed public image host so a token launch can put its address on chain. Use this when a launch needs a public image link. The bytes become PUBLIC: anyone with the link can fetch them until the user withdraws them. The address is the sha256 hash of the exact bytes, so it can never point at a different picture later. Publishing the same picture twice returns the same address and uploads nothing. This launches nothing and spends no gas. Example queries: publish my launch image, get a public link for the token picture, host the image for the launch.`,
    ),
    aliases: [
      "publish launch image",
      "public image url",
      "host token image",
      "upload token artwork",
      "image link for launch",
    ],
    exampleIntents: [
      "publish the picture I staged for the launch",
      "get a public url for my token image",
      "host my launch image so the token can point at it",
    ],
    chains: LAUNCHPADS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY has ${Object.keys(LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
