/**
 * The viem public client the Morpho on-chain reads use.
 *
 * Structurally the same as `src/tools/pendle/evm-client.ts`, and it exists
 * separately for the same reason Pendle's does: the chain table, the RPC choice
 * and the Multicall3 wiring are venue decisions, and a shared client that
 * guessed them would be wrong for somebody.
 *
 * `contracts.multicall3` IS WIRED UNCONDITIONALLY, which is the one thing that
 * must not be copied from `src/tools/kyberswap/evm/config.ts`. That module wires
 * Multicall3 for Robinhood alone, so `client.multicall(...)` fails on the other
 * eight chains, and it hardcodes `nativeCurrency` as ETH/18 everywhere, which
 * misnames POL, MON and HYPE. Both matter here: this lane reads many tokens and
 * many spenders in one batch, and it reports a native balance by symbol.
 *
 * The `as PublicClient<Transport, Chain>` cast at the end is the repo-wide,
 * deliberate one (TS2742 declaration-emit portability), documented in
 * `src/tools/evm-chains/evm-client.ts`.
 */

import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { VexError, ErrorCodes } from "../../errors.js";
import {
  MORPHO_DEFAULT_RPC,
  MORPHO_MULTICALL3,
  MORPHO_NATIVE_SYMBOL,
  MORPHO_RPC_FALLBACKS,
} from "./constants.js";
import { getLocalChain, getLocalChainRpcUrl } from "../evm-chains/registry.js";
import { MORPHO_CHAINS, describeUnsupportedChain } from "./chains.js";

const RPC_TIMEOUT_MS = 30_000;
const RPC_RETRY_COUNT = 2;

const BY_ID = new Map(MORPHO_CHAINS.map((chain) => [chain.chainId, chain]));

function resolveMorphoRpcUrl(chainId: number): string | undefined {
  // Robinhood defers to the shared evm-chains registry, which honours the
  // user's RPC override - the same resolution KyberSwap documents for 4663.
  const local = getLocalChain(chainId);
  if (local !== undefined) return getLocalChainRpcUrl(local);
  return MORPHO_DEFAULT_RPC[chainId];
}

function buildViemChain(chainId: number): Chain {
  const chain = BY_ID.get(chainId);
  const rpcUrl = resolveMorphoRpcUrl(chainId);
  if (chain === undefined || rpcUrl === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_UNSUPPORTED_CHAIN,
      `Morpho: ${describeUnsupportedChain(String(chainId))}`,
      "Name one of the supported chain slugs, or its numeric chain id.",
    );
  }
  const symbol = MORPHO_NATIVE_SYMBOL[chainId] ?? "ETH";
  return {
    id: chain.chainId,
    name: chain.morphoNetwork,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MORPHO_MULTICALL3 } },
  };
}

/**
 * The transport for a supported Morpho chain: plain HTTP when one verified
 * endpoint exists, a viem `fallback` chain when `MORPHO_RPC_FALLBACKS` lists
 * alternates. Every free Base endpoint meters something (funded probe reruns,
 * 2026-08-17: one refuses receipts, one exhausts a compute budget, one 429s),
 * so a provider that starts refusing hands the call to the next verified one
 * instead of turning a money-path read into an ambiguity. `rank: false` keeps
 * the measured order deliberate.
 */
function buildMorphoTransport(chainId: number, primaryUrl: string): Transport {
  const httpOptions = { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT };
  const alternates = MORPHO_RPC_FALLBACKS[chainId];
  if (alternates === undefined || alternates.length === 0) return http(primaryUrl, httpOptions);
  return fallback(
    [primaryUrl, ...alternates].map((url) => http(url, httpOptions)),
    { rank: false },
  );
}

/** A budgeted, Multicall3-wired public client for a supported Morpho chain. */
export function getMorphoPublicClient(chainId: number): PublicClient<Transport, Chain> {
  const chain = buildViemChain(chainId);
  return createPublicClient({
    chain,
    transport: buildMorphoTransport(chainId, chain.rpcUrls.default.http[0]),
  }) as PublicClient<Transport, Chain>;
}

/** The pair one Morpho execution signs and reads through. Same chain, by construction. */
export interface MorphoEvmClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

/**
 * The account-bound pair a Morpho EXECUTION runs against, built from the SAME
 * chain definition as the public client above.
 *
 * ONE CHAIN, TWO CLIENTS, DELIBERATELY BUILT TOGETHER: the estimate and the
 * simulation must be read from the chain the transaction is actually sent to,
 * and handing the caller two independently-constructed clients is how that stops
 * being guaranteed. The signing module takes them injected for the same reason
 * (see `morpho/handlers/signed-broadcast.ts`), so no key material lives there.
 *
 * The private key is supplied by the caller's wallet resolution and is never
 * read, cached or logged here.
 */
export function getMorphoEvmClients(chainId: number, privateKey: Hex): MorphoEvmClients {
  const chain = buildViemChain(chainId);
  const transport = buildMorphoTransport(chainId, chain.rpcUrls.default.http[0]);
  return {
    publicClient: createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>,
    walletClient: createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain,
      transport,
    }),
  };
}
