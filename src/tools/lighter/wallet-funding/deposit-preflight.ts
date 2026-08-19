/**
 * Read-only, environment-scoped preflight for a wallet-funded Lighter deposit.
 *
 * Preparation binds the selected wallet and exact settlement amount to live EVM
 * balances, allowance, contract identity, current fee evidence, exact calldata,
 * and independent Lighter metadata. This module owns no signer and cannot submit
 * a transaction.
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
import { gasLimitWithHeadroom } from "../../evm-chains/gas-limit-headroom.js";
import { getUniswapDeployment } from "../../uniswap/deployments.js";
import { getUniswapPublicClient } from "../../uniswap/evm-client.js";
import {
  getConfiguredLocalChainRpcUrl,
  getLocalChain,
} from "../../evm-chains/registry.js";
import { getLighterClient } from "../client.js";
import type { LighterEnvironment } from "../constants.js";
import type {
  LighterAssetDetailsResponse,
  LighterInfoResponse,
  LighterLayer1BasicInfoResponse,
} from "../types.js";
import { buildLighterDepositCalldata } from "./deposit-calldata.js";
import {
  getLighterFundingDeployment,
  type LighterSettlementSymbol,
} from "./deployments.js";
import { decimalToBaseUnits } from "./onboarding-plan.js";

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
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const LIGHTER_GATEWAY_IDENTITY_ABI = [
  {
    type: "function",
    name: "tokenToAssetIndex",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint16" }],
  },
] as const;

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const MAX_BLOCK_AGE_SECONDS = 5n * 60n;
const MAX_BLOCK_FUTURE_SKEW_SECONDS = 60n;

/** Permanent compile-time boundary used before privileged execution. */
export const LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE = true;

export function isLighterDepositFeePreflightComplete(): boolean {
  return LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE;
}

export interface LighterDepositPreflightSnapshot {
  readonly observedAt: Date;
  readonly environment: LighterEnvironment;
  readonly lighterRestBaseUrl: string;
  readonly settlementNetworkName: string;
  readonly walletAddress: string;
  readonly beneficiaryAddress: string;
  readonly chainId: number;
  readonly settlementBlockNumber: string;
  /** Compatibility field retained for the existing durable Core schema. */
  readonly ethereumBlockNumber: string;
  readonly lighterBlockNumber: string;
  readonly gatewayAddress: string;
  readonly gatewayImplementationAddress: string | null;
  readonly gatewayCodeHash: string;
  readonly settlementTokenAddress: string;
  readonly settlementTokenImplementationAddress: string | null;
  readonly settlementTokenCodeHash: string;
  readonly settlementTokenSymbol: LighterSettlementSymbol;
  readonly settlementTokenDecimals: number;
  readonly assetIndex: number;
  readonly routeType: number;
  readonly amountUnits: string;
  readonly minimumTransferUnits: string;
  readonly depositCalldata: Hex;
  readonly depositValueWei: "0";
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
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly requestedAmountUnits: bigint;
  readonly routeType: number;
  readonly settlementChain: {
    readonly chainId: number;
    readonly blockNumber: bigint;
    readonly blockTimestampSeconds: bigint;
    readonly settlementBalanceUnits: bigint;
    readonly settlementAllowanceUnits: bigint;
    readonly nativeBalanceWei: bigint;
    readonly gatewayCode: Hex | undefined;
    readonly settlementTokenCode: Hex | undefined;
    readonly gatewayImplementationAddress: string | null;
    readonly settlementTokenImplementationAddress: string | null;
    readonly settlementTokenSymbol: string;
    readonly settlementTokenDecimals: number;
    readonly gatewaySettlementAssetIndex: number;
    readonly depositSimulationSucceeded: boolean;
    readonly approveGasEstimate: bigint;
    readonly depositGasEstimate: bigint;
    readonly maxFeePerGasWei: bigint;
    readonly maxPriorityFeePerGasWei: bigint;
  };
  readonly lighterInfo: LighterInfoResponse;
  readonly lighterLayer1: LighterLayer1BasicInfoResponse;
  readonly lighterAssets: LighterAssetDetailsResponse;
}

