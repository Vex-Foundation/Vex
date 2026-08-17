/**
 * Read-only Phase 2 preflight for an Ethereum-mainnet Lighter Core deposit.
 *
 * This module binds the selected wallet and requested amount to live Ethereum
 * balances/allowance, exact EIP-1559 fee ceilings, and Lighter's live
 * gateway/asset metadata. It owns no signer and cannot submit a transaction.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import { getUniswapDeployment } from "../../uniswap/deployments.js";
import { getUniswapPublicClient } from "../../uniswap/evm-client.js";
import { getLighterClient } from "../client.js";
import { gasLimitWithHeadroom } from "../../evm-chains/gas-limit-headroom.js";
import type {
  LighterAssetDetailsResponse,
  LighterLayer1BasicInfoResponse,
} from "../types.js";
import { decimalToBaseUnits } from "./onboarding-plan.js";
import { buildLighterDepositCalldata } from "./deposit-calldata.js";
import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
  LIGHTER_DEPOSIT_CHAIN_ID,
  LIGHTER_DEPOSIT_ROUTE_TYPE,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  LIGHTER_USDC_ASSET_INDEX,
} from "./constants.js";

const ERC20_PREFLIGHT_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** FiatTokenV1 allowance mapping slot used by Ethereum mainnet's USDC proxy. */
const ETHEREUM_USDC_ALLOWANCE_STORAGE_SLOT = 10n;

/**
 * Independent compile-time boundary for the unfinished pre-sign enforcement
 * slice. Opening the operator release environment variable cannot bypass it.
 */
export const LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE = false;

/** Runtime accessor used by the privileged handler before it resolves a key. */
export function isLighterDepositFeePreflightComplete(): boolean {
  return LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE;
}

export interface LighterDepositPreflightSnapshot {
  readonly observedAt: Date;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly ethereumBlockNumber: string;
  readonly lighterBlockNumber: string;
  readonly gatewayAddress: string;
  readonly settlementTokenAddress: string;
  readonly settlementTokenSymbol: "USDC";
  readonly settlementTokenDecimals: number;
  readonly assetIndex: number;
  readonly routeType: number;
  readonly amountUnits: string;
  readonly minimumTransferUnits: string;
  readonly walletBalanceUnits: string;
  readonly walletAllowanceUnits: string;
  readonly walletNativeBalanceWei: string;
  readonly approvalRequired: boolean;
  readonly approveGasLimit: string;
  readonly depositGasLimit: string;
  readonly maxFeePerGasWei: string;
  readonly maxPriorityFeePerGasWei: string;
  readonly approveMaxFeeWei: string;
  readonly depositMaxFeeWei: string;
  readonly totalMaxFeeWei: string;
  readonly nativeReserveWei: string;
  readonly requiredNativeBalanceWei: string;
}

export interface LighterDepositPreflightEvidence {
  readonly observedAt: Date;
  readonly walletAddress: string;
  readonly requestedAmountUnits: bigint;
  readonly routeType: number;
  readonly ethereum: {
    readonly chainId: number;
    readonly blockNumber: bigint;
    readonly settlementBalanceUnits: bigint;
    readonly settlementAllowanceUnits: bigint;
    readonly nativeBalanceWei: bigint;
    readonly approveGasEstimate: bigint;
    readonly depositGasEstimate: bigint;
    readonly maxFeePerGasWei: bigint;
    readonly maxPriorityFeePerGasWei: bigint;
  };
  readonly lighterLayer1: LighterLayer1BasicInfoResponse;
  readonly lighterAssets: LighterAssetDetailsResponse;
}

