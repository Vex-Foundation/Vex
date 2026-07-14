import type { ProtocolNamespace } from "../types.js";

export type ProtocolNavigationGroupId =
  | "cross-chain"
  | "evm-trading"
  | "solana"
  | "perps"
  | "prediction-markets"
  | "market-research";

export interface ProtocolNavigationFacet {
  label: string;
  summary: string;
  toolPrefixes: readonly string[];
  hints: readonly string[];
}

export interface ProtocolNamespaceNavigation {
  namespace: ProtocolNamespace;
  advertised: boolean;
  groupId: ProtocolNavigationGroupId;
  groupLabel: string;
  summary: string;
  whenToUse: string;
  preferInstead?: string;
  exampleQueries: readonly string[];
  aliases: readonly string[];
  discoveryHints: readonly string[];
  facets: readonly ProtocolNavigationFacet[];
}

export interface ProtocolNavigationGroup {
  groupId: ProtocolNavigationGroupId;
  groupLabel: string;
  namespaces: readonly ProtocolNamespaceNavigation[];
}

export const PROTOCOL_NAVIGATION_GROUP_ORDER: readonly ProtocolNavigationGroupId[] = [
  "cross-chain",
  "evm-trading",
  "solana",
  "perps",
  "prediction-markets",
  "market-research",
] as const;
