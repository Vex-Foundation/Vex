import type { ProtocolNamespaceNavigation } from "../types.js";

/**
 * The launchpad-neutral namespace: what is true of a token launch on ANY
 * launchpad and therefore belongs to none of them.
 *
 * Today that is the image locker, one store of pictures the user staged in the
 * app, shared by pools.fun and Virtuals alike, plus the publication of one of
 * those pictures to a permanent public URL a launch can put on chain. The venue
 * namespaces keep launching: a launch is a venue's own contract, fee model,
 * verifier and settlement, and those stay where they can be held responsible.
 */
export const LAUNCHPADS_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "launchpads",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary:
    "The pieces every token launch shares, whichever launchpad it goes to: the user's IMAGE LOCKER of staged pictures, and the publication of one picture to a permanent public URL addressed by its own sha256, which is what a launchpad writes on chain. The locker is one locker - a picture staged once serves a pools.fun launch and a Virtuals launch alike.",
  whenToUse:
    "Use when a launch needs a picture: list what the user has staged, and publish the chosen one so the launch has a public address for it. Check the locker WHILE PLANNING a launch, not at the moment of launching, because only the user can add a picture and only while they are present. Publishing makes the bytes public and is approval-gated; it signs nothing and spends no gas.",
  preferInstead:
    "Use `pools` or `virtuals` for the launch itself - its cost, its form, its signing and its settlement. This namespace never launches anything.",
  declaration: {
    identity: "The launchpad-neutral half of a token launch: the shared image locker, and the public content-addressed host a launch's image URL points at.",
    read: "List the pictures staged in the user's image locker: label, size, format, and whether each already has a public address.",
    quote: "Nothing here is priced; publishing a picture costs nothing.",
    act: "Publish one staged picture to Vex's public image host, under the ordinary approval card, and record its permanent URL.",
    whenItApplies: "Use it whenever a launch on any launchpad needs a picture, or the user asks what pictures are staged.",
    characteristicAndLimits: "You can never create, upload or supply a picture, only name one the locker holds. Publishing makes the bytes PUBLIC and permanent until the user withdraws them; the URL is the picture's own hash, so it can never later serve different bytes. Only metadata leaves the locker.",
    // Every term here must appear VERBATIM in BOTH the declaration prose above
    // AND the namespace's tool embedding passages (`protocol-declarations.test.ts`):
    // a retrieval term one of them does not carry is a promise the model-visible
    // text never keeps, and a term the retriever cannot match is dead weight.
    retrievalTerms: [
      "image locker",
      "public image host",
      "content-addressed host",
      "staged picture",
      "what pictures are staged",
    ],
    facets: [
      "The shared image locker",
      "Publishing a launch image",
    ],
    // No runtime chain projection, and that is the truth rather than a gap: a
    // staged picture is not a chain fact. The locker holds the same bytes
    // whichever launchpad and whichever chain a launch eventually goes to, so
    // claiming a chain list here would invent a constraint that does not exist.
    coverageNote:
      "No chain of its own: the locker and its host are chain-agnostic, and one staged picture serves "
      + "a launch on any chain.",
  },
  exampleQueries: [
    'ToolSearch(query="what images are staged for a token launch", namespace="launchpads")',
    'ToolSearch(query="publish the launch image and get its public url", namespace="launchpads")',
  ],
  aliases: [
    "launchpads",
    "image locker",
    "launch images",
    "token launch artwork",
    "launch image host",
  ],
  discoveryHints: [
    "what images can I use to launch a token",
    "check the image locker",
    "do I have a picture staged for the launch",
    "publish my launch image",
    "public url for the token picture",
  ],
  facets: [
    {
      label: "The shared image locker",
      summary:
        "List the pictures the user has staged in the app, metadata only. The locker is shared by every launchpad, so the same picture serves any launch. A launch REQUIRES one and the agent can never supply it; check while planning, and if the locker is empty ask the user to add a picture on the image card.",
      toolPrefixes: ["launchpads.images"],
      hints: [
        "what images do I have for a launch",
        "check the image locker",
        "list my staged launch images",
        "pick a launch image",
        "is there a picture for the token",
      ],
    },
    {
      label: "Publishing a launch image",
      summary:
        "Publish one staged picture to Vex's public image host and get the permanent URL a launch puts on chain. The bytes become public and stay hosted until withdrawn; the URL is the picture's own sha256, so it can never serve different bytes later. Approval-gated, signs nothing, spends no gas, and publishing the same picture twice returns the same URL.",
      toolPrefixes: ["launchpads.image_publish"],
      hints: [
        "publish the launch image",
        "get a public url for the token picture",
        "host my launch image",
        "make the picture public for the launch",
      ],
    },
  ],
};
