/**
 * A USER-DRIVEN ERC-20 TRANSFER on one local EVM chain: the reads a transfer
 * form needs and the ONE signing path, `signStageBroadcast` with a DEFERRED
 * signer. The token and the chain are the caller's parameters; the only
 * consumer today is the Vex Cloud deposit (VEX on Robinhood Chain,
 * `vex-app/src/main/vex-cloud/funding/deposit.ts`), whose owner decides the
 * destination and every bound. It lives beside the signing primitives so it
 * binds the same viem they are typed against.
 *
 * WHY DEFERRED. The key is decrypted only after every preparation call
 * (estimate, fee fill, nonce) and after the caller's pre-sign gate has
 * passed, and no provider call happens between that gate and the signature
 * (`src/tools/evm-chains/staged-broadcast.ts`, `DeferredEvmSigner`). The
 * nonce owner for (wallet, 4663) is taken inside `signStageBroadcast`, so two
 * Vex flows signing for the same wallet cannot reuse a nonce.
 *
 * THE NONCE IS NOT RESERVED DURABLY here. The durable allocator
 * (`evm_nonce_reservations`) admits a closed set of purposes by a CHECK
 * constraint, and adding one for the Vex Cloud deposit is a migration this
 * change does not make (an open question for the owner). `onNonceReserved`
 * therefore returns the node's pending count, which the in-process nonce
 * owner already serializes, and `signStageBroadcast` re-asserts that count
 * right before the signature. A crash between sign and send leaves the
 * pending count unchanged, so no later flow can be handed a nonce that is
 * actually in flight.
 *
 * READS ride the failover transport; THE SIGNING PATH rides one pinned,
 * broadcast-safe endpoint with `retryCount: 0` (`buildPinnedEvmTransport`),
 * so a signed transfer is never re-sent by a transport retry.
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
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readErc20Balance } from "./erc20-reads.js";
import { getLocalChain, toLocalViemChain } from "./registry.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "./rpc-transport.js";
import {
  signStageBroadcast,
  type FinalSignedRequest,
  type StagedBroadcastOutcome,
  type StagedFeeExposureLimit,
} from "./staged-broadcast.js";

export interface TransferFeeQuote {
  /** A fresh `eth_estimateGas` for this exact transfer, before any headroom. */
  readonly gasEstimate: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface TransferBroadcastRequest {
  readonly from: Address;
  /** `transfer(to, amount)` calldata on the VEX token. */
  readonly data: Hex;
  readonly feeBound: StagedFeeExposureLimit;
  /** THE LAST GATE: runs once after preparation, before the key exists. A throw signs nothing. */
  readonly onBeforeSign: (request: FinalSignedRequest) => Promise<void>;
  /** Decrypt the wallet's key, only after the gate passed. A throw signs nothing. */
  readonly loadPrivateKey: () => Promise<Hex>;
  /** Called with the hash after signing and before the send (the transaction exists from here). */
  readonly onHashStaged: (txHash: Hex) => void;
}

/** Everything a transfer owner needs from the chain; faked by unit tests, real on the Anvil fork. */
export interface Erc20TransferPort {
  readVexBalance(owner: Address, signal: AbortSignal, blockTag?: "pending" | "latest"): Promise<bigint>;
  readNativeBalance(owner: Address): Promise<bigint>;
  quoteTransferFees(from: Address, data: Hex): Promise<TransferFeeQuote>;
  broadcastTransfer(request: TransferBroadcastRequest): Promise<StagedBroadcastOutcome>;
}

export interface TransferChainClients {
  readonly chain: Chain;
  /** Reads: balances and quotes. */
  readonly readClient: PublicClient<Transport, Chain>;
  /** The signing path: estimate, fee fill, nonce, send and receipt on one node. */
  readonly signingClient: PublicClient<Transport, Chain>;
  readonly signingTransport: Transport;
}

/** Production clients for a local chain from the shared RPC owner: failover reads, a pinned signing endpoint. */
export function pinnedTransferChainClients(chainId: number): TransferChainClients {
  const config = getLocalChain(chainId);
  if (config === undefined) throw new Error(`Chain ${chainId} is not configured in this build.`);
  const chain = toLocalViemChain(config);
  const signingTransport = buildPinnedEvmTransport(config.id);
  return {
    chain,
    readClient: createPublicClient({ chain, transport: buildEvmTransport(config.id) }) as PublicClient<Transport, Chain>,
    signingClient: createPublicClient({ chain, transport: signingTransport }) as PublicClient<Transport, Chain>,
    signingTransport,
  };
}

/**
 * Clients for a local chain over ONE explicit RPC url for reads and the
 * signing path alike: a user's own node, or a local fork in the gated fork
 * test (`vex-app/src/main/vex-cloud/__tests__/deposit-anvil-fork.test.ts`).
 * The chain id is the caller's; the node must echo it or viem refuses to sign.
 */
export function transferChainClientsForRpc(chainId: number, rpcUrl: string): TransferChainClients {
  const config = getLocalChain(chainId);
  if (config === undefined) throw new Error(`Chain ${chainId} is not configured in this build.`);
  const chain = { ...toLocalViemChain(config), rpcUrls: { default: { http: [rpcUrl] } } };
  const transport = http(rpcUrl, { retryCount: 0 });
  const client = createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>;
  return { chain, readClient: client, signingClient: client, signingTransport: transport };
}

/** `token` is the ERC-20 being transferred; every read, estimate and signature is about it alone. */
export function createErc20TransferPort(clients: TransferChainClients, token: Address): Erc20TransferPort {
  return {
    readVexBalance(owner, signal, blockTag) {
      return readErc20Balance(clients.readClient, token, owner, {
        signal,
        ...(blockTag === undefined ? {} : { blockTag }),
      });
    },
    readNativeBalance(owner) {
      return clients.readClient.getBalance({ address: owner, blockTag: "pending" });
    },
    async quoteTransferFees(from, data) {
      const gasEstimate = await clients.signingClient.estimateGas({ account: from, to: token, data, value: 0n });
      const fees = await clients.signingClient.estimateFeesPerGas({ chain: clients.chain, type: "eip1559" });
      return {
        gasEstimate,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },
    broadcastTransfer(request) {
      return signStageBroadcast(
        clients.signingClient,
        {
          kind: "deferred",
          address: request.from,
          chain: clients.chain,
          onBeforeSign: request.onBeforeSign,
          createSigner: async (): Promise<WalletClient<Transport, Chain, Account>> =>
            createWalletClient({
              account: privateKeyToAccount(await request.loadPrivateKey()),
              chain: clients.chain,
              transport: clients.signingTransport,
            }) as WalletClient<Transport, Chain, Account>,
        },
        { to: token, data: request.data, value: 0n },
        {
          onNonceReserved: async ({ nodePendingNonce }) => nodePendingNonce,
          onHashStaged: async (handles) => {
            request.onHashStaged(handles.txHash);
          },
          onAccepted: async () => undefined,
        },
        undefined,
        undefined,
        request.feeBound,
      );
    },
  };
}
