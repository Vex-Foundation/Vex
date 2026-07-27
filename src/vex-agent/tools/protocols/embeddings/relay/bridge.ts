/**
 * Retrieval metadata for Relay bridge tools.
 * Vectors are (re)built by the boot reconcile / `tool-reembed`; passages here.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";

export const RELAY_BRIDGE_DISCOVERY = {
  "relay.quote.get": {
    embeddingText: embeddingText(
      `Preview a cross-chain bridge via Relay — routes, fees, and ETA — before executing. ` +
      `Use this when the user wants the cost or ETA to bridge to or from Robinhood Chain (Relay is the ONLY bridge there — Khalani does not cover it): bridge ETH, USDG, or VIRTUAL in or out, then swap on-chain. ` +
      `Example queries: preview bridge base eth to robinhood, relay quote to robinhood chain, bridge cost into robinhood, quote bridge out of robinhood. Read-only.`,
    ),
    aliases: ["relay quote", "bridge quote to robinhood", "cross-chain quote relay"],
    exampleIntents: ["quote bridge to robinhood", "relay bridge preview", "cost to bridge into robinhood"],
  },

  "relay.bridge": {
    embeddingText: embeddingText(
      `Bridge funds across chains via Relay for real (signs + broadcasts on the source chain). ` +
      `Use this when the user wants to move funds to or from Robinhood Chain (Relay is the ONLY bridge there — Khalani does not cover it): bridge ETH, USDG, or VIRTUAL into Robinhood Chain to fund trading, or bridge back out, then swap on-chain via Uniswap. ` +
      `Example queries: bridge base eth to robinhood, move funds into robinhood chain, bridge out of robinhood to base, fund my robinhood wallet.`,
    ),
    aliases: ["relay bridge", "bridge to robinhood", "bridge from robinhood", "fund robinhood"],
    exampleIntents: ["bridge ETH to robinhood", "bridge out of robinhood", "move funds to robinhood chain"],
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(RELAY_BRIDGE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `RELAY_BRIDGE_DISCOVERY has ${Object.keys(RELAY_BRIDGE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
