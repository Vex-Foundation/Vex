import type { ProtocolNamespaceNavigation } from "../types.js";

export const RELAY_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "relay",
  advertised: true,
  groupId: "cross-chain",
  groupLabel: "Cross-chain",
  summary: "Relay is a keyless cross-chain bridge: it moves a token on one chain into a token on another with no bridge account and no manual claim, quoted first and then executed. It is the ONLY route Vex has to or from Robinhood Chain (4663), which Khalani does not cover, and it also bridges across Relay's wider chain registry.",
  whenToUse:
    "Use to bridge funds to or from Robinhood Chain (Khalani does not cover 4663): bridge ETH/USDG/VIRTUAL in to fund trading, or bridge back out.",
  preferInstead:
    "Use `khalani` for bridges between its supported chains; use `relay` whenever either side is Robinhood Chain (or Khalani lacks the route).",
  declaration: {
    identity: "Relay is a keyless cross-chain bridge for moving a token from one EVM chain to another without a bridge account or manual destination claim.",
    read: "Read route serviceability, steps, input and output amounts, minimum output, estimated time, fees, and the last provider state for a transfer involving Relay-supported EVM chains.",
    quote: "Request a Relay quote to Robinhood Chain, preview bridge Base ETH to Robinhood, inspect the bridge cost into Robinhood, or quote bridge out of Robinhood without signing.",
    act: "Move funds into Robinhood Chain or bridge ETH back out after a fresh matching quote, then swap on-chain when the task also requires a trade.",
    whenItApplies: "Use it for a cross-chain bridge involving Robinhood Chain, to fund my Robinhood wallet, or when a supported EVM route needs a keyless bridge execution.",
    characteristicAndLimits: "A quote is read-only and execution broadcasts an origin-chain deposit whose destination fill can remain pending. Relay is EVM-only in this integration, does not support Solana, and exposes no static complete chain list or numeric request-rate contract.",
    retrievalTerms: [
      "cross-chain bridge",
      "Relay quote to Robinhood Chain",
      "preview bridge Base ETH to Robinhood",
      "bridge cost into Robinhood",
      "quote bridge out of Robinhood",
      "bridge ETH",
      "move funds into Robinhood Chain",
      "fund my Robinhood wallet",
      "then swap on-chain",
    ],
    facets: ["Bridge quotes and execution"],
  },
  exampleQueries: [
    'ToolSearch(query="bridge to robinhood", namespace="relay")',
    'ToolSearch(query="bridge quote relay", namespace="relay")',
    'ToolSearch(query="bridge out of robinhood", namespace="relay")',
  ],
  aliases: ["relay", "bridge to robinhood", "bridge from robinhood", "fund robinhood"],
  discoveryHints: ["bridge to robinhood", "bridge from robinhood", "relay bridge quote", "fund robinhood wallet"],
  facets: [
    {
      label: "Bridge quotes and execution",
      summary: "Quote/execute keyless cross-chain bridges to and from Robinhood Chain and Relay's other chains.",
      toolPrefixes: ["relay.quote", "relay.bridge"],
      hints: ["bridge quote", "bridge to robinhood", "bridge eth", "cross-chain transfer"],
    },
  ],
};
