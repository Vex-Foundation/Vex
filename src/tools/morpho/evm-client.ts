/**
 * The viem public client the Morpho on-chain reads use.
 *
 * THE RPC CHOICE IS NO LONGER A VENUE DECISION. Endpoint order, per-endpoint
 * method scope, the user's override and the failover policy now live in
 * `@tools/evm-chains/rpc-endpoints.ts` for every venue at once; this module
 * keeps what genuinely is a Morpho decision - which chains are supported, the
 * Multicall3 address, the native symbol - and asks the owner for a transport.
 * The private `MORPHO_RPC_FALLBACKS` list that used to make Base a fallback
 * chain here is retired: it was the only failover in the repository, and its
 * first alternate (`1rpc.io/base`) answers `eth_feeHistory` with "This endpoint
 * has been discontinued".
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
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { VexError, ErrorCodes } from "../../errors.js";
import { MORPHO_MULTICALL3, MORPHO_NATIVE_SYMBOL } from "./constants.js";
import { resolveRpcEndpoints } from "../evm-chains/rpc-endpoints.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "../evm-chains/rpc-transport.js";
import { MORPHO_CHAINS, describeUnsupportedChain } from "./chains.js";

const BY_ID = new Map(MORPHO_CHAINS.map((chain) => [chain.chainId, chain]));

/** The first endpoint the shared owner resolves. Chain METADATA, not the transport. */
function resolveMorphoRpcUrl(chainId: number): string | undefined {
  return resolveRpcEndpoints(chainId)[0]?.url;
}

function buildViemChain(chainId: number): { chain: Chain; rpcUrl: string } {
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
    chain: {
      id: chain.chainId,
      name: chain.morphoNetwork,
      nativeCurrency: { name: symbol, symbol, decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
      contracts: { multicall3: { address: MORPHO_MULTICALL3 } },
    },
    rpcUrl,
  };
}

/** A budgeted, Multicall3-wired public client for a supported Morpho chain. */
export function getMorphoPublicClient(chainId: number): PublicClient<Transport, Chain> {
  const { chain } = buildViemChain(chainId);
  return createPublicClient({
    chain,
    transport: buildEvmTransport(chainId),
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
  const { chain } = buildViemChain(chainId);
  // PINNED, not the failover list. The old code handed the SAME fallback
  // transport to both clients, so a timeout on `eth_getTransactionCount` at one
  // endpoint followed by `eth_sendRawTransaction` at another meant the nonce was
  // read from a different node than the one that accepted the transaction, with
  // nothing recording that it had happened.
  const transport = buildPinnedEvmTransport(chainId);
  return {
    publicClient: createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>,
    walletClient: createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain,
      transport,
    }),
  };
}
