import { createHash } from "node:crypto";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import { gasLimitWithHeadroom } from "../../evm-chains/gas-limit-headroom.js";
import { LIGHTER_CORE_WITHDRAW_GATEWAY_ABI } from "./core-preflight.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const MAX_BLOCK_AGE_SECONDS = 5n * 60n;
const MAX_BLOCK_FUTURE_SKEW_SECONDS = 60n;
const CLAIM_PREVIEW_TTL_MS = 3 * 60_000;
const CLAIM_FEE_CEILING_MULTIPLIER = 4n;

export interface LighterCoreClaimIdentity {
  readonly kind: "lighter_core_manual_usdc_claim";
  readonly version: "lighter-core-manual-claim-v1";
  readonly sessionId: string;
  readonly withdrawalIntentId: string;
  readonly settlementChainId: "1";
  readonly walletAddress: Address;
  readonly ownerAddress: Address;
  readonly gatewayAddress: Address;
  readonly gatewayImplementation: Address;
  readonly gatewayCodeHash: Hex;
  readonly settlementTokenAddress: Address;
  readonly settlementTokenCodeHash: Hex;
  readonly assetIndex: "3";
  readonly amountUnits: string;
  readonly calldata: Hex;
  readonly valueWei: "0";
  readonly gasLimit: string;
  readonly feeCeilingPerGasWei: string;
  readonly priorityFeeCeilingWei: string;
  readonly networkFeeCeilingWei: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface LighterCoreClaimPreview {
  readonly previewId: string;
  readonly matchHash: string;
  readonly identity: LighterCoreClaimIdentity;
  readonly snapshot: LighterCoreClaimPreflightSnapshot;
}

export interface LighterCoreClaimPreflightSnapshot {
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly settlementChainId: 1;
  readonly settlementNetworkName: "Ethereum mainnet";
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly walletAddress: Address;
  readonly ownerAddress: Address;
  readonly gatewayAddress: Address;
  readonly gatewayImplementation: Address;
  readonly gatewayCodeHash: Hex;
  readonly settlementTokenAddress: Address;
  readonly settlementTokenCodeHash: Hex;
  readonly assetIndex: 3;
  readonly assetSymbol: "USDC";
  readonly assetDecimals: 6;
  readonly amountUnits: string;
  readonly pendingBalanceUnits: string;
  readonly calldata: Hex;
  readonly valueWei: "0";
  readonly nativeBalanceWei: string;
  readonly gasEstimate: string;
  readonly gasLimit: string;
  readonly quotedMaxFeePerGasWei: string;
  readonly quotedPriorityFeePerGasWei: string;
  readonly feeCeilingPerGasWei: string;
  readonly priorityFeeCeilingWei: string;
  readonly networkFeeCeilingWei: string;
}

export async function readLighterCoreClaimPreflight(input: {
  readonly publicClient: PublicClient;
  readonly walletAddress: string;
  readonly gatewayAddress: string;
  readonly expectedGatewayImplementation: string;
  readonly expectedGatewayCodeHash: string;
  readonly settlementTokenAddress: string;
  readonly expectedSettlementTokenCodeHash: string;
  readonly amountUnits: bigint;
  readonly now?: Date;
}): Promise<LighterCoreClaimPreflightSnapshot> {
  if (input.amountUnits <= 0n || input.amountUnits > (1n << 128n) - 1n) throw invalid("Manual claim amount is outside uint128.");
  const owner = getAddress(input.walletAddress);
  const gateway = getAddress(input.gatewayAddress);
  const token = getAddress(input.settlementTokenAddress);
  const calldata = encodeFunctionData({
    abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
    functionName: "withdrawPendingBalance",
    args: [owner, 3, input.amountUnits],
  });
  const now = input.now ?? new Date();
  const [chainId, block, pending, nativeBalance, gatewayCode, tokenCode, implementation, assetConfig, fees] = await Promise.all([
    input.publicClient.getChainId(),
    input.publicClient.getBlock({ blockTag: "latest", includeTransactions: false }),
    input.publicClient.readContract({ address: gateway, abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI, functionName: "getPendingBalance", args: [owner, 3] }),
    input.publicClient.getBalance({ address: owner }),
    input.publicClient.getBytecode({ address: gateway }),
    input.publicClient.getBytecode({ address: token }),
    readProxyImplementation(input.publicClient, gateway),
    input.publicClient.readContract({ address: gateway, abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI, functionName: "assetConfigs", args: [3] }),
    input.publicClient.estimateFeesPerGas({ chain: input.publicClient.chain, type: "eip1559" }),
  ]);
  if (chainId !== 1) throw invalid("Manual Core claim RPC is not Ethereum mainnet.");
  if (block.hash === null) throw invalid("Ethereum latest block has no canonical hash.");
  assertFreshBlock(block.timestamp, now);
  if (pending !== input.amountUnits) throw invalid("Gateway pending balance no longer equals the exact claim amount.");
  if (gatewayCode === undefined || tokenCode === undefined) throw invalid("Reviewed gateway or USDC bytecode is unavailable.");
  if (keccak256(gatewayCode).toLowerCase() !== input.expectedGatewayCodeHash.toLowerCase()) throw invalid("Core gateway code identity changed.");
  if (keccak256(tokenCode).toLowerCase() !== input.expectedSettlementTokenCodeHash.toLowerCase()) throw invalid("Ethereum USDC code identity changed.");
  if (implementation === null || implementation !== getAddress(input.expectedGatewayImplementation)) throw invalid("Core gateway implementation changed.");
  if (getAddress(assetConfig[0]) !== token || assetConfig[1] !== 1) throw invalid("Core gateway asset 3 no longer maps to enabled Ethereum USDC.");
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw invalid("Ethereum EIP-1559 fee estimate is inconsistent.");
  }
  await input.publicClient.simulateContract({
    account: owner,
    address: gateway,
    abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
    functionName: "withdrawPendingBalance",
    args: [owner, 3, input.amountUnits],
  });
  const gasEstimate = await input.publicClient.estimateGas({ account: owner, to: gateway, data: calldata, value: 0n });
  if (gasEstimate <= 0n) throw invalid("Ethereum manual claim gas estimate is invalid.");
  const gasLimit = gasLimitWithHeadroom(gasEstimate);
  const feeCeilingPerGas = fees.maxFeePerGas * CLAIM_FEE_CEILING_MULTIPLIER;
  const priorityFeeCeiling = fees.maxPriorityFeePerGas * CLAIM_FEE_CEILING_MULTIPLIER;
  const networkFeeCeiling = gasLimit * feeCeilingPerGas;
  if (nativeBalance < networkFeeCeiling) throw invalid("The selected wallet does not have enough ETH for the disclosed manual-claim fee ceiling.");
  const observedAt = now.toISOString();
  return {
    observedAt,
    expiresAt: new Date(now.getTime() + CLAIM_PREVIEW_TTL_MS).toISOString(),
    settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet",
    blockNumber: block.number.toString(10),
    blockHash: block.hash,
    walletAddress: owner,
    ownerAddress: owner,
    gatewayAddress: gateway,
    gatewayImplementation: implementation,
    gatewayCodeHash: keccak256(gatewayCode),
    settlementTokenAddress: token,
    settlementTokenCodeHash: keccak256(tokenCode),
    assetIndex: 3,
    assetSymbol: "USDC",
    assetDecimals: 6,
    amountUnits: input.amountUnits.toString(10),
    pendingBalanceUnits: pending.toString(10),
    calldata,
    valueWei: "0",
    nativeBalanceWei: nativeBalance.toString(10),
    gasEstimate: gasEstimate.toString(10),
    gasLimit: gasLimit.toString(10),
    quotedMaxFeePerGasWei: fees.maxFeePerGas.toString(10),
    quotedPriorityFeePerGasWei: fees.maxPriorityFeePerGas.toString(10),
    feeCeilingPerGasWei: feeCeilingPerGas.toString(10),
    priorityFeeCeilingWei: priorityFeeCeiling.toString(10),
    networkFeeCeilingWei: networkFeeCeiling.toString(10),
  };
}