/** Read and validate a complete non-signing preparation snapshot. */
export async function readLighterDepositPreflight(input: {
  readonly walletAddress: string;
  readonly amountUnits: bigint;
  readonly routeType?: number;
}): Promise<LighterDepositPreflightSnapshot> {
  const deployment = getUniswapDeployment(LIGHTER_DEPOSIT_CHAIN_ID);
  if (deployment === undefined) {
    throw preflightError("Ethereum mainnet is not configured for Lighter deposits.");
  }
  const publicClient = getUniswapPublicClient(deployment);
  const lighter = getLighterClient();
  const walletAddress = getAddress(input.walletAddress);
  const gatewayAddress = getAddress(LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS);
  const tokenAddress = getAddress(LIGHTER_CORE_MAINNET_USDC_ADDRESS);

  const [
    chainId,
    blockNumber,
    settlementBalanceUnits,
    settlementAllowanceUnits,
    nativeBalanceWei,
    lighterLayer1,
    lighterAssets,
  ] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber({ cacheTime: 0 }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_PREFLIGHT_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_PREFLIGHT_ABI,
      functionName: "allowance",
      args: [walletAddress, gatewayAddress],
    }),
    publicClient.getBalance({ address: walletAddress }),
    lighter.getLayer1BasicInfo("core"),
    lighter.getAssetDetails("core"),
  ]);

  const feeEvidence = await readLighterDepositFeeEvidence({
    publicClient,
    walletAddress,
    gatewayAddress,
    tokenAddress,
    amountUnits: input.amountUnits,
    settlementAllowanceUnits,
  });

  return proveLighterDepositPreflight({
    observedAt: new Date(),
    walletAddress,
    requestedAmountUnits: input.amountUnits,
    routeType: input.routeType ?? LIGHTER_DEPOSIT_ROUTE_TYPE.perps,
    ethereum: {
      chainId,
      blockNumber,
      settlementBalanceUnits,
      settlementAllowanceUnits,
      nativeBalanceWei,
      ...feeEvidence,
    },
    lighterLayer1,
    lighterAssets,
  });
}

