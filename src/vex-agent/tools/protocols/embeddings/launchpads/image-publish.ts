/**
 * Retrieval metadata for `launchpads.image_publish`.
 *
 * The passage leads with the CONSEQUENCE, not the mechanism. "Upload an image"
 * is the shared idea every neighbouring passage also carries; what separates
 * this one is that the bytes become PUBLIC and permanent, addressed by their
 * own hash, so the picture the user approved is the picture the world sees.
 * A retriever that learns only "upload" cannot separate this from the locker
 * listing next door.
 *
 * BOTH SURFACES ARE NAMED (2026-09-07). The tool gained a Studio arm - the same
 * consent question about a file in the agent's own project - and the passage
 * said "from the user's image locker", which would have kept an agent working
 * in a codebase from ever retrieving it. The surface words are the retrieval
 * cue there, so `imageId` and `imagePath` appear in the text a retriever reads.
 *
 * IT STAYS IN ITS LENGTH CLASS. The style linter caps a passage at 110 words
 * and this one already sat at 110, so the two parameter names were paid for by
 * TRIMMING rather than by growing: the idempotence sentence lost its "returns
 * the same address" half, which the sha256 sentence above it already implies,
 * and "until the user withdraws them" became "until withdrawn". Everything the
 * namespace declaration lists as a retrieval term - image locker, public image
 * host, content-addressed host, staged picture - and the "Use this when" anchor
 * the shape linter requires are untouched, because those are the words a
 * retriever actually keys on.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { LAUNCHPADS_CHAINS } from "../../launchpads/discovery-text.js";

export const LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY = {
  "launchpads.image_publish": {
    embeddingText: embeddingText(
      `Submit one picture - imageId for a staged picture in the app's image locker, imagePath for a project file in Vex Studio - to Vex's public image host, a content-addressed host, so a token launch can put its address on chain. Use this when a launch needs a public link. The bytes become PUBLIC: anyone with the link can fetch them until withdrawn. The address is the sha256 hash of the exact bytes, so it can never point at another picture. Publishing twice uploads nothing. This launches nothing and spends no gas. Example queries: publish my launch image, get a public link for the token picture, host the launch image.`,
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