/** Read and validate a complete non-signing preparation snapshot. */
export async function readLighterDepositPreflight(input: {
  readonly environment?: LighterEnvironment;
  readonly walletAddress: string;
  readonly amountUnits: bigint;
  readonly routeType?: number;
  /** Signer boundary may supply its already-bound client to eliminate RPC rotation. */
  readonly publicClient?: ReturnType<typeof getUniswapPublicClient>;
}): Promise<LighterDepositPreflightSnapshot> {
  const environment = input.environment ?? "core";
  const funding = getLighterFundingDeployment(environment);
  const chainDeployment = getUniswapDeployment(funding.settlementChainId);
  if (chainDeployment === undefined) {
    throw preflightError(`${funding.settlementNetworkName} is not configured for Lighter deposits.`);
  }
  if (environment === "rhc") {
    const localChain = getLocalChain(funding.settlementChainId);
    if (
      localChain === undefined
      || getConfiguredLocalChainRpcUrl(localChain) === null
    ) {
      throw preflightError(
        "Robinhood Chain Lighter funding requires an explicitly configured production-capable RPC; the bundled public rate-limited endpoint is identity-read fallback only.",
      );
    }
  }

  const publicClient = input.publicClient ?? getUniswapPublicClient(chainDeployment);
  const lighter = getLighterClient();
  const walletAddress = getAddress(input.walletAddress);
  const gatewayAddress = funding.gatewayProxy;
  const tokenAddress = funding.settlementTokenProxy;

  try {
    const [
      chainId,
      latestBlock,
      settlementBalanceUnits,
      settlementAllowanceUnits,
      nativeBalanceWei,
      gatewayCode,
      settlementTokenCode,
      gatewayImplementationAddress,
      settlementTokenImplementationAddress,
      settlementTokenSymbol,
      settlementTokenDecimals,
      gatewaySettlementAssetIndex,
      lighterInfo,
      lighterLayer1,
      lighterAssets,
    ] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest", includeTransactions: false }),
      publicClient.readContract({ address: tokenAddress, abi: ERC20_PREFLIGHT_ABI, functionName: "balanceOf", args: [walletAddress] }),
      publicClient.readContract({ address: tokenAddress, abi: ERC20_PREFLIGHT_ABI, functionName: "allowance", args: [walletAddress, gatewayAddress] }),
      publicClient.getBalance({ address: walletAddress }),
      publicClient.getBytecode({ address: gatewayAddress }),
      publicClient.getBytecode({ address: tokenAddress }),
      funding.expectedGatewayImplementation === undefined
        ? Promise.resolve(null)
        : readProxyImplementation(publicClient, gatewayAddress),
      funding.expectedSettlementTokenImplementation === undefined
        ? Promise.resolve(null)
        : readProxyImplementation(publicClient, tokenAddress),
      publicClient.readContract({ address: tokenAddress, abi: ERC20_PREFLIGHT_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: tokenAddress, abi: ERC20_PREFLIGHT_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: gatewayAddress, abi: LIGHTER_GATEWAY_IDENTITY_ABI, functionName: "tokenToAssetIndex", args: [tokenAddress] }),
      lighter.getInfo(environment),
      lighter.getLayer1BasicInfo(environment),
      lighter.getAssetDetails(environment),
    ]);

    const feeEvidence = await readLighterDepositFeeEvidence({
      environment,
      publicClient,
      walletAddress,
      gatewayAddress,
      tokenAddress,
      allowanceStorageSlot: funding.settlementAllowanceStorageSlot,
      amountUnits: input.amountUnits,
      settlementAllowanceUnits,
    });

    return proveLighterDepositPreflight({
      observedAt: new Date(),
      environment,
      walletAddress,
      requestedAmountUnits: input.amountUnits,
      routeType: input.routeType ?? funding.perpsRouteType,
      settlementChain: {
        chainId,
        blockNumber: latestBlock.number,
        blockTimestampSeconds: latestBlock.timestamp,
        settlementBalanceUnits,
        settlementAllowanceUnits,
        nativeBalanceWei,
        gatewayCode,
        settlementTokenCode,
        gatewayImplementationAddress,
        settlementTokenImplementationAddress,
        settlementTokenSymbol,
        settlementTokenDecimals,
        gatewaySettlementAssetIndex,
        ...feeEvidence,
      },
      lighterInfo,
      lighterLayer1,
      lighterAssets,
    });
  } catch (error) {
    if (error instanceof VexError && error.code === ErrorCodes.LIGHTER_INVALID_REQUEST) throw error;
    throw preflightError(`Live ${funding.settlementNetworkName} deposit preflight failed before any approval or signing.`);
  }
}

