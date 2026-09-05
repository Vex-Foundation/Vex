/**
 * The four Virtuals agent-LAUNCH tools: preview, execute, status and cancel.
 *
 * ## Why four, when the other launchpads here have two
 *
 * Because a Virtuals launch takes TWO transactions and only the first is ours.
 * `preLaunch` creates the agent and takes the creator's VIRTUAL; the Virtuals
 * KEEPER's `launch(token)` - a different transaction, about a minute later - is
 * what makes the agent tradable and gets it listed. Between those two moments
 * the launch is in a real, durable, non-failing state that has its own question
 * ("is it live yet?") and its own remedy ("take my money back"), and neither is
 * answerable by a launch tool that has already returned. So `status` and
 * `cancel` are not conveniences; they are the surface of a state the venue's
 * own design creates.
 *
 * EVERY CONTRACT FACT IN THESE DESCRIPTIONS WAS MEASURED against the live
 * chains and the first-party Solidity on 2026-09-04 and 2026-09-05, and the
 * provenance is in `src/tools/virtuals/Virtuals.md`. The descriptions are long
 * on purpose: an agent choosing to launch needs to know that the name on chain
 * is not the name it typed, that the fee is waived if the keeper is slow, that
 * a cancel refunds the purchase and not the venue's fee, and that Vex will
 * never call `launch()` on its behalf - none of which is guessable from a
 * signature.
 */

import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VIRTUALS_LAUNCH_DISCOVERY } from "../../embeddings/virtuals/launch.js";
import { VIRTUALS_CHAIN_SLUGS } from "../chain-param.js";
import {
  LAUNCH_CORES_MAX,
  LAUNCH_DESCRIPTION_MAX,
  LAUNCH_NAME_MAX,
  LAUNCH_TICKER_MAX,
  VIRTUALS_LAUNCH_FEE_BPS,
} from "@tools/virtuals/launch/index.js";
import { ANTI_SNIPER_TYPE_VALUES, DEFAULT_ANTI_SNIPER_TYPE } from "@tools/virtuals/anti-sniper-types.js";

/**
 * The shared shape of a launch call, so preview and execute cannot drift apart.
 *
 * They take the SAME fields deliberately: the execute rebuilds the calldata
 * from scratch and refuses when its fingerprint differs from the one the
 * preview sealed, so a field that existed on only one of them would be a field
 * that always breaks the binding.
 */