/** Fail closed unless live Ethereum and Lighter metadata agree exactly. */
export function proveLighterDepositPreflight(
  evidence: LighterDepositPreflightEvidence,
): LighterDepositPreflightSnapshot {
  const walletAddress = validAddress(evidence.walletAddress, "selected wallet");
  if (!Number.isFinite(evidence.observedAt.getTime())) {
    throw preflightError("The Lighter deposit preflight observation time is invalid.");
  }
  if (evidence.requestedAmountUnits <= 0n) {
    throw preflightError("The Lighter deposit amount must be positive.");
  }
  if (evidence.routeType !== LIGHTER_DEPOSIT_ROUTE_TYPE.perps) {
    throw preflightError("This release prepares only Lighter perps deposits.");
  }
  if (evidence.ethereum.chainId !== LIGHTER_DEPOSIT_CHAIN_ID) {
    throw preflightError("The live wallet RPC is not Ethereum mainnet.");
  }
  if (evidence.ethereum.blockNumber <= 0n) {
    throw preflightError("Ethereum did not return a usable latest block number.");
  }
  if (
    evidence.ethereum.settlementBalanceUnits < 0n
    || evidence.ethereum.settlementAllowanceUnits < 0n
    || evidence.ethereum.nativeBalanceWei < 0n
  ) {
    throw preflightError("Ethereum returned an invalid negative deposit balance or allowance.");
  }
  if (!evidence.lighterLayer1.l1_providers_health || evidence.lighterLayer1.code !== 200) {
    throw preflightError("Lighter reports unhealthy L1 provider infrastructure.");
  }

  const providers = evidence.lighterLayer1.l1_providers.filter(
    (provider) => provider.chainId === LIGHTER_DEPOSIT_CHAIN_ID,
  );
  const provider = providers[0];
  if (providers.length !== 1 || provider === undefined || provider.latestBlockNumber < 0) {
    throw preflightError("Lighter did not expose one usable Ethereum-mainnet L1 provider.");
  }

  const gatewayRows = evidence.lighterLayer1.contract_addresses.filter(
    (contract) => contract.name.toLowerCase() === "zklightercontract",
  );
  if (gatewayRows.length !== 1) {
    throw preflightError("Lighter did not expose exactly one ZkLighter gateway address.");
  }
  const gateway = gatewayRows[0];
  if (gateway === undefined) {
    throw preflightError("Lighter did not expose a usable ZkLighter gateway address.");
  }
  const gatewayAddress = validAddress(gateway.address, "Lighter gateway");
  if (gatewayAddress !== getAddress(LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS)) {
    throw preflightError("Lighter's live gateway address differs from Vex's verified gateway.");
  }

  if (evidence.lighterAssets.code !== 200) {
    throw preflightError("Lighter asset metadata is unavailable.");
  }
  const assetRows = evidence.lighterAssets.asset_details.filter(
    (asset) => asset.asset_id === LIGHTER_USDC_ASSET_INDEX,
  );
  if (assetRows.length !== 1) {
    throw preflightError("Lighter did not expose exactly one USDC asset-index row.");
  }
  const asset = assetRows[0];
  if (asset === undefined) {
    throw preflightError("Lighter did not expose a usable USDC asset-index row.");
  }
  const tokenAddress = validAddress(asset.l1_address, "Lighter settlement token");
  if (
    asset.symbol.toUpperCase() !== "USDC"
    || asset.l1_decimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS
    || asset.decimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS
    || tokenAddress !== getAddress(LIGHTER_CORE_MAINNET_USDC_ADDRESS)
  ) {
    throw preflightError("Lighter's live USDC metadata differs from Vex's verified settlement asset.");
  }

  let minimumTransferUnits: bigint;
  try {
    minimumTransferUnits = decimalToBaseUnits(
      asset.min_transfer_amount,
      LIGHTER_SETTLEMENT_ASSET_DECIMALS,
    );
  } catch {
    throw preflightError("Lighter returned an invalid minimum USDC transfer amount.");
  }
  if (minimumTransferUnits <= 0n || evidence.requestedAmountUnits < minimumTransferUnits) {
    throw preflightError("The requested amount is below Lighter's live minimum USDC transfer.");
  }
  if (evidence.ethereum.settlementBalanceUnits < evidence.requestedAmountUnits) {
    throw preflightError("The selected wallet does not have enough USDC for this deposit.");
  }
  if (evidence.ethereum.nativeBalanceWei <= 0n) {
    throw preflightError("The selected wallet has no ETH for Ethereum network fees.");
  }

  const approvalRequired = evidence.ethereum.settlementAllowanceUnits < evidence.requestedAmountUnits;
  if (
    evidence.ethereum.approveGasEstimate < 0n
    || (approvalRequired && evidence.ethereum.approveGasEstimate === 0n)
    || (!approvalRequired && evidence.ethereum.approveGasEstimate !== 0n)
    || evidence.ethereum.depositGasEstimate <= 0n
  ) {
    throw preflightError("Ethereum returned invalid gas estimates for the required deposit legs.");
  }
  if (
    evidence.ethereum.maxFeePerGasWei <= 0n
    || evidence.ethereum.maxPriorityFeePerGasWei < 0n
    || evidence.ethereum.maxPriorityFeePerGasWei > evidence.ethereum.maxFeePerGasWei
  ) {
    throw preflightError("Ethereum returned invalid EIP-1559 fee ceilings.");
  }

  const approveGasLimit = approvalRequired
    ? gasLimitWithHeadroom(evidence.ethereum.approveGasEstimate)
    : 0n;
  const depositGasLimit = gasLimitWithHeadroom(evidence.ethereum.depositGasEstimate);
  const approveMaxFeeWei = approveGasLimit * evidence.ethereum.maxFeePerGasWei;
  const depositMaxFeeWei = depositGasLimit * evidence.ethereum.maxFeePerGasWei;
  const totalMaxFeeWei = approveMaxFeeWei + depositMaxFeeWei;
  // Keep enough ETH beyond this plan's maximum for one comparable follow-up
  // transaction. This reserve is explicit and approval-visible.
  const nativeReserveWei = approveMaxFeeWei > depositMaxFeeWei
    ? approveMaxFeeWei
    : depositMaxFeeWei;
  const requiredNativeBalanceWei = totalMaxFeeWei + nativeReserveWei;
  if (evidence.ethereum.nativeBalanceWei < requiredNativeBalanceWei) {
    throw preflightError(
      "The selected wallet does not have enough ETH for the maximum network fees plus the safety reserve.",
    );
  }

  return {
    observedAt: new Date(evidence.observedAt),
    walletAddress,
    chainId: evidence.ethereum.chainId,
    ethereumBlockNumber: evidence.ethereum.blockNumber.toString(10),
    lighterBlockNumber: provider.latestBlockNumber.toString(10),
    gatewayAddress,
    settlementTokenAddress: tokenAddress,
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: asset.l1_decimals,
    assetIndex: asset.asset_id,
    routeType: evidence.routeType,
    amountUnits: evidence.requestedAmountUnits.toString(10),
    minimumTransferUnits: minimumTransferUnits.toString(10),
    walletBalanceUnits: evidence.ethereum.settlementBalanceUnits.toString(10),
    walletAllowanceUnits: evidence.ethereum.settlementAllowanceUnits.toString(10),
    walletNativeBalanceWei: evidence.ethereum.nativeBalanceWei.toString(10),
    approvalRequired,
    approveGasLimit: approveGasLimit.toString(10),
    depositGasLimit: depositGasLimit.toString(10),
    maxFeePerGasWei: evidence.ethereum.maxFeePerGasWei.toString(10),
    maxPriorityFeePerGasWei: evidence.ethereum.maxPriorityFeePerGasWei.toString(10),
    approveMaxFeeWei: approveMaxFeeWei.toString(10),
    depositMaxFeeWei: depositMaxFeeWei.toString(10),
    totalMaxFeeWei: totalMaxFeeWei.toString(10),
    nativeReserveWei: nativeReserveWei.toString(10),
    requiredNativeBalanceWei: requiredNativeBalanceWei.toString(10),
  };
}