/** Fail closed unless live settlement-chain and Lighter identities agree exactly. */
export function proveLighterDepositPreflight(
  evidence: LighterDepositPreflightEvidence,
): LighterDepositPreflightSnapshot {
  const funding = getLighterFundingDeployment(evidence.environment);
  const walletAddress = validAddress(evidence.walletAddress, "selected wallet");
  if (!Number.isFinite(evidence.observedAt.getTime())) throw preflightError("The Lighter deposit preflight observation time is invalid.");
  if (evidence.requestedAmountUnits <= 0n) throw preflightError("The Lighter deposit amount must be positive.");
  if (evidence.routeType !== funding.perpsRouteType) throw preflightError("This release prepares only Lighter perps deposits.");
  if (evidence.settlementChain.chainId !== funding.settlementChainId) throw preflightError(`The live wallet RPC is not ${funding.settlementNetworkName}.`);
  if (evidence.settlementChain.blockNumber <= 0n) throw preflightError(`${funding.settlementNetworkName} did not return a usable latest block.`);
  assertFreshBlock(evidence.observedAt, evidence.settlementChain.blockTimestampSeconds, funding.settlementNetworkName);
  if (evidence.settlementChain.settlementBalanceUnits < 0n || evidence.settlementChain.settlementAllowanceUnits < 0n || evidence.settlementChain.nativeBalanceWei < 0n) {
    throw preflightError("The settlement chain returned an invalid negative balance or allowance.");
  }

  const gatewayCode = requireCode(evidence.settlementChain.gatewayCode, "Lighter gateway");
  const tokenCode = requireCode(evidence.settlementChain.settlementTokenCode, funding.settlementSymbol);
  const gatewayImplementationAddress = validateImplementation(
    evidence.settlementChain.gatewayImplementationAddress,
    funding.expectedGatewayImplementation,
    "Lighter gateway",
  );
  const settlementTokenImplementationAddress = validateImplementation(
    evidence.settlementChain.settlementTokenImplementationAddress,
    funding.expectedSettlementTokenImplementation,
    funding.settlementSymbol,
  );
  if (evidence.settlementChain.settlementTokenSymbol !== funding.settlementSymbol) throw preflightError(`On-chain settlement symbol is not ${funding.settlementSymbol}.`);
  if (evidence.settlementChain.settlementTokenDecimals !== funding.settlementDecimals) throw preflightError(`On-chain ${funding.settlementSymbol} decimals differ from Vex's verified deployment.`);
  if (evidence.settlementChain.gatewaySettlementAssetIndex !== funding.settlementAssetIndex) throw preflightError(`The Lighter gateway does not map ${funding.settlementSymbol} to the verified asset index.`);
  if (!evidence.settlementChain.depositSimulationSucceeded) throw preflightError("The exact Lighter deposit calldata simulation did not succeed.");

  if (!evidence.lighterLayer1.l1_providers_health || evidence.lighterLayer1.code !== 200) throw preflightError("Lighter reports unhealthy L1 provider infrastructure.");
  const providers = evidence.lighterLayer1.l1_providers.filter((provider) => provider.chainId === funding.settlementChainId);
  const provider = providers[0];
  if (providers.length !== 1 || provider === undefined || provider.latestBlockNumber < 0) throw preflightError(`Lighter did not expose one usable ${funding.settlementNetworkName} provider.`);

  const gatewayRows = evidence.lighterLayer1.contract_addresses.filter((contract) => contract.name.toLowerCase() === "zklightercontract");
  if (gatewayRows.length !== 1 || gatewayRows[0] === undefined) throw preflightError("Lighter did not expose exactly one ZkLighter gateway address.");
  const gatewayAddress = validAddress(gatewayRows[0].address, "Lighter gateway");
  if (gatewayAddress !== funding.gatewayProxy) throw preflightError("Lighter's live gateway address differs from Vex's verified gateway.");
  const infoGatewayAddress = validAddress(evidence.lighterInfo.contract_address, "Lighter info gateway");
  if (infoGatewayAddress !== funding.gatewayProxy) throw preflightError("Lighter /info disagrees with Vex's verified gateway.");

  const legacyTokenRows = evidence.lighterLayer1.contract_addresses.filter((contract) => contract.name.toLowerCase() === "usdccontract");
  if (legacyTokenRows.length !== 1 || legacyTokenRows[0] === undefined) throw preflightError("Lighter did not expose exactly one legacy settlement-token contract row.");
  const legacyTokenAddress = validAddress(legacyTokenRows[0].address, "Lighter settlement token");
  if (legacyTokenAddress !== funding.settlementTokenProxy) throw preflightError("Lighter's legacy settlement-token field differs from Vex's verified token.");

  if (evidence.lighterAssets.code !== 200) throw preflightError("Lighter asset metadata is unavailable.");
  const assetRows = evidence.lighterAssets.asset_details.filter((asset) => asset.asset_id === funding.settlementAssetIndex);
  const asset = assetRows[0];
  if (assetRows.length !== 1 || asset === undefined) throw preflightError(`Lighter did not expose exactly one ${funding.settlementSymbol} asset-index row.`);
  const tokenAddress = validAddress(asset.l1_address, "Lighter settlement token");
  if (asset.symbol !== funding.settlementSymbol || asset.l1_decimals !== funding.settlementDecimals || asset.decimals !== funding.settlementDecimals || asset.margin_mode !== "enabled" || tokenAddress !== funding.settlementTokenProxy) {
    throw preflightError(`Lighter's live ${funding.settlementSymbol} metadata differs from Vex's verified settlement asset.`);
  }

  let minimumTransferUnits: bigint;
  try {
    minimumTransferUnits = decimalToBaseUnits(asset.min_transfer_amount, funding.settlementDecimals);
  } catch {
    throw preflightError(`Lighter returned an invalid minimum ${funding.settlementSymbol} transfer amount.`);
  }
  if (minimumTransferUnits !== funding.minimumDepositUnits || evidence.requestedAmountUnits < minimumTransferUnits) {
    throw preflightError(`The requested amount is below or conflicts with Lighter's verified minimum ${funding.settlementSymbol} transfer.`);
  }
  if (evidence.settlementChain.settlementBalanceUnits < evidence.requestedAmountUnits) throw preflightError(`The selected wallet does not have enough ${funding.settlementSymbol} for this deposit.`);
  if (evidence.settlementChain.nativeBalanceWei <= 0n) throw preflightError(`The selected wallet has no ${funding.nativeGasSymbol} for network fees.`);

  const approvalRequired = evidence.settlementChain.settlementAllowanceUnits < evidence.requestedAmountUnits;
  if (evidence.settlementChain.approveGasEstimate < 0n || (approvalRequired && evidence.settlementChain.approveGasEstimate === 0n) || (!approvalRequired && evidence.settlementChain.approveGasEstimate !== 0n) || evidence.settlementChain.depositGasEstimate <= 0n) {
    throw preflightError("The settlement chain returned invalid gas estimates for the required deposit legs.");
  }
  if (evidence.settlementChain.maxFeePerGasWei <= 0n || evidence.settlementChain.maxPriorityFeePerGasWei < 0n || evidence.settlementChain.maxPriorityFeePerGasWei > evidence.settlementChain.maxFeePerGasWei) {
    throw preflightError("The settlement chain returned invalid EIP-1559 fee estimates.");
  }

  const approveGasLimit = approvalRequired ? gasLimitWithHeadroom(evidence.settlementChain.approveGasEstimate) : 0n;
  const depositGasLimit = gasLimitWithHeadroom(evidence.settlementChain.depositGasEstimate);
  const approveMaxFeeWei = approveGasLimit * evidence.settlementChain.maxFeePerGasWei;
  const depositMaxFeeWei = depositGasLimit * evidence.settlementChain.maxFeePerGasWei;
  const totalMaxFeeWei = approveMaxFeeWei + depositMaxFeeWei;
  const nativeReserveWei = approveMaxFeeWei > depositMaxFeeWei ? approveMaxFeeWei : depositMaxFeeWei;
  const requiredNativeBalanceWei = totalMaxFeeWei + nativeReserveWei;
  if (evidence.settlementChain.nativeBalanceWei < requiredNativeBalanceWei) throw preflightError(`The selected wallet does not have enough ${funding.nativeGasSymbol} for maximum network fees plus the safety reserve.`);

  const deposit = buildLighterDepositCalldata({ environment: evidence.environment, to: walletAddress, amountUnits: evidence.requestedAmountUnits, route: "perps", assetIndex: funding.settlementAssetIndex });
  if (deposit.to !== gatewayAddress || deposit.value !== funding.erc20DepositValue) throw preflightError("The exact deposit transaction does not match the verified funding deployment.");

  return {
    observedAt: new Date(evidence.observedAt),
    environment: evidence.environment,
    lighterRestBaseUrl: funding.restBaseUrl,
    settlementNetworkName: funding.settlementNetworkName,
    walletAddress,
    beneficiaryAddress: walletAddress,
    chainId: evidence.settlementChain.chainId,
    settlementBlockNumber: evidence.settlementChain.blockNumber.toString(10),
    ethereumBlockNumber: evidence.settlementChain.blockNumber.toString(10),
    lighterBlockNumber: provider.latestBlockNumber.toString(10),
    gatewayAddress,
    gatewayImplementationAddress,
    gatewayCodeHash: keccak256(gatewayCode),
    settlementTokenAddress: tokenAddress,
    settlementTokenImplementationAddress,
    settlementTokenCodeHash: keccak256(tokenCode),
    settlementTokenSymbol: funding.settlementSymbol,
    settlementTokenDecimals: asset.l1_decimals,
    assetIndex: asset.asset_id,
    routeType: evidence.routeType,
    amountUnits: evidence.requestedAmountUnits.toString(10),
    minimumTransferUnits: minimumTransferUnits.toString(10),
    depositCalldata: deposit.data,
    depositValueWei: "0",
    walletBalanceUnits: evidence.settlementChain.settlementBalanceUnits.toString(10),
    walletAllowanceUnits: evidence.settlementChain.settlementAllowanceUnits.toString(10),
    walletNativeBalanceWei: evidence.settlementChain.nativeBalanceWei.toString(10),
    approvalRequired,
    approveGasLimit: approveGasLimit.toString(10),
    depositGasLimit: depositGasLimit.toString(10),
    maxFeePerGasWei: evidence.settlementChain.maxFeePerGasWei.toString(10),
    maxPriorityFeePerGasWei: evidence.settlementChain.maxPriorityFeePerGasWei.toString(10),
    approveMaxFeeWei: approveMaxFeeWei.toString(10),
    depositMaxFeeWei: depositMaxFeeWei.toString(10),
    totalMaxFeeWei: totalMaxFeeWei.toString(10),
    nativeReserveWei: nativeReserveWei.toString(10),
    requiredNativeBalanceWei: requiredNativeBalanceWei.toString(10),
  };
}

