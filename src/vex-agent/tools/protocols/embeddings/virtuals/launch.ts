/**
 * Retrieval metadata for the Virtuals agent-launch tools.
 *
 * Source of truth for the lexical scorer and the dense-retrieval pipeline.
 * Manifest at `virtuals/manifests/launch.ts` references entries by `toolId`.
 *
 * The four passages separate PLANNING from LAUNCHING from CHECKING from
 * UNDOING, because those are four different user sentences with four different
 * consequences. A shared passage would make "what would it cost to launch an
 * agent" and "launch it" equally reachable, and only one of them spends money.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";

/** Launches are signed on the two EVM chains only - not the read matrix. */
const LAUNCH_CHAIN_LABELS = ["Base", "Robinhood Chain"];

export const VIRTUALS_LAUNCH_DISCOVERY = {
  "virtuals.launch.preview": {
    embeddingText: embeddingText(
      `Plan launching a new AI agent token on Virtuals before committing: the name that will really be on chain, the picture URL, how the VIRTUAL you commit splits between Vex's fee, the venue's fee and the agent's initial purchase, and the anti-sniper window the curve opens with. `
      + `Use this when the user wants to create or launch a Virtuals agent and wants the cost first. Nothing is signed. `
      + `Example queries: what would it cost to launch a virtuals agent, plan an agent launch on base, preview creating my own AI agent token.`,
    ),
    aliases: [
      "preview a virtuals agent launch",
      "plan launching an ai agent token",
      "cost to launch a virtuals agent",
      "virtuals launch preview",
      "what would my agent launch cost",
    ],
    exampleIntents: [
      "what would it cost to launch an agent on virtuals",
      "plan an agent launch with one VIRTUAL",
      "show me the plan before I create my agent token",
    ],
    chains: LAUNCH_CHAIN_LABELS,
  },

  "virtuals.launch.execute": {
    embeddingText: embeddingText(
      `Launch a new AI agent token on Virtuals for real, against a plan already previewed: approves the exact VIRTUAL amount to the bonding contract, sends preLaunch which creates the agent token and its curve pair, then watches for the venue keeper to make the agent tradable and listed. `
      + `Use this when the user wants to launch your own agent on Virtuals, or to create, deploy or mint an AI agent token. Real funds and irreversible; the name, ticker, picture and anti-sniper window are permanent. `
      + `Example queries: launch my agent on virtuals, create a new virtuals agent token, deploy my AI agent, mint an agent on the virtuals bonding curve.`,
    ),
    aliases: [
      "launch a virtuals agent",
      "create a virtuals agent token",
      "deploy my ai agent on virtuals",
      "launch an agent on the virtuals bonding curve",
      "mint a new virtuals agent",
    ],
    exampleIntents: [
      "launch my agent on virtuals now",
      "create the agent token I previewed",
      "deploy a new AI agent on base with one VIRTUAL",
    ],
    chains: LAUNCH_CHAIN_LABELS,
  },

  "virtuals.launch.status": {
    embeddingText: embeddingText(
      `Check whether a Virtuals agent you launched is live yet: whether the Virtuals keeper has run launch() so the bonding curve is trading and the anti-sniper window has started, whether the launch was cancelled, and separately whether the Virtuals site has indexed the agent. `
      + `Use this when the user asks if their agent launched, whether it is live, why it is not showing on virtuals.io, or what happened to a launch that is still waiting for the keeper. Read-only. `
      + `Example queries: did my agent launch, is my virtuals agent live yet, why is my agent not listed on virtuals, check the status of my agent launch.`,
    ),
    aliases: [
      "is my virtuals agent live",
      "did my agent launch go through",
      "check virtuals launch status",
      "why is my agent not listed on virtuals",
      "waiting for the virtuals keeper",
    ],
    exampleIntents: [
      "did my agent actually launch",
      "is my virtuals agent trading yet",
      "check what happened to my agent launch",
    ],
    chains: LAUNCH_CHAIN_LABELS,
  },

  "virtuals.launch.cancel": {
    embeddingText: embeddingText(
      `Cancel a Virtuals agent launch the keeper has not run yet and get the initial purchase back: signs BondingV5.cancelLaunch from the creator's wallet, which refunds the initial purchase only - the venue's own launch fee, if any was charged, is not refunded. `
      + `Use this when the user wants to cancel a launch they changed their mind about, or wants their VIRTUAL back from one still waiting for the keeper. Real funds; impossible once the agent is live, which must be sold on its curve instead. `
      + `Example queries: cancel my agent launch, undo the virtuals agent I just created, get my VIRTUAL back from a launch, refund my pre-launch.`,
    ),
    aliases: [
      "cancel a virtuals agent launch",
      "undo my agent launch",
      "get my VIRTUAL back from a launch",
      "refund a virtuals pre-launch",
      "abort the agent I just launched",
    ],
    exampleIntents: [
      "cancel the agent launch and refund me",
      "I changed my mind about that agent, take it back",
      "get my initial purchase back from the launch",
    ],
    chains: LAUNCH_CHAIN_LABELS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(VIRTUALS_LAUNCH_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `VIRTUALS_LAUNCH_DISCOVERY has ${Object.keys(VIRTUALS_LAUNCH_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