async function readLighterDepositFeeEvidence(input: {
  readonly publicClient: PublicClient;
  readonly walletAddress: Address;
  readonly gatewayAddress: Address;
  readonly tokenAddress: Address;
  readonly amountUnits: bigint;
  readonly settlementAllowanceUnits: bigint;
}): Promise<Pick<LighterDepositPreflightEvidence["ethereum"],
  | "approveGasEstimate"
  | "depositGasEstimate"
  | "maxFeePerGasWei"
  | "maxPriorityFeePerGasWei"
>> {
  const approvalRequired = input.settlementAllowanceUnits < input.amountUnits;
  const approveData = encodeFunctionData({
    abi: ERC20_PREFLIGHT_ABI,
    functionName: "approve",
    args: [input.gatewayAddress, input.amountUnits],
  });
  const deposit = buildLighterDepositCalldata({
    to: input.walletAddress,
    amountUnits: input.amountUnits,
    route: "perps",
    assetIndex: LIGHTER_USDC_ASSET_INDEX,
  });
  const stateOverride = approvalRequired
    ? usdcAllowanceStateOverride(
        input.tokenAddress,
        input.walletAddress,
        input.gatewayAddress,
        input.amountUnits,
      )
    : undefined;

  if (stateOverride !== undefined) {
    const overriddenAllowance = await input.publicClient.readContract({
      address: input.tokenAddress,
      abi: ERC20_PREFLIGHT_ABI,
      functionName: "allowance",
      args: [input.walletAddress, input.gatewayAddress],
      stateOverride,
    });
    if (overriddenAllowance !== input.amountUnits) {
      throw preflightError(
        "Ethereum USDC allowance simulation did not reproduce the exact requested approval.",
      );
    }
  }

  const [fees, approveGasEstimate, depositGasEstimate] = await Promise.all([
    input.publicClient.estimateFeesPerGas({
      chain: input.publicClient.chain,
      type: "eip1559",
    }),
    approvalRequired
      ? input.publicClient.estimateGas({
          account: input.walletAddress,
          to: input.tokenAddress,
          data: approveData,
          value: 0n,
        })
      : Promise.resolve(0n),
    input.publicClient.estimateGas({
      account: input.walletAddress,
      to: deposit.to,
      data: deposit.data,
      value: deposit.value,
      ...(stateOverride === undefined ? {} : { stateOverride }),
    }),
  ]);

  return {
    approveGasEstimate,
    depositGasEstimate,
    maxFeePerGasWei: fees.maxFeePerGas,
    maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas,
  };
}

function usdcAllowanceStateOverride(
  tokenAddress: Address,
  owner: Address,
  spender: Address,
  amountUnits: bigint,
): StateOverride {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [
    owner,
    ETHEREUM_USDC_ALLOWANCE_STORAGE_SLOT,
  ]));
  const slot = keccak256(encodeAbiParameters(parseAbiParameters("address, bytes32"), [
    spender,
    inner,
  ]));
  const value = pad(toHex(amountUnits), { size: 32 }) as Hex;
  return [{ address: tokenAddress, stateDiff: [{ slot, value }] }];
}

function validAddress(value: string, field: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw preflightError(`Lighter deposit preflight received an invalid ${field} address.`);
  }
}

function preflightError(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No approval was prepared. Refresh live Lighter onboarding status and try again.",
  );
}
