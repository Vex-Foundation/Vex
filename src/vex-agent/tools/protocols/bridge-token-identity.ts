import {
  formatUnits,
  getAddress,
  isAddress,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { isKhalaniNativeAlias } from "@tools/khalani/native-token-identity.js";
import { getCachedKhalaniChains, getChain, resolveChainId } from "@tools/khalani/chains.js";
import { createDynamicPublicClient } from "@tools/khalani/evm-client.js";
import type { KhalaniChain } from "@tools/khalani/types.js";
import { readErc20Decimals, readErc20Symbol } from "@tools/evm-chains/erc20-reads.js";
import { getCachedRelayChains } from "@tools/relay/client.js";
import { RELAY_NATIVE_CURRENCY, resolveRelayChainId, toRelayCurrency } from "@tools/relay/chains.js";
import { resolveRelayOnlyPublicClient } from "@tools/relay/chain-client.js";
import type { RelayChain } from "@tools/relay/types.js";
import { sanitizeIssuerText } from "@tools/dexscreener/sanitize.js";
import { throwIfAborted } from "@utils/cancellation.js";
import type {
  BridgeAssetIdentity,
  BridgeTokenIdentityPreview,
  UnavailableEvmBridgeAssetIdentity,
  VerifiedEvmBridgeAssetIdentity,
} from "./bridge-token-identity-contract.js";
import { isVerifiedEvmBridgeAssetIdentity } from "./bridge-token-identity-contract.js";

export {
  BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION,
  isBridgeTokenPreviewSigningReady,
  isVerifiedEvmBridgeAssetIdentity,
  type BridgeAssetIdentity,
  type BridgeTokenIdentityPreview,
  type UnavailableEvmBridgeAssetIdentity,
  type VerifiedEvmBridgeAssetIdentity,
} from "./bridge-token-identity-contract.js";

const MAX_CONTRACT_SYMBOL_CHARS = 128;
const RELAY_SOLANA_CHAIN_ID = 792_703_809;

type TestEvmIdentityResolver = (input: {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly signal?: AbortSignal;
}) => Promise<BridgeAssetIdentity>;

export interface BridgeTokenIdentityDependencies {
  readonly khalaniChains?: Awaited<ReturnType<typeof getCachedKhalaniChains>>;
  readonly relayChains?: Awaited<ReturnType<typeof getCachedRelayChains>>;
  /** Narrow test seam. Production always uses the venue registry selected above. */
  readonly resolveEvmIdentity?: TestEvmIdentityResolver;
}

function strictDecimals(value: number, subject: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 36) {
    throw new RangeError(`${subject} decimals must be a whole number from 0 through 36.`);
  }
  return value;
}

function strictSymbol(raw: string, subject: string): {
  readonly symbol: string;
  readonly sanitized: boolean;
} {
  const sanitized = sanitizeIssuerText(raw);
  const length = Array.from(sanitized.value).length;
  if (length === 0 || length > MAX_CONTRACT_SYMBOL_CHARS) {
    throw new RangeError(`${subject} symbol must contain 1 through ${MAX_CONTRACT_SYMBOL_CHARS} visible characters.`);
  }
  return { symbol: sanitized.value, sanitized: sanitized.removed };
}

function isNativeToken(tokenAddress: string): boolean {
  return isKhalaniNativeAlias(tokenAddress) || toRelayCurrency(tokenAddress) === RELAY_NATIVE_CURRENCY;
}

async function resolveEvmIdentityFromClient(input: {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly nativeCurrency: { readonly symbol: string; readonly decimals: number };
  readonly createClient: () => PublicClient<Transport, Chain>;
  readonly signal?: AbortSignal;
}): Promise<VerifiedEvmBridgeAssetIdentity> {
  throwIfAborted(input.signal);
  if (isNativeToken(input.tokenAddress)) {
    const symbol = strictSymbol(input.nativeCurrency.symbol, `Native asset on chain ${input.chainId}`);
    return {
      family: "eip155",
      kind: "native",
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      symbol: symbol.symbol,
      decimals: strictDecimals(input.nativeCurrency.decimals, `Native asset on chain ${input.chainId}`),
      metadataSource: "chain_registry",
      symbolSanitized: symbol.sanitized,
    };
  }
  if (!isAddress(input.tokenAddress, { strict: false })) {
    throw new TypeError(`Token on chain ${input.chainId} is not a valid EVM contract address.`);
  }
  const address: Address = getAddress(input.tokenAddress.toLowerCase());
  const client = input.createClient();
  const [rawSymbol, rawDecimals] = await Promise.all([
    readErc20Symbol(client, address, { signal: input.signal }),
    readErc20Decimals(client, address, { signal: input.signal }),
  ]);
  throwIfAborted(input.signal);
  const symbol = strictSymbol(rawSymbol, `Token ${address} on chain ${input.chainId}`);
  return {
    family: "eip155",
    kind: "erc20",
    chainId: input.chainId,
    tokenAddress: address,
    symbol: symbol.symbol,
    decimals: strictDecimals(rawDecimals, `Token ${address} on chain ${input.chainId}`),
    metadataSource: "rpc_contract",
    symbolSanitized: symbol.sanitized,
  };
}

