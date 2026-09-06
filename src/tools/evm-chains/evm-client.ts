/**
 * viem client factory for local (non-Khalani) EVM chains.
 *
 * TRANSPORTS COME FROM THE SHARED RPC OWNER (`./rpc-endpoints.ts` +
 * `./rpc-transport.ts`), never from a url this module knows. That is the whole
 * change: the endpoint order, the per-endpoint method scope, the user's own
 * override and the failover policy are chain properties with one owner, and a
 * client factory's job is to bind them to a viem `Chain` and an account.
 *
 * READS AND EXECUTIONS GET DIFFERENT TRANSPORTS, DELIBERATELY. A read rides the
 * failover list, so a refusing endpoint costs a retry on the next one instead of
 * an error. An EXECUTION rides a single pinned endpoint, so the nonce read, the
 * gas estimate, the pre-sign simulation and the broadcast are all the same
 * node's opinion; see `./rpc-transport.ts` for why that matters more than the
 * availability the failover would buy.
 *
 * Gas rule: NEVER cache or hardcode gas limits. Robinhood Chain is an Arbitrum
 * Orbit L2 whose fee has an L1-data component that fluctuates block to block -
 * viem estimates gas fresh at send time (its default) and we keep it that way.
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
import { toLocalViemChain, type LocalChainConfig } from "./registry.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "./rpc-transport.js";

export interface LocalEvmClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

// Explicit return annotations (mirroring kyberswap/evm/config.ts and
// khalani/evm-client.ts): viem's inferred client types reference internal
// action modules and are not portable across declaration emit (TS2742).
export function getLocalPublicClient(config: LocalChainConfig): PublicClient<Transport, Chain> {
  return createPublicClient({
    chain: toLocalViemChain(config),
    transport: buildEvmTransport(config.id),
  }) as PublicClient<Transport, Chain>;
}

/**
 * The pair one execution signs and reads through, both on the SAME pinned
 * endpoint by construction: the transport instance is shared, so the two
 * clients cannot end up on two different nodes.
 */
export function getLocalEvmClients(config: LocalChainConfig, privateKey: Hex): LocalEvmClients {
  const chain = toLocalViemChain(config);
  const transport = buildPinnedEvmTransport(config.id);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>;
  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport,
  }) as WalletClient<Transport, Chain, Account>;
  return { publicClient, walletClient };
}
