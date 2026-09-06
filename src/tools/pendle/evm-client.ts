/**
 * Pendle viem client factory (multichain, public + wallet).
 *
 * Builds a viem `Chain` for any supported Pendle chain from the network-free
 * registry (`./chains.ts`), wiring the Multicall3 contract so
 * `publicClient.multicall` works, and takes its TRANSPORT from the shared RPC
 * owner (`@tools/evm-chains/rpc-endpoints.ts`).
 *
 * THE USER OVERRIDE STILL WORKS AND NOW REACHES FURTHER. `pendleRpcUrls[chainId]`
 * has not changed shape and is not read here any more: it is one of the two maps
 * `@config/chain-rpc-overrides.ts` merges, and the shared resolver puts BOTH of
 * them ahead of every bundled entry for every venue. A user who set
 * `pendleRpcUrls` for a chain now gets that endpoint on Morpho and Uniswap too,
 * which is the point of there being one owner.
 *
 * Gas is estimated fresh at send time (viem default) - never cached. An
 * unsupported chain id is rejected with a clear VexError.
 */

import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { VexError, ErrorCodes } from "../../errors.js";
import { resolveRpcEndpoints } from "../evm-chains/rpc-endpoints.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "../evm-chains/rpc-transport.js";
import { getPendleChain, type PendleChain } from "./chains.js";

export interface PendleEvmClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

/** Resolve the registry entry for a chain id or throw a clear VexError. */
function requirePendleChain(chainId: number): PendleChain {
  const chain = getPendleChain(chainId);
  if (!chain) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, `Pendle does not support chain id ${chainId}.`);
  }
  return chain;
}

/** The first endpoint the shared owner resolves. Chain METADATA, not the transport. */
function rpcUrlFor(chain: PendleChain): string {
  const first = resolveRpcEndpoints(chain.chainId)[0];
  if (first === undefined) {
    throw new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      `Pendle: no RPC endpoint is bundled or configured for chain id ${chain.chainId}.`,
    );
  }
  return first.url;
}

/** Build the viem `Chain` (with Multicall3 wired) for a supported chain id. */
function buildViemChain(chain: PendleChain): Chain {
  return {
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlFor(chain)] } },
    contracts: { multicall3: { address: chain.multicall3 } },
  };
}

/** Read-only public client for a supported chain (balances / allowance / metadata). */
export function getPendlePublicClient(chainId: number): PublicClient<Transport, Chain> {
  const chain = requirePendleChain(chainId);
  const viemChain = buildViemChain(chain);
  return createPublicClient({
    chain: viemChain,
    transport: buildEvmTransport(chainId),
  }) as PublicClient<Transport, Chain>;
}

/** Public + wallet clients for broadcast on a supported chain. Decrypts nothing beyond the passed key. */
export function getPendleEvmClients(chainId: number, privateKey: Hex): PendleEvmClients {
  const chain = requirePendleChain(chainId);
  const viemChain = buildViemChain(chain);
  // ONE pinned transport for both clients (see `evm-chains/rpc-transport.ts`).
  const transport = buildPinnedEvmTransport(chainId);
  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
  }) as PublicClient<Transport, Chain>;
  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: viemChain,
    transport,
  }) as WalletClient<Transport, Chain, Account>;
  return { publicClient, walletClient };
}
