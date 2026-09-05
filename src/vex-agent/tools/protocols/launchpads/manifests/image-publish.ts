import type { ProtocolToolManifest } from "../../types.js";
import { LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY } from "../../embeddings/launchpads/image-publish.js";

// `launchpads.image_publish` - publish ONE locker picture to Vex's public,
// content-addressed image host and record the resulting URL beside the image.
//
// WHY THIS IS A MUTATING TOOL WITH AN APPROVAL, even though it signs nothing
// and spends no gas: it makes the user's bytes PUBLIC. Anyone holding the link
// fetches them without authenticating, and they stay hosted until the user
// withdraws them. That is a consequence a human has to consent to, and consent
// to a picture is not implied by consent to a launch, so it is asked for here
// rather than folded silently into the launch that follows.
//
// WHY THE ADDRESS IS A HASH (coordinator decision I1). A launchpad writes the
// image URL on chain. If that URL could serve different bytes tomorrow, the
// picture the user approved and the picture the world later sees would be two
// different things, with nothing on chain able to tell them apart. So the URL
// is `<host>/a/<sha256 of the exact bytes>.<ext>`: a different picture is a
// different URL, by construction. The mutable-URL fallback was considered and
// rejected.
//
// IDEMPOTENT BY CONTENT. Publishing bytes that were already published returns
// the same address and uploads nothing, so a caller that lost the answer may
// safely ask again. The tool says which of the two happened.

export const LAUNCHPADS_IMAGE_PUBLISH_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "launchpads.image_publish",
    publicName: "launchpads__image_publish",
    namespace: "launchpads",
    lifecycle: "active",
    description:
      "Publish one picture from the user's image locker to Vex's public image host, and return the permanent URL a token launch puts on chain. THE BYTES BECOME PUBLIC: anyone who has the link can fetch them without signing in, and they stay hosted until the user withdraws them. The URL is addressed by the sha256 of the exact bytes, so it can never later serve a different picture than the one approved. Call this AFTER the user has chosen which staged picture to use and BEFORE a launch that needs its URL. This does NOT launch anything, signs nothing and spends no gas. Pass the `imageId` of a picture already in the locker (list them with launchpads__images_list); you can never supply bytes or a URL yourself. Publishing a picture that was already published uploads nothing and returns the same URL, with `alreadyPublished` true. Returns `imageUrl`, `contentId`, `alreadyPublished` and a `disclosure` sentence stating what became public.",
    mutating: true,
    actionKind: "external_post",
    params: [
      {
        key: "imageId",
        type: "string",
        required: true,
        description:
          "Identifier of a picture already staged in the app's image locker, as listed by launchpads__images_list. The agent can never create one, only name one the locker already holds.",
      },
    ],
    exampleParams: { imageId: "img_01" },
    returns:
      "`imageUrl` (the permanent, content-addressed https URL), `contentId` (the sha256 of the bytes, lowercase hex), `alreadyPublished` (true when these exact bytes were already on the host and nothing was uploaded), `byteLength`, `mime`, and `disclosure` - the sentence stating that the bytes are now public and how the user withdraws them.",
    discovery: LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY["launchpads.image_publish"],
  },
];
