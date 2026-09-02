/**
 * The chain reads the wrap lane needs, as the narrowest interface that can
 * express them, plus the real adapter behind it.
 *
 * A seam rather than a client, for the same reason the transaction lane uses
 * one: prepare must be provable without a network. Every method is a single
 * question with a single answer, so a test supplies an object literal and the
 * whole prepare path - registry lookup, balance guard, simulation, fee-bound
 * refusal, card, digest, insert - runs deterministically with no RPC.
 *
 * This seam is deliberately NOT `EvmPrepareChain` from the transaction lane.
 * That interface extends `EvmCodeReader` because generic prepare must decode
 * arbitrary calldata, and this lane must never reach that decoder: a wrap's
 * calldata is derived locally from bound fields and there is nothing to decode.
 * What this lane needs instead is a BALANCE, on the side the direction spends.
 *
 * The adapter builds PUBLIC clients only. Prepare never decrypts a key.
 */

import type { Chain, PublicClient, Transport } from "viem";

import { extractDecodedRevertReason } from "@tools/evm-chains/router-revert-reason.js";

import type { EvmFeeEstimates } from "../transaction/fee-bounds.js";

import { refuse, accept, type WrapOutcome } from "./refusal.js";

export interface WrapSimulationCall {
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
}

/** Everything wrap prepare and confirm ask a chain, and nothing else. */
export interface WrapChain {
  readonly chainId: number;
  readonly chainAlias: string;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;
  /** The signer's native balance, in wei, as a decimal string. */
  readonly getNativeBalance: (address: string) => Promise<string>;
  /** The signer's wrapped-native balance via `balanceOf`, as a decimal string. */
  readonly getWrappedBalance: (contract: string, address: string) => Promise<string>;
  /** `eth_call` from the selected wallet. A revert refuses with the DECODED reason. */
  readonly simulate: (call: WrapSimulationCall) => Promise<WrapOutcome<void>>;
  /** Current network fees, used ONLY as labelled hints inside a missing-bounds refusal. */
  readonly estimateFees: (call: WrapSimulationCall) => Promise<EvmFeeEstimates>;
}

export type WrapChainFactory = (chainInput: string) => Promise<WrapChain>;

/** `balanceOf(address)`. */
const BALANCE_OF_SELECTOR = "0x70a08231";

export const defaultWrapChainFactory: WrapChainFactory = async (chainInput) => {
  const { resolveInclusiveEvmChain } = await import("@tools/evm-chains/resolver.js");
  const resolved = await resolveInclusiveEvmChain(chainInput);

  let publicClient: PublicClient<Transport, Chain>;
  let chainAlias: string;
  let nativeSymbol: string;
  let nativeDecimals: number;

  if (resolved.source === "khalani") {
    const { createDynamicPublicClient } = await import("@tools/khalani/evm-client.js");
    publicClient = createDynamicPublicClient(resolved.khalaniChain, resolved.khalaniChains);
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

    getNativeBalance: async (address) => {
      const balance = await publicClient.getBalance({ address: address as `0x${string}` });
      return balance.toString(10);
    },

    getWrappedBalance: async (contract, address) => {
      const data = `${BALANCE_OF_SELECTOR}${address.slice(2).toLowerCase().padStart(64, "0")}`;
      const result = await publicClient.call({
        to: contract as `0x${string}`,
        data: data as `0x${string}`,
      });
      const word = result.data;
      // An empty answer is not a zero balance: it is a contract that did not
      // answer the question. Returning "0" here would let an unwrap of a real
      // balance refuse as insufficient, so the caller sees the failure instead.
      if (word === undefined || word === "0x") {
        throw new Error("wrap: balanceOf returned no data");
      }
      return BigInt(word).toString(10);
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
          "Refusing to prepare: simulating this conversion against the current chain state failed, "
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