/** Khalani bridge metadata uses Khalani's own registry and RPC authority. */
export async function resolveKhalaniEvmBridgeAssetIdentity(input: {
  readonly chain: KhalaniChain;
  readonly chains: KhalaniChain[];
  readonly tokenAddress: string;
  readonly signal?: AbortSignal;
}): Promise<VerifiedEvmBridgeAssetIdentity> {
  if (input.chain.type !== "eip155") {
    throw new TypeError(`Khalani chain ${input.chain.id} is not an EVM chain.`);
  }
  return resolveEvmIdentityFromClient({
    chainId: input.chain.id,
    tokenAddress: input.tokenAddress,
    nativeCurrency: input.chain.nativeCurrency,
    createClient: () => createDynamicPublicClient(input.chain, input.chains),
    signal: input.signal,
  });
}

/** Relay bridge metadata uses Relay's registry, including chains Vex does not list locally. */
export async function resolveRelayEvmBridgeAssetIdentity(input: {
  readonly chain: RelayChain;
  readonly chains: readonly RelayChain[];
  readonly tokenAddress: string;
  readonly signal?: AbortSignal;
}): Promise<VerifiedEvmBridgeAssetIdentity> {
  if (input.chain.vmType !== "evm") {
    throw new TypeError(`Relay chain ${input.chain.id} is not an EVM chain.`);
  }
  if (isNativeToken(input.tokenAddress) && input.chain.currency === undefined) {
    throw new TypeError(`Relay chain ${input.chain.id} has no native currency metadata.`);
  }
  return resolveEvmIdentityFromClient({
    chainId: input.chain.id,
    tokenAddress: input.tokenAddress,
    nativeCurrency: {
      symbol: input.chain.currency?.symbol ?? "",
      decimals: input.chain.currency?.decimals ?? Number.NaN,
    },
    createClient: () => resolveRelayOnlyPublicClient(input.chain.id, input.chains),
    signal: input.signal,
  });
}

function unavailableIdentity(
  chainId: number,
  tokenAddress: string,
): UnavailableEvmBridgeAssetIdentity {
  const native = isNativeToken(tokenAddress);
  return {
    family: "eip155",
    kind: "metadata_unavailable",
    chainId,
    tokenAddress,
    symbol: null,
    decimals: null,
    metadataSource: native ? "chain_registry_unavailable" : "rpc_contract_unavailable",
    symbolSanitized: false,
    metadataErrorCode: native ? "native_registry_metadata_unavailable" : "contract_metadata_unavailable",
    metadataErrorMessage: native
      ? "Native currency symbol and decimals are unavailable in the venue chain registry."
      : "Direct contract symbol and decimals could not be read on this chain.",
  };
}

async function resolveDescriptiveEvmIdentity(
  chainId: number,
  tokenAddress: string,
  signal: AbortSignal | undefined,
  resolver: () => Promise<BridgeAssetIdentity>,
): Promise<BridgeAssetIdentity> {
  try {
    return await resolver();
  } catch {
    throwIfAborted(signal);
    return unavailableIdentity(chainId, tokenAddress);
  }
}

function amountHuman(amountRaw: string, source: BridgeAssetIdentity): string | null {
  if (!isVerifiedEvmBridgeAssetIdentity(source) || !/^\d+$/.test(amountRaw)) return null;
  return formatUnits(BigInt(amountRaw), source.decimals);
}

export async function resolveKhalaniBridgeTokenPreview(
  params: Record<string, unknown>,
  signal?: AbortSignal,
  dependencies: BridgeTokenIdentityDependencies = {},
): Promise<BridgeTokenIdentityPreview> {
  const fromChain = typeof params.fromChain === "string" ? params.fromChain : "";
  const toChain = typeof params.toChain === "string" ? params.toChain : "";
  const fromToken = typeof params.fromToken === "string" ? params.fromToken : "";
  const toToken = typeof params.toToken === "string" ? params.toToken : "";
  const amountRaw = typeof params.amountRaw === "string" ? params.amountRaw : "";
  const chains = dependencies.khalaniChains ?? await getCachedKhalaniChains();
  throwIfAborted(signal);
  const fromChainId = resolveChainId(fromChain, chains);
  const toChainId = resolveChainId(toChain, chains);
  const from = getChain(fromChainId, chains);
  const to = getChain(toChainId, chains);
  return resolveKhalaniBridgeTokenPreviewFromResolved({
    fromChain: from,
    toChain: to,
    fromToken,
    toToken,
    amountRaw,
    chains,
    signal,
  }, dependencies.resolveEvmIdentity);
}

