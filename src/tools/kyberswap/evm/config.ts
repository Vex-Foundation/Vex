/**
 * KyberSwap EVM configuration: ABI, RPC defaults, chain mapping, client creation.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
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

// ── Default RPC URLs per chain ──────────────────────────────────────

// Base and Arbitrum are deliberately NOT publicnode: the funded live probe of
// 2026-08-17 proved `base-rpc.publicnode.com` and `arbitrum-one-rpc.publicnode.com`
// refuse `eth_getTransactionReceipt` at the METHOD level (-32602 "Archive
// requests require a personal token") even for a head-block transaction, so a
// swap sent through them can never be confirmed. Both replacements were
// live-verified to serve a receipt for a transaction from their own latest
// block. Base is drpc rather than the official `mainnet.base.org` because that
// one rate limits at about five requests (5x 200 then 7x 429 in a 12-request
// burst) while `base.drpc.org` took 30 with no throttling. The other publicnode
// endpoints answered normally on the same day.
//
// SECOND CORRECTION, SAME DAY: the funded probe's rerun proved drpc meters a
// COMPUTE budget, not a request count - five consecutive heavy eth_call
// simulations (~460k gas each) exhausted the free plan, after which even a
// trivial read was refused. A battery with the real 804-byte Morpho deposit
// bundle measured `base-mainnet.public.blastapi.io` and `1rpc.io/base` at 8/8
// heavy calls plus a served receipt, drpc at 0/8 once spent, the official
// endpoint at 5/8 then 429. Base therefore moves to blastapi. This table is
// the SHARED per-slug default for EVM venues (morpho derives its own table
// from it; pendle aligns its chains to these slugs) - fix an endpoint here,
// not in a per-venue copy.
export const DEFAULT_RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  base: "https://base-mainnet.public.blastapi.io",
  linea: "https://rpc.linea.build",
  mantle: "https://rpc.mantle.xyz",
  sonic: "https://rpc.soniclabs.com",
  berachain: "https://rpc.berachain.com",
  ronin: "https://api.roninchain.com/rpc",
  unichain: "https://mainnet.unichain.org",
  hyperevm: "https://rpc.hyperliquid.xyz/evm",
  plasma: "https://rpc.plasma.to",
  monad: "https://rpc.monad.xyz",
  megaeth: "https://mainnet.megaeth.com/rpc",
};

export const RPC_TIMEOUT_MS = 30_000;
export const RPC_RETRY_COUNT = 2;

// ── RPC + viem Chain resolution ─────────────────────────────────────

/**
 * Resolve the RPC URL for a Kyber-supported chain. Robinhood (4663) defers to the
 * shared evm-chains registry (honouring a user override); every other chain uses
 * the bundled default. Throws (never a silent undefined) when a chain has no RPC.
 */
function resolveKyberRpcUrl(slug: KyberChainSlug): string {
  if (slug === "robinhood") {
    return getLocalChainRpcUrl(robinhoodLocalChain());
  }
  const rpcUrl = DEFAULT_RPC[slug];
  if (!rpcUrl) {
    throw new VexError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN, `No RPC URL for chain: ${slug}`);
  }
  return rpcUrl;
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
  const rpcUrl = resolveKyberRpcUrl(slug);

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
  }) as PublicClient<Transport, Chain>;

  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
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
  const rpcUrl = resolveKyberRpcUrl(slug);
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
  }) as PublicClient<Transport, Chain>;
}
