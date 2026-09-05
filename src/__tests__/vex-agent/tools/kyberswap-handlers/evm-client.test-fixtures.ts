/**
 * The chain client the KyberSwap handler suites drive.
 *
 * WHY IT EXISTS. Since WP2-K both the quote and every pre-sign gate READ the
 * chain: the source balance and the native balance at `pending`, the fee price,
 * the gas each still-unbroadcast leg is authorized for, and the L1 data fee an
 * OP-stack chain charges for the bytes. A bare `{}` stands in for none of that,
 * and sixteen suites each inventing their own partial double is how they drift
 * apart about what a solvent wallet looks like.
 *
 * It is a FAKE, not a mock: it answers the same questions a node answers, from
 * one mutable state a test can tune, so an assertion about a refusal is an
 * assertion about the handler's arithmetic rather than about a call count.
 *
 * DEFAULTS ARE SOLVENT on purpose. A suite that is about the price floor, the
 * settlement decode or the safety gate must not have to think about balances;
 * a suite that IS about balances calls {@link setEvmFake} and states the one
 * number it is exercising.
 */

import type { Address, Hex } from "viem";

export interface EvmFakeState {
  /** Raw ERC-20 units returned for any `balanceOf`. */
  erc20BalanceRaw: bigint;
  /** Raw wei returned for any account balance. */
  nativeBalanceRaw: bigint;
  /** Raw units returned for any `allowance`. */
  allowanceRaw: bigint;
  /** What `eth_estimateGas` answers for every call. */
  gasEstimate: bigint;
  /** The OP-stack oracle's answer, in wei. */
  l1FeeWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasPrice: bigint;
  nonce: number;
  /** When set, every `eth_estimateGas` rejects with it. */
  gasEstimateFailure: Error | null;
  /** When set, every balance read rejects with it. */
  balanceReadFailure: Error | null;
}

const DEFAULTS: EvmFakeState = {
  // Generous by construction: the solvent default must not have to be re-stated
  // by every suite that is about something else.
  erc20BalanceRaw: 10n ** 30n,
  nativeBalanceRaw: 10n ** 24n,
  allowanceRaw: 10n ** 30n,
  // Base's own empty-transfer estimate; the headroom policy multiplies it.
  gasEstimate: 21_000n,
  // Measured on Base 2026-08-31: `getL1Fee` over a real 3236-byte KyberSwap
  // calldata answered 12,771,545,556 wei.
  l1FeeWei: 12_771_545_556n,
  // Measured on Base 2026-08-31: base fee 5,000,000 wei, priority 1,210,000 wei.
  maxFeePerGas: 11_210_000n,
  maxPriorityFeePerGas: 1_210_000n,
  gasPrice: 6_000_000n,
  nonce: 7,
  gasEstimateFailure: null,
  balanceReadFailure: null,
};

export const evmFakeState: EvmFakeState = { ...DEFAULTS };

/** Restore every default. Call from `beforeEach` so one suite cannot leak into the next. */
export function resetEvmFake(): void {
  Object.assign(evmFakeState, DEFAULTS);
}

/**
 * The two `@tools/kyberswap/evm-utils.js` exports every handler suite needs to
 * reach a chain, both answering with the SAME fake so a test that tunes the
 * state tunes the client the handler holds.
 */
export function kyberEvmClientMocks(): {
  getKyberEvmClients: () => { publicClient: unknown; walletClient: unknown };
  getKyberPublicClient: () => unknown;
} {
  return {
    getKyberEvmClients: () => ({ publicClient: evmClientFake, walletClient: {} }),
    getKyberPublicClient: () => evmClientFake,
  };
}

/** State exactly the facts this test is about; everything else stays solvent. */
export function setEvmFake(overrides: Partial<EvmFakeState>): void {
  Object.assign(evmFakeState, overrides);
}

interface ReadContractParameters {
  readonly address: Address;
  readonly abi: readonly unknown[];
  readonly functionName: string;
  readonly args?: readonly unknown[];
  readonly blockTag?: string;
}

/**
 * The single client object both `getKyberEvmClients().publicClient` and
 * `getKyberPublicClient()` hand back, so a test tuning the state tunes the
 * client the handler actually holds.
 */
export const evmClientFake = {
  async readContract(parameters: ReadContractParameters): Promise<unknown> {
    switch (parameters.functionName) {
      case "balanceOf":
        if (evmFakeState.balanceReadFailure) throw evmFakeState.balanceReadFailure;
        return evmFakeState.erc20BalanceRaw;
      case "allowance":
        return evmFakeState.allowanceRaw;
      case "getL1Fee":
        return evmFakeState.l1FeeWei;
      case "decimals":
        return 18;
      case "symbol":
        return "TKN";
      default:
        throw new Error(`evmClientFake: unexpected read ${parameters.functionName}`);
    }
  },
  async getBalance(_parameters: { address: Address; blockTag?: string }): Promise<bigint> {
    if (evmFakeState.balanceReadFailure) throw evmFakeState.balanceReadFailure;
    return evmFakeState.nativeBalanceRaw;
  },
  async estimateGas(_parameters: {
    account: Address;
    to: Address;
    data?: Hex;
    value: bigint;
  }): Promise<bigint> {
    if (evmFakeState.gasEstimateFailure) throw evmFakeState.gasEstimateFailure;
    return evmFakeState.gasEstimate;
  },
  async estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    return {
      maxFeePerGas: evmFakeState.maxFeePerGas,
      maxPriorityFeePerGas: evmFakeState.maxPriorityFeePerGas,
    };
  },
  async getGasPrice(): Promise<bigint> {
    return evmFakeState.gasPrice;
  },
  async getTransactionCount(_parameters: { address: Address; blockTag?: string }): Promise<number> {
    return evmFakeState.nonce;
  },
};