/** Handler seam for endpoints already authorized by Khalani route resolution. */
export async function resolveKhalaniBridgeTokenPreviewFromResolved(input: {
  readonly fromChain: KhalaniChain;
  readonly toChain: KhalaniChain;
  readonly fromToken: string;
  readonly toToken: string;
  readonly amountRaw: string;
  readonly chains: KhalaniChain[];
  readonly signal?: AbortSignal;
}, resolveEvmIdentity?: TestEvmIdentityResolver): Promise<BridgeTokenIdentityPreview> {
  const source = input.fromChain.type === "solana"
    ? solanaIdentity(input.fromChain.id, input.fromToken)
    : await resolveDescriptiveEvmIdentity(input.fromChain.id, input.fromToken, input.signal, () =>
        resolveEvmIdentity?.({ chainId: input.fromChain.id, tokenAddress: input.fromToken, signal: input.signal })
        ?? resolveKhalaniEvmBridgeAssetIdentity({
          chain: input.fromChain,
          chains: input.chains,
          tokenAddress: input.fromToken,
          signal: input.signal,
        }));
  const destination = input.toChain.type === "solana"
    ? solanaIdentity(input.toChain.id, input.toToken)
    : await resolveDescriptiveEvmIdentity(input.toChain.id, input.toToken, input.signal, () =>
        resolveEvmIdentity?.({ chainId: input.toChain.id, tokenAddress: input.toToken, signal: input.signal })
        ?? resolveKhalaniEvmBridgeAssetIdentity({
          chain: input.toChain,
          chains: input.chains,
          tokenAddress: input.toToken,
          signal: input.signal,
        }));
  return {
    source,
    destination,
    amountRaw: input.amountRaw,
    amountHuman: amountHuman(input.amountRaw, source),
  };
}

export async function resolveRelayBridgeTokenPreview(
  params: Record<string, unknown>,
  signal?: AbortSignal,
  dependencies: BridgeTokenIdentityDependencies = {},
): Promise<BridgeTokenIdentityPreview> {
  const fromChain = typeof params.fromChain === "string" ? params.fromChain : "";
  const toChain = typeof params.toChain === "string" ? params.toChain : "";
  const fromToken = typeof params.fromToken === "string" ? params.fromToken : "";
  const toToken = typeof params.toToken === "string" ? params.toToken : "";
  const amountRaw = typeof params.amountRaw === "string" ? params.amountRaw : "";
  const chains = dependencies.relayChains ?? await getCachedRelayChains();
  throwIfAborted(signal);
  const fromChainId = resolveRelayChainId(fromChain, chains);
  const toChainId = resolveRelayChainId(toChain, chains);
  const fromRegistry = chains.find((chain) => chain.id === fromChainId);
  const toRegistry = chains.find((chain) => chain.id === toChainId);
  if (!fromRegistry || !toRegistry) {
    throw new TypeError("Relay bridge chain resolution lost its registry entry.");
  }
  const source = isRelaySolanaChain(fromRegistry)
    ? solanaIdentity(fromChainId, fromToken)
    : await resolveDescriptiveEvmIdentity(fromChainId, fromToken, signal, () =>
        dependencies.resolveEvmIdentity?.({ chainId: fromChainId, tokenAddress: toRelayCurrency(fromToken), signal })
        ?? resolveRelayEvmBridgeAssetIdentity({
          chain: fromRegistry,
          chains,
          tokenAddress: toRelayCurrency(fromToken),
          signal,
        }));
  const destination = isRelaySolanaChain(toRegistry)
    ? solanaIdentity(toChainId, toToken)
    : await resolveDescriptiveEvmIdentity(toChainId, toToken, signal, () =>
        dependencies.resolveEvmIdentity?.({ chainId: toChainId, tokenAddress: toRelayCurrency(toToken), signal })
        ?? resolveRelayEvmBridgeAssetIdentity({
          chain: toRegistry,
          chains,
          tokenAddress: toRelayCurrency(toToken),
          signal,
        }));
  return { source, destination, amountRaw, amountHuman: amountHuman(amountRaw, source) };
}

function isRelaySolanaChain(chain: RelayChain): boolean {
  if (chain.id === RELAY_SOLANA_CHAIN_ID) return true;
  const names = [chain.name, chain.displayName]
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.toLowerCase());
  return chain.vmType !== "evm" && names.some((name) => name.includes("solana"));
}

function solanaIdentity(chainId: number, tokenAddress: string): BridgeAssetIdentity {
  return {
    family: "solana",
    kind: "solana",
    chainId,
    tokenAddress,
    symbol: null,
    decimals: null,
    metadataSource: "solana_not_read_by_evm_contract_resolver",
    symbolSanitized: false,
  };
}

export async function resolveBridgeTokenPreview(
  toolId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BridgeTokenIdentityPreview | undefined> {
  if (toolId === "khalani.bridge") return resolveKhalaniBridgeTokenPreview(params, signal);
  if (toolId === "relay.bridge") return resolveRelayBridgeTokenPreview(params, signal);
  return undefined;
}