export function buildLighterCoreClaimPreview(input: {
  readonly sessionId: string;
  readonly withdrawalIntentId: string;
  readonly snapshot: LighterCoreClaimPreflightSnapshot;
}): LighterCoreClaimPreview {
  const identity: LighterCoreClaimIdentity = {
    kind: "lighter_core_manual_usdc_claim",
    version: "lighter-core-manual-claim-v1",
    sessionId: bounded(input.sessionId, "session id"),
    withdrawalIntentId: bounded(input.withdrawalIntentId, "withdrawal intent id"),
    settlementChainId: "1",
    walletAddress: input.snapshot.walletAddress,
    ownerAddress: input.snapshot.ownerAddress,
    gatewayAddress: input.snapshot.gatewayAddress,
    gatewayImplementation: input.snapshot.gatewayImplementation,
    gatewayCodeHash: input.snapshot.gatewayCodeHash,
    settlementTokenAddress: input.snapshot.settlementTokenAddress,
    settlementTokenCodeHash: input.snapshot.settlementTokenCodeHash,
    assetIndex: "3",
    amountUnits: input.snapshot.amountUnits,
    calldata: input.snapshot.calldata,
    valueWei: "0",
    gasLimit: input.snapshot.gasLimit,
    feeCeilingPerGasWei: input.snapshot.feeCeilingPerGasWei,
    priorityFeeCeilingWei: input.snapshot.priorityFeeCeilingWei,
    networkFeeCeilingWei: input.snapshot.networkFeeCeilingWei,
    observedAt: input.snapshot.observedAt,
    expiresAt: input.snapshot.expiresAt,
  };
  const matchHash = createHash("sha256").update(JSON.stringify(Object.values(identity))).digest("hex");
  return { previewId: `lwcp_${matchHash.slice(0, 24)}`, matchHash, identity, snapshot: input.snapshot };
}