async function readLighterDepositFeeEvidence(input: {
  readonly environment: LighterEnvironment;
  readonly publicClient: PublicClient;
  readonly walletAddress: Address;
  readonly gatewayAddress: Address;
  readonly tokenAddress: Address;
  readonly allowanceStorageSlot: bigint;
  readonly amountUnits: bigint;
  readonly settlementAllowanceUnits: bigint;
}): Promise<Pick<LighterDepositPreflightEvidence["settlementChain"], "depositSimulationSucceeded" | "approveGasEstimate" | "depositGasEstimate" | "maxFeePerGasWei" | "maxPriorityFeePerGasWei">> {
  const approvalRequired = input.settlementAllowanceUnits < input.amountUnits;
  const approveData = encodeFunctionData({ abi: ERC20_PREFLIGHT_ABI, functionName: "approve", args: [input.gatewayAddress, input.amountUnits] });
  const deposit = buildLighterDepositCalldata({ environment: input.environment, to: input.walletAddress, amountUnits: input.amountUnits, route: "perps" });
  const stateOverride = approvalRequired
    ? allowanceStateOverride(input.tokenAddress, input.walletAddress, input.gatewayAddress, input.amountUnits, input.allowanceStorageSlot)
    : undefined;

  if (stateOverride !== undefined) {
    const overriddenAllowance = await input.publicClient.readContract({
      address: input.tokenAddress,
      abi: ERC20_PREFLIGHT_ABI,
      functionName: "allowance",
      args: [input.walletAddress, input.gatewayAddress],
      stateOverride,
    });
    if (overriddenAllowance !== input.amountUnits) throw preflightError("The settlement RPC did not reproduce the exact requested allowance state override.");
  }

  const [fees, approveGasEstimate, depositGasEstimate] = await Promise.all([
    input.publicClient.estimateFeesPerGas({ chain: input.publicClient.chain, type: "eip1559" }),
    approvalRequired
      ? input.publicClient.estimateGas({ account: input.walletAddress, to: input.tokenAddress, data: approveData, value: 0n })
      : Promise.resolve(0n),
    input.publicClient.estimateGas({ account: input.walletAddress, to: deposit.to, data: deposit.data, value: deposit.value, ...(stateOverride === undefined ? {} : { stateOverride }) }),
  ]);
  await input.publicClient.call({ account: input.walletAddress, to: deposit.to, data: deposit.data, value: deposit.value, ...(stateOverride === undefined ? {} : { stateOverride }) });

  return { depositSimulationSucceeded: true, approveGasEstimate, depositGasEstimate, maxFeePerGasWei: fees.maxFeePerGas, maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas };
}

