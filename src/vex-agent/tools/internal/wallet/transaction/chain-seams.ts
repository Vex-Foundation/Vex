/**
 * The chain reads the prepare handlers need, expressed as the NARROWEST
 * interfaces that can express them, plus the real adapters behind them.
 *
 * Why a seam rather than a client: prepare has to be provable without a
 * network. Every one of these methods is a single question with a single
 * answer, so a test supplies an object literal and the whole prepare path -
 * decode, simulation, fee-bound refusal, digest, insert - runs deterministically
 * with no RPC, no fixtures and no recorded cassettes. The adapters below are the
 * only code in this arc that talks to a chain, and nothing in the arc's tests
 * constructs one.
 *
 * The adapters build PUBLIC clients only. Prepare never decrypts a key: the
 * selected wallet reaches it as an address, and Solana canonicalization takes a
 * `PublicKey`.
 */

import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { Chain, PublicClient, Transport } from "viem";

import { extractDecodedRevertReason } from "@tools/evm-chains/router-revert-reason.js";

import type { AddressLookupTableReader } from "./decode-solana.js";
import type { EvmCodeReader } from "./decode-evm.js";
import type { EvmFeeEstimates, SolanaFeeEstimates } from "./fee-bounds.js";
import { accept, refuse, type TransactionOutcome } from "./refusal.js";

// ── EVM ───────────────────────────────────────────────────────────────

export interface EvmSimulationCall {
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
}

/** Everything EVM prepare asks a chain, and nothing else. */
export interface EvmPrepareChain extends EvmCodeReader {
  readonly chainId: number;
  readonly chainAlias: string;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;
  /** `eth_call` from the selected wallet. A revert refuses with the DECODED reason. */
  readonly simulate: (call: EvmSimulationCall) => Promise<TransactionOutcome<void>>;
  /** Current network fees, used ONLY as labelled hints inside a missing-bounds refusal. */
  readonly estimateFees: (call: EvmSimulationCall) => Promise<EvmFeeEstimates>;
}

export type EvmPrepareChainFactory = (chainInput: string) => Promise<EvmPrepareChain>;

/**
 * The real adapter. Resolves the chain through the inclusive resolver so a
 * Khalani-registered chain and a local-registry chain both work, exactly as the
 * transfer executor does.
 */
export const defaultEvmPrepareChainFactory: EvmPrepareChainFactory = async (chainInput) => {
  const { resolveInclusiveEvmChain } = await import("@tools/evm-chains/resolver.js");
  const resolved = await resolveInclusiveEvmChain(chainInput);

  // The NAMED viem type both factories actually return, instead of a loose
  // structural seam that forced `as unknown as` at both call sites (same
  // no-any fix as confirm-evm.ts).
  let publicClient: PublicClient<Transport, Chain>;
  let chainAlias: string;
  let nativeSymbol: string;
  let nativeDecimals: number;

  if (resolved.source === "khalani") {
    const { createDynamicPublicClient } = await import("@tools/khalani/evm-client.js");
    publicClient = createDynamicPublicClient(
      resolved.khalaniChain,
      resolved.khalaniChains,
    );
    chainAlias = resolved.khalaniChain.name || chainInput;
    nativeSymbol = resolved.khalaniChain.nativeCurrency.symbol;
    nativeDecimals = resolved.khalaniChain.nativeCurrency.decimals;
  } else {
    const { getLocalPublicClient } = await import("@tools/evm-chains/evm-client.js");
    publicClient = getLocalPublicClient(resolved.config);
    chainAlias = resolved.config.name || chainInput;
    nativeSymbol = resolved.config.nativeCurrency.symbol;
    nativeDecimals = resolved.config.nativeCurrency.decimals;
  }

  return {
    chainId: resolved.chainId,
    chainAlias,
    nativeSymbol,
    nativeDecimals,
    getCode: async (address) => {
      const code = await publicClient.getCode({ address: address as `0x${string}` });
      // viem answers `undefined` for an account with no code; the seam's
      // contract is the RPC's own `0x`, so the two spellings converge here
      // rather than in every caller.
      return code === undefined || code === "0x" ? "0x" : code;
    },
    simulate: async (call) => {
      try {
        await publicClient.call({
          account: call.from as `0x${string}`,
          to: call.to as `0x${string}`,
          data: call.data as `0x${string}`,
          value: BigInt(call.valueWei),
        });
        return accept(undefined);
      } catch (err) {
        const reason = extractDecodedRevertReason(err);
        return refuse(
          "simulation_failed",
          "Refusing to prepare: simulating this transaction against the current chain state failed, "
          + "so its effect cannot be shown or approved"
          + (reason === undefined
            ? " and the node returned no decodable revert reason."
            : `. The contract reverted with: ${reason}.`),
          reason === undefined ? { chainId: String(resolved.chainId) } : { revertReason: reason },
        );
      }
    },
    estimateFees: async (call) => {
      const [fees, gasPrice, gasLimit] = await Promise.all([
        publicClient.estimateFeesPerGas().catch(
          (): { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } => ({}),
        ),
        publicClient.getGasPrice().catch(() => 0n),
        publicClient
          .estimateGas({
            account: call.from as `0x${string}`,
            to: call.to as `0x${string}`,
            data: call.data as `0x${string}`,
            value: BigInt(call.valueWei),
          })
          .catch(() => 0n),
      ]);
      return {
        suggestedGasLimit: gasLimit.toString(),
        suggestedMaxFeePerGasWei: (fees.maxFeePerGas ?? 0n).toString(),
        suggestedMaxPriorityFeePerGasWei: (fees.maxPriorityFeePerGas ?? 0n).toString(),
        suggestedGasPriceWei: gasPrice.toString(),
        supportsEip1559: fees.maxFeePerGas !== undefined,
      };
    },
  };
};

