import { getAddress, type Address } from "viem";

import { VexError } from "../../../../errors.js";
import { readErc20Decimals, readErc20Symbol } from "@tools/evm-chains/erc20-reads.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import {
  resolveInclusiveEvmChain,
  type InclusiveEvmChain,
} from "@tools/evm-chains/resolver.js";
import { createDynamicPublicClient } from "@tools/khalani/evm-client.js";
import { getCachedKhalaniChains } from "@tools/khalani/chains.js";
import { throwIfAborted } from "@utils/cancellation.js";
import { mapWithConcurrency } from "@utils/concurrency.js";

import { TOKEN_FIND_KHALANI_TOOL_ID } from "../../registry/khalani.js";
import { executeProtocolTool } from "../../protocols/runtime.js";
import { readStringOrArrayParam } from "../../protocols/runtime/list-params.js";
import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { tokenFindProtocolContext } from "./context.js";
import {
  providerOnlyTokenFindCandidate,
  tokenFindOutcome,
  tokenFindResolutionStatus,
  verifyTokenFindCandidate,
} from "./projection.js";
import {
  executeDexScreenerTokenFindSearch,
  parseDexScreenerTokenFindCandidates,
  parseKhalaniTokenFindCandidates,
} from "./providers.js";
import type {
  ContractIdentity,
  CoverageStatus,
  ProviderCandidate,
  ReadContractIdentity,
  ResolveTokenFindChain,
  TokenFindDependencies,
} from "./types.js";

const EXACT_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_FIND_CONTRACT_READ_CONCURRENCY = 4;
const TOKEN_FIND_MAX_KHALANI_CANDIDATES = 30;

function readRequestedChains(
  params: Record<string, unknown>,
): { readonly ok: true; readonly chains: readonly string[] }
  | { readonly ok: false; readonly result: ToolResult } {
  const read = readStringOrArrayParam(params, "chainIds");
  if (!read.ok) {
    return {
      ok: false,
      result: tokenFindOutcome({
        query: typeof params.query === "string" ? params.query : "",
        requestedChains: [],
        status: "unsupported_chain",
        coverage: "unknown",
        success: false,
        providerMessage: read.reason,
      }),
    };
  }
  if (read.value === null || read.value.trim() === "") {
    return { ok: true, chains: [] };
  }
  const seen = new Set<string>();
  const chains: string[] = [];
  for (const part of read.value.split(",")) {
    const chain = part.trim();
    const key = chain.toLowerCase();
    if (chain === "" || seen.has(key)) continue;
    seen.add(key);
    chains.push(chain);
  }
  return { ok: true, chains };
}

async function resolveChains(
  requested: readonly string[],
  resolveChain: ResolveTokenFindChain,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly chains: readonly InclusiveEvmChain[] }
  | {
      readonly ok: false;
      readonly status: "unsupported_chain" | "provider_unavailable";
      readonly message: string;
    }
> {
  const chains: InclusiveEvmChain[] = [];
  const seen = new Set<number>();
  for (const raw of requested) {
    throwIfAborted(signal);
    try {
      const chain = await resolveChain(raw);
      throwIfAborted(signal);
      if (chain.family !== "eip155") {
        return {
          ok: false,
          status: "unsupported_chain",
          message:
            `TokenFind resolves EVM chains only. "${raw}" is ${chain.family}; use the Solana token resolver for Solana.`,
        };
      }
      if (!seen.has(chain.chainId)) {
        seen.add(chain.chainId);
        chains.push(chain);
      }
    } catch (error) {
      throwIfAborted(signal);
      return {
        ok: false,
        status: error instanceof VexError && error.retryable
          ? "provider_unavailable"
          : "unsupported_chain",
        message: error instanceof VexError
          ? error.message
          : `The chain "${raw}" could not be resolved.`,
      };
    }
  }
  return { ok: true, chains };
}

export async function readTokenFindContractIdentity(
  chain: InclusiveEvmChain,
  address: Address,
  signal?: AbortSignal,
): Promise<ContractIdentity> {
  const client = chain.source === "local"
    ? getLocalPublicClient(chain.config)
    : createDynamicPublicClient(chain.khalaniChain, chain.khalaniChains);
  const [symbol, decimals] = await Promise.all([
    readErc20Symbol(client, address, { signal }),
    readErc20Decimals(client, address, { signal }),
  ]);
  throwIfAborted(signal);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(
      `Contract decimals must be a whole number from 0 through 36; received ${String(decimals)}.`,
    );
  }
  if (symbol.length === 0) throw new TypeError("Contract symbol() returned an empty string.");
  return { address, symbol, decimals };
}

