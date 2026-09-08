import type { ProtocolToolManifest } from "../../types.js";
import { CANONICAL_MCP_APPROVAL_SENTENCE } from "../../conventions.js";
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
//
// TWO SURFACES, ONE QUESTION. In the Vex app the picture is named by `imageId`,
// because it is one the user staged in the image locker. Over the Vex Studio
// MCP surface there is no locker, so it is named by `imagePath`: a file inside
// the project the agent is working in, which Vex reads itself without following
// symlinks. Neither parameter is `required` in the schema, because WHICH one is
// required depends on the surface the call arrives on and a manifest is static;
// the handler enforces it and refuses the other surface's parameter BY NAME.
// The consent question, the approval card and the disclosure are identical on
// both: what makes this tool mutating is that bytes become public, and that is
// as true of a file in a repository as of a picture in the locker.

export const LAUNCHPADS_IMAGE_PUBLISH_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "launchpads.image_publish",
    publicName: "launchpads__image_publish",
    namespace: "launchpads",
    lifecycle: "active",
    description:
      "Publish one picture to Vex's public image host, and return the permanent URL a token launch puts on chain. THE BYTES BECOME PUBLIC: anyone who has the link can fetch them without signing in, and they stay hosted until the user withdraws them. The URL is addressed by the sha256 of the exact bytes, so it can never later serve a different picture than the one approved. Call this BEFORE a launch that needs the URL. This does NOT launch anything, signs nothing and spends no gas. NAME THE PICTURE THE WAY YOUR SURFACE NAMES IT: in the Vex app pass `imageId`, a picture the user already staged in the image locker (list them with launchpads__images_list); over the Vex Studio MCP surface pass `imagePath`, the path of an image file INSIDE this project, which Vex reads itself - it never follows a symbolic link, never reads outside the project, and refuses a file that is not a PNG, JPEG or WebP under 2 MiB. The other surface's parameter is REFUSED BY NAME rather than ignored, and you can never supply bytes or a URL yourself. Publishing bytes that were already published uploads nothing and returns the same URL, with `alreadyPublished` true. " + CANONICAL_MCP_APPROVAL_SENTENCE + " Returns `imageUrl`, `contentId`, `alreadyPublished` and a `disclosure` sentence stating what became public.",
    mutating: true,
    actionKind: "external_post",
    params: [
      {
        key: "imageId",
        type: "string",
        description:
          "IN-APP ONLY: identifier of a picture already staged in the app's image locker, as listed by launchpads__images_list. The agent can never create one, only name one the locker already holds. Over the Vex Studio MCP surface this parameter is REFUSED BY NAME and imagePath is used instead. Required on this surface, and enforced by the tool rather than by the schema, because which parameter names the picture depends on the surface.",
      },
      {
        key: "imagePath",
        type: "string",
        description:
          "VEX STUDIO MCP ONLY: the path of an image file INSIDE the current project (PNG, JPEG or WebP, at most 2 MiB), which Vex reads itself and publishes. Symbolic links are never followed and a path outside the project is refused by name. In the Vex app this parameter is REFUSED BY NAME and imageId is used instead. Required on this surface, and enforced by the tool rather than by the schema.",
      },
    ],
    exampleParams: { imageId: "img_01" },
    returns:
      "`imageUrl` (the permanent, content-addressed https URL), `contentId` (the sha256 of the bytes, lowercase hex), `alreadyPublished` (true when these exact bytes were already on the host and nothing was uploaded), `byteLength`, `mime`, `imageId` (the record Vex keeps of this publication, which a launch on the in-app surface names; null only when the picture was published but Vex could not record it, and then a `warning` says so), `imagePath` on the Studio surface, and `disclosure` - the sentence stating that the bytes are now public and how the user withdraws them.",
    discovery: LAUNCHPADS_IMAGE_PUBLISH_DISCOVERY["launchpads.image_publish"],
  },
];
