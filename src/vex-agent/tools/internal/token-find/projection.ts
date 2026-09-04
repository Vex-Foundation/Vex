import { getAddress, isAddress, type Address } from "viem";

import {
  boundIssuerField,
  ISSUER_NAME_MAX_CHARS,
  sanitizeIssuerField,
  type BoundedTextReport,
} from "@tools/dexscreener/sanitize.js";
import type { InclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { throwIfAborted } from "@utils/cancellation.js";

import type { ToolResult } from "../../types.js";
import type {
  ContractIdentity,
  CoverageStatus,
  ProviderCandidate,
  ReadContractIdentity,
  ResolutionStatus,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function tokenFindOutcome(input: {
  readonly query: string;
  readonly requestedChains: readonly string[];
  readonly status: ResolutionStatus;
  readonly coverage: CoverageStatus;
  readonly candidates?: readonly Record<string, unknown>[];
  readonly providerAccounting?: Record<string, unknown>;
  readonly providerMessage?: string;
  readonly success: boolean;
}): ToolResult {
  const candidates = input.candidates ?? [];
  const metadata = candidates.length === 1 ? candidates[0]?.metadata : null;
  const mutationReady = input.requestedChains.length === 1
    && input.status === "unique_match"
    && input.coverage === "complete"
    && isRecord(metadata)
    && metadata.status === "verified";
  const metadataCounts = candidates.reduce<Record<string, number>>(
    (counts, candidate) => {
      const rowMetadata = candidate.metadata;
      const status = isRecord(rowMetadata) && typeof rowMetadata.status === "string"
        ? rowMetadata.status
        : "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    },
    {},
  );

  const data = {
    query: input.query,
    requestedChains: input.requestedChains,
    resolution: {
      status: input.status,
      candidateCount: candidates.length,
      ambiguous: input.status === "ambiguous",
    },
    coverage: {
      status: input.coverage,
      ...(input.coverage === "provider_capped"
        ? {
            remedy:
              "The search filled a fixed non-pageable window, either the provider window or Vex's 30-candidate Khalani safety limit. Narrow to an exact contract address; repeating the same query cannot fetch the omitted matches.",
          }
        : {}),
    },
    metadataCounts,
    mutationReady,
    mutationRule:
      "A mutation needs exactly one target chain, one contract-verified candidate, complete search coverage, and an approval card showing chain, address, contract symbol, contract decimals, human amount, and atomic amount.",
    preferredSwapIdentity:
      "When a swap pair is already known, use that pair's exact base or quote token address as the TokenFind query. Pair-route identity is stronger than provider ranking by name.",
    candidates,
    ...(input.providerAccounting === undefined
      ? {}
      : { providerAccounting: input.providerAccounting }),
    ...(input.providerMessage === undefined
      ? {}
      : { providerMessage: input.providerMessage }),
  };
  return { success: input.success, output: JSON.stringify(data, null, 2), data };
}

function cleanLabel(
  raw: string | null,
  field: string,
  sanitized: Set<string>,
  bounded: BoundedTextReport[],
): string | null {
  return boundIssuerField(
    sanitizeIssuerField(raw, field, sanitized),
    field,
    ISSUER_NAME_MAX_CHARS,
    bounded,
  );
}

function cleanProviderLabels(candidate: ProviderCandidate): {
  readonly symbol: string | null;
  readonly name: string | null;
  readonly sanitized: ReadonlySet<string>;
  readonly bounded: readonly BoundedTextReport[];
} {
  const sanitized = new Set<string>();
  const bounded: BoundedTextReport[] = [];
  return {
    symbol: cleanLabel(
      candidate.providerSymbol,
      "providerMetadata.symbol",
      sanitized,
      bounded,
    ),
    name: cleanLabel(
      candidate.providerName,
      "providerMetadata.name",
      sanitized,
      bounded,
    ),
    sanitized,
    bounded,
  };
}

function unreadableCandidate(
  candidate: ProviderCandidate,
  address: string,
  reason: string,
): Record<string, unknown> {
  const labels = cleanProviderLabels(candidate);
  return {
    address,
    chainId: candidate.chainId,
    symbol: null,
    decimals: null,
    name: labels.name,
    metadata: { status: "unreadable", reason },
    provenance: {
      identity: candidate.provider,
      symbolAndDecimals: "contract_read_failed",
    },
    providerMetadata: {
      symbol: labels.symbol,
      decimals: candidate.providerDecimals,
      name: labels.name,
    },
    pairEvidence: candidate.pairEvidence,
    ...(labels.sanitized.size === 0
      ? {}
      : { sanitizedFields: [...labels.sanitized].sort() }),
    ...(labels.bounded.length === 0 ? {} : { boundedText: labels.bounded }),
  };
}

export async function verifyTokenFindCandidate(
  candidate: ProviderCandidate,
  chain: InclusiveEvmChain,
  readIdentity: ReadContractIdentity,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  let address: Address;
  try {
    if (!isAddress(candidate.address, { strict: false })) throw new TypeError("invalid address");
    address = getAddress(candidate.address.toLowerCase());
  } catch {
    return unreadableCandidate(
      candidate,
      candidate.address,
      "The provider candidate is not a valid 20-byte EVM contract address.",
    );
  }

  try {
    throwIfAborted(signal);
    const identity: ContractIdentity = await readIdentity(chain, address, signal);
    throwIfAborted(signal);
    const labels = cleanProviderLabels(candidate);
    const symbolSanitized = new Set<string>();
    const symbolBounded: BoundedTextReport[] = [];
    const symbol = cleanLabel(identity.symbol, "symbol", symbolSanitized, symbolBounded);
    if (symbol === null || symbol.length === 0) {
      throw new TypeError("Contract symbol() was empty after sanitization.");
    }
    const sanitizedFields = new Set([...labels.sanitized, ...symbolSanitized]);
    const boundedText = [...labels.bounded, ...symbolBounded];
    return {
      address: identity.address,
      chainId: candidate.chainId,
      symbol,
      decimals: identity.decimals,
      name: labels.name,
      metadata: { status: "verified" },
      provenance: {
        identity: candidate.provider,
        symbolAndDecimals: "rpc_contract",
      },
      providerMetadata: {
        symbol: labels.symbol,
        decimals: candidate.providerDecimals,
        name: labels.name,
      },
      providerMetadataAgrees: {
        symbol: labels.symbol === null
          ? null
          : labels.symbol.toLocaleLowerCase() === symbol.toLocaleLowerCase(),
        decimals: candidate.providerDecimals === null
          ? null
          : candidate.providerDecimals === identity.decimals,
      },
      pairEvidence: candidate.pairEvidence,
      ...(sanitizedFields.size === 0
        ? {}
        : { sanitizedFields: [...sanitizedFields].sort() }),
      ...(boundedText.length === 0 ? {} : { boundedText }),
    };
  } catch {
    throwIfAborted(signal);
    return unreadableCandidate(
      candidate,
      address,
      "The token contract's symbol() and decimals() could not both be read and strictly validated. Do not use provider metadata for signing.",
    );
  }
}

export function tokenFindResolutionStatus(
  candidates: readonly Record<string, unknown>[],
): ResolutionStatus {
  if (candidates.length === 0) return "empty";
  if (candidates.length > 1) return "ambiguous";
  const metadata = candidates[0]?.metadata;
  return isRecord(metadata) && metadata.status === "verified"
    ? "unique_match"
    : "metadata_unreadable";
}

export function providerOnlyTokenFindCandidate(
  candidate: ProviderCandidate,
): Record<string, unknown> {
  const labels = cleanProviderLabels(candidate);
  return {
    address: candidate.address,
    chainId: candidate.chainId,
    symbol: null,
    decimals: null,
    name: labels.name,
    metadata: {
      status: "target_chain_required",
      reason:
        "This unscoped research row carries provider labels only. Supply one explicit target chain to read symbol and decimals from the contract.",
    },
    provenance: {
      identity: candidate.provider,
      symbolAndDecimals: "not_read_without_target_chain",
    },
    providerMetadata: {
      symbol: labels.symbol,
      decimals: candidate.providerDecimals,
      name: labels.name,
    },
    pairEvidence: candidate.pairEvidence,
    ...(labels.sanitized.size === 0
      ? {}
      : { sanitizedFields: [...labels.sanitized].sort() }),
    ...(labels.bounded.length === 0 ? {} : { boundedText: labels.bounded }),
  };
}
