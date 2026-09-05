import type { Address } from "viem";

import type { InclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import type { InternalToolContext } from "../types.js";
import type { ToolResult } from "../../types.js";
import type {
  ProtocolExecuteRequest,
  ProtocolExecutionContext,
} from "../../protocols/types.js";

export type ResolutionStatus =
  | "unique_match"
  | "ambiguous"
  | "empty"
  | "metadata_unreadable"
  | "target_chain_required"
  | "unsupported_chain"
  | "provider_unavailable";

export type CoverageStatus =
  | "complete"
  | "provider_capped"
  | "chain_scope_required"
  | "unknown";

export interface ContractIdentity {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface ProviderCandidate {
  readonly address: string;
  readonly chainId: number;
  readonly provider: "khalani" | "dexscreener" | "exact_address";
  readonly providerName: string | null;
  readonly providerSymbol: string | null;
  readonly providerDecimals: number | null;
  readonly pairEvidence: readonly Record<string, unknown>[];
}

export type ResolveTokenFindChain = (
  input: string,
) => Promise<InclusiveEvmChain>;

export type ExecuteKhalaniSearch = (
  request: ProtocolExecuteRequest,
  context: ProtocolExecutionContext,
) => Promise<ToolResult>;

export type ExecuteDexScreenerSearch = (
  query: string,
  chainSlug: string,
  context: InternalToolContext,
) => Promise<ToolResult>;

export type ReadContractIdentity = (
  chain: InclusiveEvmChain,
  address: Address,
  signal?: AbortSignal,
) => Promise<ContractIdentity>;

export interface TokenFindDependencies {
  readonly resolveChain?: ResolveTokenFindChain;
  readonly listKhalaniEvmChainIds?: () => Promise<readonly number[]>;
  readonly executeKhalaniSearch?: ExecuteKhalaniSearch;
  readonly executeDexScreenerSearch?: ExecuteDexScreenerSearch;
  readonly readContractIdentity?: ReadContractIdentity;
}