export function assertLighterCoreClaimPreflightWithinApproval(
  approved: LighterCoreClaimPreflightSnapshot,
  fresh: LighterCoreClaimPreflightSnapshot,
): void {
  const fixed = [
    "settlementChainId", "walletAddress", "ownerAddress", "gatewayAddress", "gatewayImplementation",
    "gatewayCodeHash", "settlementTokenAddress", "settlementTokenCodeHash", "assetIndex", "amountUnits",
    "pendingBalanceUnits", "calldata", "valueWei",
  ] as const;
  for (const key of fixed) if (fresh[key] !== approved[key]) throw invalid(`Manual claim ${key} changed after approval.`);
  if (
    BigInt(fresh.gasLimit) > BigInt(approved.gasLimit)
    || BigInt(fresh.quotedMaxFeePerGasWei) > BigInt(approved.feeCeilingPerGasWei)
    || BigInt(fresh.quotedPriorityFeePerGasWei) > BigInt(approved.priorityFeeCeilingWei)
    || BigInt(fresh.gasLimit) * BigInt(fresh.quotedMaxFeePerGasWei) > BigInt(approved.networkFeeCeilingWei)
  ) throw invalid("Fresh Ethereum fees exceed the separately approved manual-claim ceiling.");
}

async function readProxyImplementation(publicClient: PublicClient, proxy: Address): Promise<Address | null> {
  const stored = await publicClient.getStorageAt({ address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT });
  return stored === undefined || /^0x0{64}$/i.test(stored) ? null : getAddress(`0x${stored.slice(-40)}`);
}

function assertFreshBlock(timestamp: bigint, now: Date): void {
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1_000));
  if (timestamp < nowSeconds - MAX_BLOCK_AGE_SECONDS || timestamp > nowSeconds + MAX_BLOCK_FUTURE_SKEW_SECONDS) {
    throw invalid("Ethereum latest block is stale or future-dated.");
  }
}

function bounded(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) throw invalid(`Manual claim ${field} is invalid.`);
  return trimmed;
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No wallet transaction was signed or submitted. Reconcile the withdrawal and prepare a fresh manual claim.",
  );
}