async function verifyCandidates(
  candidates: readonly ProviderCandidate[],
  chains: readonly InclusiveEvmChain[],
  readIdentity: ReadContractIdentity,
  signal: AbortSignal | undefined,
): Promise<readonly Record<string, unknown>[]> {
  const byId = new Map(chains.map((chain) => [chain.chainId, chain]));
  const verified: Array<Record<string, unknown> | undefined> = Array.from({
    length: candidates.length,
  });
  await mapWithConcurrency(
    candidates,
    TOKEN_FIND_CONTRACT_READ_CONCURRENCY,
    async (candidate, index) => {
      const chain = byId.get(candidate.chainId);
      if (!chain) return;
      verified[index] = await verifyTokenFindCandidate(
        candidate,
        chain,
        readIdentity,
        signal,
      );
    },
  );
  return verified.filter(
    (candidate): candidate is Record<string, unknown> => candidate !== undefined,
  );
}

async function listKhalaniEvmChainIds(): Promise<readonly number[]> {
  return (await getCachedKhalaniChains())
    .filter((chain) => chain.type === "eip155")
    .map((chain) => chain.id);
}

export async function handleTokenFind(
  params: Record<string, unknown>,
  context: InternalToolContext,
  dependencies: TokenFindDependencies = {},
): Promise<ToolResult> {
  const queryValue = params.query;
  if (typeof queryValue !== "string" || queryValue.trim() === "") {
    return tokenFindOutcome({
      query: "",
      requestedChains: [],
      status: "empty",
      coverage: "unknown",
      success: false,
      providerMessage: queryValue === undefined
        ? "Missing required parameter: query."
        : "query must be a non-empty string.",
    });
  }
  const query = queryValue.trim();
  const chainRead = readRequestedChains(params);
  if (!chainRead.ok) return chainRead.result;
  const requestedChains = chainRead.chains;
  const exactAddress = EXACT_EVM_ADDRESS.test(query);
  if (query.toLowerCase().startsWith("0x") && !exactAddress) {
    return tokenFindOutcome({
      query,
      requestedChains,
      status: "empty",
      coverage: "unknown",
      success: false,
      providerMessage:
        "An EVM contract address must be 0x followed by exactly 40 hexadecimal characters.",
    });
  }
  if (exactAddress && requestedChains.length === 0) {
    return tokenFindOutcome({
      query,
      requestedChains,
      status: "target_chain_required",
      coverage: "chain_scope_required",
      success: false,
      providerMessage:
        "An EVM address can exist on many chains. Supply exactly one target chain in chainIds so TokenFind can read that contract.",
    });
  }

  const resolved = await resolveChains(
    requestedChains,
    dependencies.resolveChain ?? resolveInclusiveEvmChain,
    context.abortSignal,
  );
  if (!resolved.ok) {
    return tokenFindOutcome({
      query,
      requestedChains,
      status: resolved.status,
      coverage: "unknown",
      success: false,
      providerMessage: resolved.message,
    });
  }
  const chains = resolved.chains;
  const readIdentity = dependencies.readContractIdentity ?? readTokenFindContractIdentity;

  if (exactAddress) {
    const address = getAddress(query.toLowerCase());
    const providerCandidates: ProviderCandidate[] = chains.map((chain) => ({
      address,
      chainId: chain.chainId,
      provider: "exact_address",
      providerName: null,
      providerSymbol: null,
      providerDecimals: null,
      pairEvidence: [],
    }));
    const candidates = await verifyCandidates(
      providerCandidates,
      chains,
      readIdentity,
      context.abortSignal,
    );
    const status = tokenFindResolutionStatus(candidates);
    return tokenFindOutcome({
      query,
      requestedChains,
      status,
      coverage: "complete",
      candidates,
      success: status === "unique_match" || status === "ambiguous",
      providerAccounting: {
        searchRequestsIssued: 0,
        reason: "Exact contract identity bypasses provider search and ranking.",
      },
    });
  }

  const executeKhalaniSearch = dependencies.executeKhalaniSearch ?? executeProtocolTool;
  const executeDexSearch = dependencies.executeDexScreenerSearch
    ?? executeDexScreenerTokenFindSearch;
  const khalaniChains = chains.filter((chain) => chain.source === "khalani");
  const localChains = chains.filter((chain) => chain.source === "local");
  const providerCandidates: ProviderCandidate[] = [];
  let khalaniRowsOutsideRequestedChains = 0;
  let khalaniMalformedRows = 0;
  let khalaniDuplicateRows = 0;
  let khalaniRowsOmittedByClientCap = 0;
  let dexProviderReturned = 0;
  let dexRowsWithoutAttributableToken = 0;
  let dexMalformedRows = 0;
  let providerCapped = false;
  let searchRequestsIssued = 0;

  if (requestedChains.length === 0 || khalaniChains.length > 0) {
    throwIfAborted(context.abortSignal);
    const khalaniSearchChainIds = requestedChains.length === 0
      ? await (dependencies.listKhalaniEvmChainIds ?? listKhalaniEvmChainIds)()
      : khalaniChains.map((chain) => chain.chainId);
    throwIfAborted(context.abortSignal);
    const khalaniResult = await executeKhalaniSearch(
      {
        toolId: TOKEN_FIND_KHALANI_TOOL_ID,
        params: {
          query,
          chainIds: khalaniSearchChainIds.map(String),
        },
      },
      tokenFindProtocolContext(context),
    );
    throwIfAborted(context.abortSignal);
    searchRequestsIssued += 1;
    if (!khalaniResult.success) {
      return tokenFindOutcome({
        query,
        requestedChains,
        status: "provider_unavailable",
        coverage: "unknown",
        success: false,
        providerMessage: khalaniResult.output,
      });
    }
    const parsed = parseKhalaniTokenFindCandidates(
      khalaniResult,
      requestedChains.length === 0
        ? new Set(khalaniSearchChainIds)
        : new Set(khalaniChains.map((chain) => chain.chainId)),
    );
    const accepted = parsed.candidates.slice(
      0,
      TOKEN_FIND_MAX_KHALANI_CANDIDATES,
    );
    providerCandidates.push(...accepted);
    khalaniRowsOmittedByClientCap += parsed.candidates.length - accepted.length;
    providerCapped ||= parsed.candidates.length > accepted.length;
    khalaniRowsOutsideRequestedChains += parsed.rowsOutsideRequestedChains;
    khalaniMalformedRows += parsed.malformedRows;
    khalaniDuplicateRows += parsed.duplicateRows;
  }

  for (const chain of localChains) {
    throwIfAborted(context.abortSignal);
    const dexResult = await executeDexSearch(query, chain.config.dexscreenerSlug, context);
    throwIfAborted(context.abortSignal);
    searchRequestsIssued += 1;
    if (!dexResult.success) {
      return tokenFindOutcome({
        query,
        requestedChains,
        status: "provider_unavailable",
        coverage: "unknown",
        success: false,
        providerMessage: dexResult.output,
      });
    }
    const parsed = parseDexScreenerTokenFindCandidates(dexResult, chain.chainId, query);
    providerCandidates.push(...parsed.candidates);
    dexProviderReturned += parsed.providerReturned;
    dexRowsWithoutAttributableToken += parsed.rowsWithoutAttributableToken;
    dexMalformedRows += parsed.malformedRows;
    providerCapped ||= parsed.providerCapped;
  }

  const candidates = requestedChains.length === 0
    ? providerCandidates.map(providerOnlyTokenFindCandidate)
    : await verifyCandidates(providerCandidates, chains, readIdentity, context.abortSignal);
  const status = requestedChains.length === 0 && candidates.length > 0
    ? "target_chain_required"
    : tokenFindResolutionStatus(candidates);
  const providerShapeIncomplete = khalaniMalformedRows > 0 || dexMalformedRows > 0;
  if (providerCandidates.length === 0 && providerShapeIncomplete) {
    return tokenFindOutcome({
      query,
      requestedChains,
      status: "provider_unavailable",
      coverage: "unknown",
      success: false,
      providerMessage:
        "The identity provider answered, but its projected rows did not match the validated TokenFind contract.",
      providerAccounting: {
        searchRequestsIssued,
        khalaniMalformedRows,
        dexMalformedRows,
      },
    });
  }
  const coverage: CoverageStatus = providerShapeIncomplete
    ? "unknown"
    : providerCapped
      ? "provider_capped"
      : requestedChains.length === 0
        ? "chain_scope_required"
        : "complete";
  return tokenFindOutcome({
    query,
    requestedChains,
    status,
    coverage,
    candidates,
    success: requestedChains.length === 0
      || status === "unique_match"
      || status === "ambiguous"
      || status === "empty",
    providerAccounting: {
      searchRequestsIssued,
      khalaniRowsOutsideRequestedChains,
      khalaniMalformedRows,
      khalaniDuplicateRows,
      khalaniRowsOmittedByClientCap,
      khalaniCandidateLimit: TOKEN_FIND_MAX_KHALANI_CANDIDATES,
      dexProviderReturned,
      dexRowsWithoutAttributableToken,
      dexMalformedRows,
      providerCandidateCount: providerCandidates.length,
      note:
        "No liquidity, price, quote-tier, or risk threshold filters token identity. DexScreener rows are used only to enumerate address candidates inside the provider's fixed window.",
    },
  });
}
