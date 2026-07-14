/**
 * Hyperliquid Bridge2 native-USDC funding on Arbitrum One.
 *
 * This is deliberately a plain ERC-20 `transfer`, not a HyperCore action:
 * Bridge2 credits the EVM sender's own Hyperliquid account. Signing stays in
 * the repo-native Uniswap EVM client factory; this module owns only the
 * pinned recipient, preflight, and post-broadcast receipt confirmation.
 */

import { getAddress, parseUnits, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

import { ERC20_ABI } from "../../constants/chain.js";
import { ErrorCodes, VexError } from "../../errors.js";
import { ensureErc20Balance } from "../evm-chains/erc20-balance-guard.js";
import { waitForSuccessfulReceipt } from "../evm-chains/receipt-guard.js";
import { resolveUniswapDeployment } from "../uniswap/chains.js";
import { getUniswapEvmClients } from "../uniswap/evm-client.js";
import {
  ARBITRUM_NATIVE_USDC_ADDRESS,
  ARBITRUM_ONE_CHAIN_ID,
  HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS,
  HYPERLIQUID_BRIDGE2_MIN_DEPOSIT_USDC,
  type HyperliquidNetwork,
} from "./constants.js";
import { parseDecimalString } from "./validation.js";

export interface HyperliquidBridge2DepositClients {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
}

export interface HyperliquidBridge2DepositInput {
  readonly network: HyperliquidNetwork;
  readonly amountUsd: string;
  readonly owner: Address;
}

export interface HyperliquidBridge2DepositResult {
  readonly amountBaseUnits: bigint;
  readonly txHash: Hex;
}

/** Reject testnet rather than guessing an unrelated Bridge2 address. */
export function assertHyperliquidBridge2Mainnet(network: HyperliquidNetwork): void {
  if (network !== "mainnet") {
    throw new VexError(
      ErrorCodes.HYPERLIQUID_DEPOSIT_FAILED,
      "Hyperliquid deposits are mainnet-only. The testnet Bridge2 address is intentionally unsupported.",
    );
  }
}

/** Parse native USDC exactly and block the venue's irreversible sub-$5 floor. */
export function parseHyperliquidBridge2DepositAmount(amountUsd: string): bigint {
  const amount = parseDecimalString(amountUsd);
  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = parseUnits(amount, 6);
  } catch {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "amountUsd must be a native-USDC decimal with no more than 6 decimal places.",
    );
  }
  const minimum = parseUnits(HYPERLIQUID_BRIDGE2_MIN_DEPOSIT_USDC, 6);
  if (amountBaseUnits < minimum) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "Hyperliquid deposits below 5 USDC are permanently lost and will not be credited.",
      "Deposit at least 5 USDC of native Arbitrum USDC.",
    );
  }
  return amountBaseUnits;
}

/**
 * Build the established Arbitrum One EVM clients used by direct ERC-20
 * protocol actions. The Uniswap deployment registry provides the verified
 * chain/RPC configuration; this function never resolves wallet material.
 */
export function getHyperliquidBridge2DepositClients(
  privateKey: Hex,
): HyperliquidBridge2DepositClients {
  const deployment = resolveUniswapDeployment("arbitrum");
  if (!deployment || deployment.chainId !== ARBITRUM_ONE_CHAIN_ID) {
    throw new VexError(
      ErrorCodes.HYPERLIQUID_DEPOSIT_FAILED,
      "Arbitrum One is unavailable for the Hyperliquid Bridge2 deposit.",
    );
  }
  return getUniswapEvmClients(deployment, privateKey);
}

/**
 * Preflight then transfer native USDC to the pinned Bridge2 receiver.
 * `waitForSuccessfulReceipt` treats a mined revert as a hard failure and a
 * confirmation transport failure as unknown, so this operation is never
 * retried automatically after broadcast.
 */
export async function executeHyperliquidBridge2Deposit(
  input: HyperliquidBridge2DepositInput,
  clients: HyperliquidBridge2DepositClients,
): Promise<HyperliquidBridge2DepositResult> {
  assertHyperliquidBridge2Mainnet(input.network);
  const amountBaseUnits = parseHyperliquidBridge2DepositAmount(input.amountUsd);
  const owner = getAddress(input.owner);

  await ensureErc20Balance(clients.publicClient, {
    token: ARBITRUM_NATIVE_USDC_ADDRESS,
    owner,
    required: amountBaseUnits,
    decimals: 6,
    label: "native USDC",
  });

  const txHash = await clients.walletClient.writeContract({
    account: clients.walletClient.account,
    address: ARBITRUM_NATIVE_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS, amountBaseUnits],
  });

  await waitForSuccessfulReceipt(clients.publicClient, txHash, {
    code: ErrorCodes.HYPERLIQUID_DEPOSIT_FAILED,
    what: "Hyperliquid Bridge2 deposit transaction",
    hint: "The deposit transfer was not confirmed. Check the transaction hash before retrying.",
  });

  return { amountBaseUnits, txHash };
}