// ── Solana ────────────────────────────────────────────────────────────

/**
 * Everything the Solana prepare AND confirm paths ask a chain, and nothing else.
 *
 * `getBlockHeight` is a CONFIRM-time question and it is the authoritative one:
 * `lastValidBlockHeight` is the intent's real expiry bound, and block height
 * does not convert to a timestamp, so confirm rechecks the height whatever the
 * displayed 60 s cap says.
 */
export interface SolanaPrepareChain extends AddressLookupTableReader {
  readonly getLatestBlockhash: () => Promise<{
    readonly blockhash: string;
    readonly lastValidBlockHeight: number;
  }>;
  /** Current block height. The AUTHORITY for a Solana intent's expiry. */
  readonly getBlockHeight: () => Promise<number>;
  /** Simulate the CANONICAL message, the one with the fresh blockhash already installed. */
  readonly simulateMessage: (messageBase64: string) => Promise<TransactionOutcome<void>>;
  readonly estimateFees: () => Promise<SolanaFeeEstimates>;
  /**
   * The EXACT lamport fee the network charges for this message, via
   * `getFeeForMessage`. `null` when the node cannot answer (blockhash no longer
   * known, or an RPC error), which is itself a refusal signal at both prepare
   * and confirm: an unqueryable fee cannot be shown to be within the authorized
   * cap. This is the authorization basis for the base fee, NOT the hard-coded
   * per-signature constant, which is only a hint floor.
   */
  readonly getMessageFee: (messageBase64: string) => Promise<number | null>;
}

export type SolanaPrepareChainFactory = () => Promise<SolanaPrepareChain>;

/**
 * Fallback compute-unit hint when the node returns no simulated unit count.
 * A HINT inside a refusal, never a bound: nothing is ever prepared from it.
 */
const SOLANA_FALLBACK_CU_HINT = "200000";

export const defaultSolanaPrepareChainFactory: SolanaPrepareChainFactory = async () => {
  const { getSolanaConnection } = await import(
    "@tools/solana-ecosystem/shared/solana-transaction/connection.js"
  );
  const connection: Connection = getSolanaConnection();

  return {
    getLatestBlockhash: async () => {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      return { blockhash, lastValidBlockHeight };
    },
    getBlockHeight: () => connection.getBlockHeight("confirmed"),
    getLookupTableAddresses: async (tableKey) => {
      try {
        const account = await connection.getAddressLookupTable(new PublicKey(tableKey));
        if (account.value === null) return null;
        return account.value.state.addresses.map((address) => address.toBase58());
      } catch {
        // An unreadable table and a missing table are the same verdict for the
        // caller: the account set cannot be enumerated, so decode refuses.
        return null;
      }
    },
    simulateMessage: async (messageBase64) => {
      const { VersionedMessage, VersionedTransaction } = await import("@solana/web3.js");
      try {
        const message = VersionedMessage.deserialize(
          new Uint8Array(Buffer.from(messageBase64, "base64")),
        );
        const result = await connection.simulateTransaction(new VersionedTransaction(message), {
          sigVerify: false,
          replaceRecentBlockhash: false,
        });
        if (result.value.err !== null) {
          return refuse(
            "simulation_failed",
            "Refusing to prepare: simulating this message against the current chain state failed, so "
            + "its effect cannot be shown or approved. The runtime reported error "
            + `${JSON.stringify(result.value.err)}.`,
          );
        }
        return accept(undefined);
      } catch {
        return refuse(
          "simulation_failed",
          "Refusing to prepare: the message could not be simulated, so its effect cannot be shown or "
          + "approved.",
        );
      }
    },
    getMessageFee: async (messageBase64) => {
      try {
        const { VersionedMessage } = await import("@solana/web3.js");
        const message = VersionedMessage.deserialize(
          new Uint8Array(Buffer.from(messageBase64, "base64")),
        );
        // `getFeeForMessage` returns the exact lamport charge for THIS message
        // against the current fee schedule, or `null` when the node no longer
        // knows the message's blockhash. `null` and an RPC throw are the same
        // verdict for the caller: the fee is unqueryable, so it is refused.
        const result = await connection.getFeeForMessage(message, "confirmed");
        return result.value ?? null;
      } catch {
        return null;
      }
    },
    estimateFees: async () => {
      const fees = await connection.getRecentPrioritizationFees().catch(() => []);
      const highest = fees.reduce(
        (max, row) => (row.prioritizationFee > max ? row.prioritizationFee : max),
        0,
      );
      return {
        suggestedComputeUnitLimit: SOLANA_FALLBACK_CU_HINT,
        suggestedComputeUnitPriceMicroLamports: String(highest),
      };
    },
  };
};
