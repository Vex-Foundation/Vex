import type { ProtocolNamespace } from "../types.js";

export type ProtocolNavigationGroupId =
  | "cross-chain"
  | "evm-trading"
  | "solana"
  | "market-research";

export interface ProtocolNavigationFacet {
  label: string;
  summary: string;
  toolPrefixes: readonly string[];
  hints: readonly string[];
}

export interface ProtocolNamespaceDeclaration {
  readonly identity: string;
  readonly read: string;
  readonly quote: string;
  readonly act: string;
  readonly whenItApplies: string;
  readonly characteristicAndLimits: string;
  readonly retrievalTerms: readonly string[];
  readonly facets: readonly string[];
  /** Used only when no runtime-owned chain projection exists. */
  readonly coverageNote?: string;
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
  readonly declaration: ProtocolNamespaceDeclaration;
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
  "market-research",
] as const;