function launchFieldParams(): ProtocolParamDef[] {
  return [
    {
      key: "chain",
      type: "string",
      required: true,
      enum: VIRTUALS_CHAIN_SLUGS,
      description:
        "REQUIRED. Where to launch the agent. Vex signs Virtuals launches on base and robinhood only. solana and "
        + "ethereum answer with the measured reason they are closed: a Solana agent's curve is a Meteora pool the "
        + `Virtuals BACKEND creates, and Virtuals runs no launch contract on Ethereum. ${CANONICAL_CHAIN_SENTENCE}`,
    },
    {
      key: "name",
      type: "string",
      required: true,
      description:
        `REQUIRED. The agent's display name, at most ${LAUNCH_NAME_MAX} characters. THE TOKEN ON CHAIN IS NOT `
        + 'ALWAYS NAMED THIS: BondingV5 appends " by Virtuals" unless you pass nameSuffix: "none", so the ERC-20 the '
        + "wallet ends up holding may carry a longer name than the string you pass. The preview shows the exact "
        + "on-chain name as `agent.onChainName`; read it before approving.",
    },
    {
      key: "symbol",
      type: "string",
      required: true,
      description:
        `REQUIRED. The token symbol - the venue's own \`ticker_\` argument - letters and digits only, at most `
        + `${LAUNCH_TICKER_MAX} characters. It is uppercased before it is encoded, and the uppercased form is what `
        + "the approval shows and what goes on chain.",
    },
    {
      key: "description",
      type: "string",
      required: true,
      description:
        `REQUIRED. What the agent is, at most ${LAUNCH_DESCRIPTION_MAX} characters. It is written into contract `
        + "storage permanently, so length is real gas on both chains and it cannot be edited afterwards.",
    },
    {
      key: "cores",
      type: "string",
      acceptsStringArray: true,
      required: true,
      description:
        `REQUIRED. The venue's capability ids for this agent, as whole numbers 0-255, at most ${LAUNCH_CORES_MAX} of `
        + 'them. Send them as an array (["0", "1", "2"]) or as a comma-separated string ("0,1,2"). '
        + "BondingV5.preLaunch reverts with InvalidInput on an empty list. Vex does not carry a copy of the venue's "
        + "core taxonomy - a stale copy would mislabel agents - so read the `cores` block of any existing agent "
        + "with virtuals__agent_get to see which ids the platform uses.",
    },
    {
      key: "imageId",
      type: "string",
      description:
        "The staged picture, in the Vex app. REQUIRED on this surface. It must ALREADY be published: call "
        + "launchpads__image_publish with the imageId first (it asks for your approval, because publishing makes the "
        + "bytes fetchable by anyone), then launch. The URL written on chain is the content-addressed one that "
        + "publish returned, so the picture cannot change after you approve it. You cannot pass a URL of your own.",
    },
    {
      key: "imagePath",
      type: "string",
      description:
        "The picture, over the Vex Studio MCP surface: a path to an image file inside THIS project. REQUIRED on that "
        + "surface, where there is no image locker. Vex reads the bytes without following symlinks, publishes them "
        + "to its content-addressed host and writes that hash URL on chain. You cannot pass a URL of your own.",
    },
    {
      key: "amountIn",
      type: "string",
      required: true,
      description:
        "REQUIRED. The VIRTUAL you commit to the launch, as a plain decimal in WHOLE tokens - never wei, never a "
        + `float. Vex's ${VIRTUALS_LAUNCH_FEE_BPS} bps fee comes out of it, so this is exactly what leaves the `
        + "wallet. What is left goes to the venue and becomes the agent's INITIAL PURCHASE, which is the only amount "
        + "a cancel would refund. The venue's own launch fee is 0 for the normal immediate launches Vex signs, read "
        + "live from BondingConfig every time rather than assumed.",
    },
    {
      key: "antiSniperTaxType",
      type: "string",
      enum: ANTI_SNIPER_TYPE_VALUES.map((v) => String(v)),
      description:
        `Which anti-sniper window your agent's curve opens with. One of ${ANTI_SNIPER_TYPE_VALUES.join(", ")}; `
        + `default ${DEFAULT_ANTI_SNIPER_TYPE}, which is what the Virtuals app itself sends. 0 = none; 1 = 60 s on `
        + "buys; 2 = 98 minutes on buys; 3 = 98 minutes on sells; 4 = 98 minutes on both; 5 = 10 minutes on buys. "
        + "Inside the window the tax starts near 99 percent and decays linearly to zero, and it goes to the venue's "
        + "anti-sniper vault - not to you. It cannot be changed after launch.",
    },
    {
      key: "nameSuffix",
      type: "string",
      enum: ["by_virtuals", "none"],
      description:
        'Whether BondingV5 appends " by Virtuals" to the token name. Default "by_virtuals", which is the venue\'s own '
        + 'default and what its app sends; "none" sets the contract\'s skip-suffix flag and launches the bare name. '
        + "Either way the preview shows the resulting on-chain name.",
    },
    {
      key: "links",
      type: "object",
      description:
        "Optional social and website links minted into the agent's on-chain record, as an object with any of "
        + '`twitter`, `telegram`, `youtube` and `website`. The contract stores them as a fixed four-slot list in '
        + "that order, so an omitted one is written as an empty string. https only - http and URLs carrying "
        + "credentials are refused by name, because the strings are written to permanent public storage and "
        + "rendered as links by every explorer.",
    },
  ];
}

