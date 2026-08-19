import type { ProtocolNamespaceNavigation } from "../types.js";

export const RELAY_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "relay",
  advertised: true,
  groupId: "cross-chain",
  groupLabel: "Cross-chain",
  summary: "Keyless cross-chain bridge (Relay) — the ONLY bridge to/from Robinhood Chain (4663); also bridges across its wider chain registry.",
  whenToUse:
    "Use to bridge funds to or from Robinhood Chain (Khalani does not cover 4663): bridge ETH/USDG/VIRTUAL in to fund trading, or bridge back out.",
  preferInstead:
    "Use `khalani` for bridges between its supported chains; use `relay` whenever either side is Robinhood Chain (or Khalani lacks the route).",
  exampleQueries: [
    'discover_tools(query="bridge to robinhood", namespace="relay")',
    'discover_tools(query="bridge quote relay", namespace="relay")',
    'discover_tools(query="bridge out of robinhood", namespace="relay")',
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