function allowanceStateOverride(tokenAddress: Address, owner: Address, spender: Address, amountUnits: bigint, allowanceStorageSlot: bigint): StateOverride {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [owner, allowanceStorageSlot]));
  const slot = keccak256(encodeAbiParameters(parseAbiParameters("address, bytes32"), [spender, inner]));
  const value = pad(toHex(amountUnits), { size: 32 }) as Hex;
  return [{ address: tokenAddress, stateDiff: [{ slot, value }] }];
}

async function readProxyImplementation(publicClient: PublicClient, proxy: Address): Promise<Address | null> {
  const stored = await publicClient.getStorageAt({ address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT });
  if (stored === undefined || /^0x0{64}$/i.test(stored)) return null;
  return getAddress(`0x${stored.slice(-40)}`);
}

function validateImplementation(observed: string | null, expected: Address | undefined, label: string): string | null {
  if (expected === undefined) return observed === null ? null : validAddress(observed, `${label} implementation`);
  if (observed === null) throw preflightError(`${label} proxy implementation is unavailable.`);
  const address = validAddress(observed, `${label} implementation`);
  if (address !== expected) throw preflightError(`${label} proxy implementation differs from Vex's reviewed target.`);
  return address;
}

function requireCode(value: Hex | undefined, label: string): Hex {
  if (value === undefined || value === "0x" || /^0x0+$/i.test(value)) throw preflightError(`${label} has no deployed bytecode.`);
  return value;
}

function assertFreshBlock(observedAt: Date, timestampSeconds: bigint, networkName: string): void {
  if (timestampSeconds <= 0n) throw preflightError(`${networkName} returned an invalid latest-block timestamp.`);
  const observedSeconds = BigInt(Math.floor(observedAt.getTime() / 1_000));
  if (timestampSeconds > observedSeconds + MAX_BLOCK_FUTURE_SKEW_SECONDS) throw preflightError(`${networkName} returned a future latest block.`);
  if (observedSeconds - timestampSeconds > MAX_BLOCK_AGE_SECONDS) throw preflightError(`${networkName} latest block is stale.`);
}

function validAddress(value: string, field: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw preflightError(`Lighter deposit preflight received an invalid ${field} address.`);
  }
}

function preflightError(message: string): VexError {
  return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, message, "No approval was prepared. Refresh live Lighter onboarding status and try again.");
}
