/**
 * KyberSwap EVM configuration: ABI, RPC defaults, chain mapping, client creation.
 */

import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VexError, ErrorCodes } from "../../../errors.js";
import { slugToChainId } from "../chains.js";
import { getLocalChain, getLocalChainRpcUrl, toLocalViemChain } from "../../evm-chains/registry.js";
import { resolveRpcEndpoints } from "../../evm-chains/rpc-endpoints.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "../../evm-chains/rpc-transport.js";
import type { KyberChainSlug } from "../types.js";

/**
 * Robinhood Chain (4663) is aggregator-supported by KyberSwap but its chain
 * metadata (RPC + user override + Multicall3 + explorer) is owned by the shared
 * evm-chains registry that Uniswap already uses. We REUSE that entry here rather
 * than duplicate the endpoint, so a user RPC override applies to Kyber too and
 * the two swap venues can never drift on 4663's wiring.
 */
const ROBINHOOD_CHAIN_ID = 4663;

function robinhoodLocalChain() {
  const config = getLocalChain(ROBINHOOD_CHAIN_ID);
  if (!config) {
    throw new VexError(
      ErrorCodes.KYBER_UNSUPPORTED_CHAIN,
      "Missing evm-chains registry entry for Robinhood Chain (4663)",
    );
  }
  return config;
}

// ── ERC-20 ABI (minimal: allowance + approve + metadata) ─────────────

export const ERC20_ABI = [
  {
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── RPC ─────────────────────────────────────────────────────────────
//
// THE ENDPOINT TABLE THAT USED TO LIVE HERE HAS MOVED to
// `@tools/evm-chains/rpc-endpoints.ts`, which is now the one owner for every
// venue. This file's old header claimed to be "the SHARED per-slug default -
// fix an endpoint here, not in a per-venue copy", and five files never followed
// it: Uniswap, Pendle and the three Virtuals tables kept `base.drpc.org` long
// after this table had moved Base off it. A rule that only one file's author
// remembers is not an owner; a function every client factory must call is.
//
// The keys changed with the move: the owner is keyed by CHAIN ID, not by
// KyberSwap slug, because a chain id is what the user's override, the receipt
// probe and every other venue already speak.

/**
 * The first endpoint the shared owner resolves for a Kyber slug. Chain
 * METADATA, not the transport. Throws (never a silent undefined) when neither
 * the user nor the table has an endpoint for the chain.
 */
function resolveKyberRpcUrl(slug: KyberChainSlug): string {
  if (slug === "robinhood") {
    return getLocalChainRpcUrl(robinhoodLocalChain());
  }
  const first = resolveRpcEndpoints(slugToChainId(slug))[0];
  if (first === undefined) {
    throw new VexError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN, `No RPC URL for chain: ${slug}`);
  }
  return first.url;
}

export function toViemChain(slug: KyberChainSlug): Chain {
  // Robinhood reuses the shared local-chain definition (wires Multicall3 +
  // explorer + user RPC override) instead of the minimal build below.
  if (slug === "robinhood") {
    return toLocalViemChain(robinhoodLocalChain());
  }
  const chainId = slugToChainId(slug);
  const rpcUrl = resolveKyberRpcUrl(slug);
  return {
    id: chainId,
    name: slug,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

// ── Client creation ─────────────────────────────────────────────────

export interface KyberEvmClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

export function getKyberEvmClients(slug: KyberChainSlug, privateKey: Hex): KyberEvmClients {
  const chain = toViemChain(slug);
  // ONE pinned transport for both clients (see `evm-chains/rpc-transport.ts`):
  // the quote simulation, the estimate, the nonce and the broadcast all land on
  // the same node.
  const transport = buildPinnedEvmTransport(chain.id);

  const publicClient = createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>;

  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport,
  }) as WalletClient<Transport, Chain, Account>;

  return { publicClient, walletClient };
}

// ── Read-only public client ─────────────────────────────────────────

/**
 * Get a read-only public client for a chain (no wallet needed).
 * Used for on-chain token metadata reads.
 */
export function getKyberPublicClient(slug: KyberChainSlug): PublicClient<Transport, Chain> {
  const chain = toViemChain(slug);
  return createPublicClient({
    chain,
    transport: buildEvmTransport(chain.id),
  }) as PublicClient<Transport, Chain>;
}
