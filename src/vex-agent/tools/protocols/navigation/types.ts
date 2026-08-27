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
  /**
   * Opt in to rendering `facets` as a line of the namespace's static prompt
   * card (`engine/prompts/protocol-capabilities.ts`).
   *
   * OFF BY DEFAULT AND DELIBERATELY PER-NAMESPACE. `facets` exists on all 11
   * declarations; rendering every one costs about 1580 bytes of the static
   * prefix to tell the model what a ToolSearch query would tell it anyway. The
   * flag exists so ONE namespace whose surface is broad enough that the model
   * cannot guess the shape of a useful query - dexscreener, the market-research
   * backbone - can advertise its sub-areas without any other namespace paying
   * for it. Adding a second one is a reviewed budget decision
   * (`prompt-budget-ceiling.test.ts`), not a default.
   *
   * It advertises CAPABILITY AREAS, never callable names: a tool becomes
   * callable only through ToolSearch discovery, and naming one here would teach
   * a name the dispatcher refuses (owner decision D-DS9-R).
   */
  readonly advertiseFacetsInPrompt?: true;
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
