/**
 * A viem-shaped public client that answers the reads WP2-U's spendability lane
 * makes, for the suites whose subject is something else.
 *
 * WHY IT EXISTS. Since WP2-U every Uniswap quote reads the wallet's input and
 * native balances and prices the whole leg plan, and every leg's pre-sign gate
 * repeats that read on the request about to be signed. A suite about receipt
 * decoding or fee ordering must not have to know any of that - but it also must
 * not be able to pass by accident because its fake client answered nothing. So
 * the default here is a SOLVENT wallet on a chain whose gas is cheap: the
 * spendability verdict is `executable` and the suite's real subject is what
 * decides its outcome.
 *
 * Every figure is overridable, which is what the two WP2-U suites use to make
 * the wallet short, the read fail, or the gas price jump.
 */

import type { Address } from "viem";

export interface UniswapSpendabilityFakeOptions {
  /** Native balance at every block tag, in wei. */
  readonly nativeBalanceWei?: bigint;
  /** ERC-20 `balanceOf` answer, in the token's smallest unit. */
  readonly tokenBalanceRaw?: bigint;
  /** What `eth_estimateGas` answers for every leg. */
  readonly gasEstimate?: bigint;
  /** The legacy gas price the chain reports, in wei. */
  readonly gasPriceWei?: bigint;
  /** EIP-1559 pricing instead of the legacy price, when supplied. */
  readonly feesPerGas?: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
  /** The OP-stack oracle's answer, for chains whose mechanism consults it. */
  readonly l1FeeWei?: bigint;
  /** Make the native read fail, so the verdict is `balance_unavailable`. */
  readonly nativeReadFails?: boolean;
  /** Make the ERC-20 read fail at every tag. */
  readonly tokenReadFails?: boolean;
  /** Make every gas estimate fail. */
  readonly estimateFails?: boolean;
  /**
   * Make the gas estimate fail only for these targets, which is the real shape:
   * an unapproved ERC-20 swap cannot be simulated (the router reverts inside
   * `transferFrom`) while the approve leg and the reserve's self-transfer
   * estimate normally.
   */
  readonly estimateFailsForTargets?: readonly string[];
  /** The pending transaction count the reserve is priced against. */
  readonly nonce?: number;
}

export interface UniswapSpendabilityFake {
  readContract: (parameters: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    blockTag?: string;
  }) => Promise<unknown>;
  getBalance: (parameters: { address: Address; blockTag?: string }) => Promise<bigint>;
  estimateGas: (parameters: { account: Address; to: Address; data?: string; value: bigint }) => Promise<bigint>;
  estimateFeesPerGas: () => Promise<{
    maxFeePerGas?: bigint | undefined;
    maxPriorityFeePerGas?: bigint | undefined;
    gasPrice?: bigint | undefined;
  }>;
  getGasPrice: () => Promise<bigint>;
  getTransactionCount: (parameters: { address: Address; blockTag?: string }) => Promise<number>;
}

/** One ether, as the default balance: comfortably above any figure these suites trade. */
const DEFAULT_NATIVE_WEI = 10n ** 18n;
/** A large token balance, so the source leg is never the reason a suite fails. */
const DEFAULT_TOKEN_RAW = 10n ** 30n;

export function uniswapSpendabilityFake(
  options: UniswapSpendabilityFakeOptions = {},
): UniswapSpendabilityFake {
  const nativeWei = options.nativeBalanceWei ?? DEFAULT_NATIVE_WEI;
  const tokenRaw = options.tokenBalanceRaw ?? DEFAULT_TOKEN_RAW;
  const gasEstimate = options.gasEstimate ?? 21_000n;
  const gasPrice = options.gasPriceWei ?? 1_000n;

  return {
    readContract: async (parameters) => {
      if (parameters.functionName === "getL1Fee") return options.l1FeeWei ?? 0n;
      if (parameters.functionName === "balanceOf") {
        if (options.tokenReadFails === true) throw new Error("erc20 read failed");
        return tokenRaw;
      }
      throw new Error(`unexpected readContract ${parameters.functionName}`);
    },
    getBalance: async () => {
      if (options.nativeReadFails === true) throw new Error("native read failed");
      return nativeWei;
    },
    estimateGas: async (parameters) => {
      if (options.estimateFails === true) throw new Error("execution reverted: allowance");
      const blocked = options.estimateFailsForTargets ?? [];
      if (blocked.some((target) => target.toLowerCase() === parameters.to.toLowerCase())) {
        throw new Error("execution reverted: allowance");
      }
      return gasEstimate;
    },
    estimateFeesPerGas: async () =>
      options.feesPerGas === undefined ? { gasPrice } : { ...options.feesPerGas },
    getGasPrice: async () => gasPrice,
    getTransactionCount: async () => options.nonce ?? 0,
  };
}