export const VIRTUALS_LAUNCH_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.launch.preview",
    publicName: "virtuals__agent_launch_preview",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Plan a Virtuals AGENT LAUNCH and return the whole approval preview, without signing anything. Use this when "
      + "the user wants to create, launch or deploy their own Virtuals agent and before "
      + "virtuals__agent_launch_execute, which will not run without a previewId from here. It spends nothing, opens no "
      + "key, sends no transaction, grants no allowance and takes no fee; it records an advisory preview row so the "
      + "plan you are shown can be launched, once, by virtuals__agent_launch_execute. Everything it states is read "
      + "from the CHAIN at one pinned block: BondingV5's own bondingConfig, the venue's launch fee from "
      + "BondingConfig.calculateLaunchFee, the scheduled-launch threshold, the fee recipient, your VIRTUAL balance "
      + "and your allowance to BondingV5, and the EIP-1967 implementations behind the proxies. The answer carries "
      + "the EXACT on-chain token name (which is not always the name you passed - see nameSuffix), the "
      + "content-addressed image URL, the three-way split of the amount you commit (Vex's fee, the venue's launch "
      + "fee, the initial purchase), the anti-sniper choice in words, the approval transaction and the preLaunch "
      + "transaction with its calldata fingerprint, and a previewId with an expiry. IT ALSO STATES THE TWO-STEP "
      + "LIFECYCLE, which no other launchpad here has: your preLaunch creates the agent, and the VIRTUALS KEEPER's "
      + "launch() - not Vex's - is what makes it tradable and listed. IT REFUSES rather than guessing: a scheduled "
      + "launch, ACF and a non-zero airdrop each answer `supported: false` with the measured reason, solana and "
      + "ethereum answer with why they are closed, a caller-supplied image URL or fee override is refused BY NAME, "
      + "and an unreadable fee or threshold is refused rather than treated as zero. Feed the previewId and the "
      + "IDENTICAL fields to virtuals__agent_launch_execute. It returns `previewId`, `expiresAt`, `chain`, "
      + "`chainId`, `wallet`, `contracts`, `agent` (with `onChainName`), `money`, `antiSniper`, `allowance`, "
      + "`balance`, `transaction` (with `calldataFingerprint`), `lifecycle` and `vexFee`.",
    mutating: true,
    actionKind: "local_write",
    params: launchFieldParams(),
    exampleParams: {
      chain: "base",
      name: "Otaku Analyst",
      symbol: "OTAKU",
      description: "An agent that reads anime market sentiment.",
      cores: ["0", "1", "2"],
      imageId: "<imageId from launchpads__images_list, already published>",
      amountIn: "1",
    },
    discovery: VIRTUALS_LAUNCH_DISCOVERY["virtuals.launch.preview"],
  },
  {
    toolId: "virtuals.launch.execute",
    publicName: "virtuals__agent_launch_execute",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "LAUNCH a Virtuals agent for real, against a preview you already took. REAL FUNDS, and IRREVERSIBLE once "
      + "broadcast: the agent token, its name, its ticker, its description, its picture URL and its anti-sniper "
      + "window are written to contract storage and can never be edited. It requires the previewId from "
      + "virtuals__agent_launch_preview plus the IDENTICAL fields; before anything is signed it re-reads the chain, "
      + "rebuilds the exact preLaunch calldata and REFUSES if its fingerprint differs from the one the preview "
      + "sealed - a changed field, picture or amount is refused by name rather than re-priced, and the preview is "
      + "not consumed. It also refuses if a proxy was upgraded, if the venue's suite no longer matches Vex's pins, "
      + "if the wallet cannot pay, or if BondingConfig now treats this launch as scheduled. It sends up to two "
      + "transactions: an EXACT-amount approval to BondingV5 when the allowance is short (BondingV5, not the curve "
      + "router - preLaunch pulls the purchase itself; never unlimited), and the preLaunch. THEN IT WATCHES, and "
      + "this is the part that matters: a Virtuals launch needs a SECOND transaction, the keeper's launch(token), "
      + "and Vex NEVER sends it - doing so pre-empts the keeper and the platform then never indexes the agent "
      + "(measured, 2026-09-04). If Vex sees the keeper's Launched event within its bounded wait it returns "
      + `status "launched", records the agent, signs the AgentScan creator proof, and takes its `
      + `${VIRTUALS_LAUNCH_FEE_BPS} bps fee as a separate VIRTUAL transfer. If the keeper has not acted by then it `
      + 'returns status "awaiting_keeper", which is NOT a failure - the agent exists, your VIRTUAL is held by '
      + "BondingV5, the launch reconciles automatically - AND VEX'S FEE IS WAIVED PERMANENTLY: it is never "
      + "collected later and no background job will charge you. NOTHING IS EVER RETRIED: a preLaunch whose outcome "
      + "is unknown stays pending and is reconciled, never re-sent, because a second preLaunch would create a "
      + "second agent. Pass simulateOnly: true (with no previewId) to get the exact transactions eth_call'd from "
      + "your wallet with `launched: false` - no signer opened, no preview claimed, nothing broadcast. Check on a "
      + "launch afterwards with virtuals__agent_launch_status; take the initial purchase back, while the keeper has "
      + "not acted, with virtuals__agent_launch_cancel.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      ...launchFieldParams(),
      {
        key: "previewId",
        type: "string",
        // CONDITIONALLY required, which the manifest flag cannot express: a real
        // launch needs it, and `simulateOnly: true` must NOT, because the
        // simulation exists precisely so a caller can inspect the plan without
        // retiring a preview. The handler owns the conditional rule and refuses
        // a real launch without it, by name.
        required: false,
        description:
          "REQUIRED for a real launch, and omitted for simulateOnly: pass the previewId "
          + "virtuals__agent_launch_preview returned. It is single-use: the launch it authorizes retires it, so a "
          + "second launch cannot run against one plan a person approved. It lapses a few minutes after the preview, "
          + "because a plan priced against a chain that has moved is not the plan you read.",
      },
      {
        key: "simulateOnly",
        type: "boolean",
        description:
          "When true, stop at the edge of signing: re-read the chain, rebuild the exact transactions and eth_call "
          + "each of them from your wallet address, then return them with `launched: false`. No signing key is "
          + "opened, NO PREVIEW IS CLAIMED, no activity row is written and nothing is broadcast. Omit previewId when "
          + "you use it. The preLaunch leg reverts in the simulation whenever the allowance leg above it has not run "
          + "yet, by construction, and that is reported rather than hidden.",
      },
    ],
    exampleParams: {
      chain: "base",
      name: "Otaku Analyst",
      symbol: "OTAKU",
      description: "An agent that reads anime market sentiment.",
      cores: ["0", "1", "2"],
      imageId: "<published imageId>",
      amountIn: "1",
      previewId: "<previewId from virtuals__agent_launch_preview>",
    },
    discovery: VIRTUALS_LAUNCH_DISCOVERY["virtuals.launch.execute"],
  },
  {
    toolId: "virtuals.launch.status",
    publicName: "virtuals__agent_launch_status",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Check where one Virtuals agent launch actually stands. Use this when the user asks whether their agent "
      + "launched, whether it is live, why it is not listed on the Virtuals site, or what happened to a launch that "
      + "is still waiting - and after virtuals__agent_launch_execute answered awaiting_keeper. Read-only: it signs "
      + "nothing, calls no contract "
      + "function and never triggers the keeper. It answers the question the venue's two-transaction shape creates - "
      + '"my pre-launch confirmed, so is my agent live?" - by scanning BondingV5 for this token\'s Launched or '
      + "CancelledLaunch event, and it reports THREE distinguishable states with different remedies: awaiting_keeper "
      + "(the pre-launch is on chain, the keeper has not run launch(), the launch is still cancellable), launched "
      + "(the keeper ran it, the curve is live, the anti-sniper window has started, a cancel would now revert), and "
      + "cancelled (the initial purchase was returned). It SEPARATELY reports whether api.virtuals.io lists the "
      + "agent yet, labelled as a different question and never used to contradict the chain: an agent can be "
      + "launched on chain and never indexed, which is exactly what happens when launch() is called by someone other "
      + "than the keeper. Pass intentId (the id virtuals__agent_launch_execute returned) for the full record, or "
      + "token with its chain for a chain-and-index read of any agent. IT CHANGES NOTHING, including Vex's own "
      + "records: a launch the keeper has just executed can read as launched while `recordedStatus` still says "
      + "awaiting_keeper, and the reply says so - the chain is the authority and the background reconciliation "
      + "catches the record up. An unreadable chain answers UNKNOWN, never \"not launched\". "
      + "It returns `launched`, `recordedStatus`, `chain`, `chainId`, `token`, `txHash`, `keeper` (with "
      + "`launchTxHash` and the initial purchase when observed), `indexing`, `cancellable` and, on a cancelled "
      + "launch, `refund`.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "intentId",
        type: "string",
        description:
          "The launch to check, as returned by virtuals__agent_launch_execute. Gives the fullest answer: Vex's own "
          + "record plus a fresh chain observation, and the scan is narrowed to the block the pre-launch landed in. "
          + "Pass this OR token.",
      },
      {
        key: "token",
        type: "string",
        description:
          "The agent's ERC-20 contract address, for a launch Vex has no record of. Requires chain. The scan is then "
          + "bounded by what the node will serve, so a very old launch may answer UNKNOWN rather than a state.",
      },
      {
        key: "chain",
        type: "string",
        enum: VIRTUALS_CHAIN_SLUGS,
        description: `Required together with token - Vex must know which BondingV5 to read. ${CANONICAL_CHAIN_SENTENCE}`,
      },
    ],
    exampleParams: { intentId: "<intentId from virtuals__agent_launch_execute>" },
    discovery: VIRTUALS_LAUNCH_DISCOVERY["virtuals.launch.status"],
  },
  {
    toolId: "virtuals.launch.cancel",
    publicName: "virtuals__agent_launch_cancel",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Cancel a Virtuals agent launch the keeper has not run yet, and take the initial purchase back. Use this when "
      + "the user changed their mind about an agent they pre-launched, or when virtuals__agent_launch_status says a "
      + "launch is still awaiting_keeper and they want their VIRTUAL back. REAL FUNDS and IRREVERSIBLE: it signs and "
      + "broadcasts BondingV5.cancelLaunch from your wallet, and a cancelled launch cannot be resumed - the agent "
      + "token stays on chain, permanently untradable. WHAT IT REFUNDS, EXACTLY: the INITIAL PURCHASE and "
      + "nothing else. Any protocol launch fee the venue charged when the agent was pre-launched went to its fee "
      + "recipient inside that transaction and is NOT refunded - for the normal immediate launches Vex signs that "
      + "fee is 0, measured live on both chains, so today the refund is the whole amount the venue holds, and the "
      + "reply states the number rather than the reassurance. Gas is yours either way. Vex charges nothing for a "
      + "cancel, and it never charged a launch fee for an agent the keeper had not launched. IT REFUSES rather than "
      + "wasting a transaction: BondingV5 only accepts the token's CREATOR, and it reverts with InvalidTokenStatus "
      + "once the launch has executed - so a live agent cannot be cancelled and answers with the sell tools to use "
      + "instead. Both facts are read from the contract, and the exact call is eth_call'd from your wallet, before "
      + "any key is opened. Pass intentId (the id virtuals__agent_launch_execute returned) or token with its chain. "
      + "Pass simulateOnly: true for the same checks and the exact transaction with `cancelled: false` and nothing "
      + "signed. It is never retried: a cancel whose outcome is unknown stays pending and is reconciled.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      {
        key: "intentId",
        type: "string",
        description:
          "The launch to cancel, as returned by virtuals__agent_launch_execute. Vex resolves the token from its own "
          + "record, but the CONTRACT still decides who may cancel and what is refunded. Pass this OR token.",
      },
      {
        key: "token",
        type: "string",
        description:
          "The agent's ERC-20 contract address, for a launch Vex has no record of. Requires chain. The creator "
          + "check is the contract's, so a token this wallet did not create is refused by name.",
      },
      {
        key: "chain",
        type: "string",
        enum: VIRTUALS_CHAIN_SLUGS,
        description: `Required together with token - Vex must know which BondingV5 to call. ${CANONICAL_CHAIN_SENTENCE}`,
      },
      {
        key: "simulateOnly",
        type: "boolean",
        description:
          "When true, run every check and eth_call the exact cancelLaunch transaction from your wallet address, "
          + "then return it with `cancelled: false`. No signing key is opened, no activity row is written and "
          + "nothing is broadcast.",
      },
    ],
    exampleParams: { intentId: "<intentId from virtuals__agent_launch_execute>" },
    discovery: VIRTUALS_LAUNCH_DISCOVERY["virtuals.launch.cancel"],
  },
];
