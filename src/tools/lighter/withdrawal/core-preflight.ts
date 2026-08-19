import {
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import type {
  LighterClient,
  LighterPrivilegedAccountAuth,
} from "../client.js";
import type {
  LighterAccountResponse,
  LighterApiKeysResponse,
  LighterAssetDetailsResponse,
  LighterNextNonceResponse,
  LighterWithdrawHistoryItem,
  LighterWithdrawalDelayResponse,
} from "../types.js";
import { decimalToBaseUnits } from "../wallet-funding/onboarding-plan.js";
import { getLighterFundingDeployment } from "../wallet-funding/deployments.js";

export const LIGHTER_CORE_WITHDRAW_TX_TYPE = 13 as const;
export const LIGHTER_CORE_WITHDRAW_ROUTE_TYPE = 0 as const;
export const LIGHTER_CORE_WITHDRAW_ASSET_INDEX = 3 as const;
export const LIGHTER_CORE_WITHDRAW_DECIMALS = 6 as const;
export const LIGHTER_CORE_WITHDRAW_PREVIEW_TTL_MS = 5 * 60 * 1_000;

const MAX_HISTORY_PAGES = 50;
const MAX_BLOCK_AGE_SECONDS = 5n * 60n;
const MAX_BLOCK_FUTURE_SKEW_SECONDS = 60n;
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export const LIGHTER_CORE_WITHDRAW_GATEWAY_ABI = [
  {
    type: "function",
    name: "assetConfigs",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint16" }],
    outputs: [
      { name: "tokenAddress", type: "address" },
      { name: "withdrawalsEnabled", type: "uint8" },
      { name: "extensionMultiplier", type: "uint56" },
      { name: "tickSize", type: "uint128" },
      { name: "depositCapTicks", type: "uint64" },
      { name: "minDepositTicks", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "getPendingBalance",
    stateMutability: "view",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_assetIndex", type: "uint16" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getPendingBalanceLegacy",
    stateMutability: "view",
    inputs: [{ name: "_owner", type: "address" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "withdrawPendingBalance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_baseAmount", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawPendingBalanceLegacy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_baseAmount", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "WithdrawPending",
    anonymous: false,
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "assetIndex", type: "uint16", indexed: false },
      { name: "baseAmount", type: "uint128", indexed: false },
    ],
  },
] as const;

export const LIGHTER_CORE_WITHDRAW_ERC20_ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface LighterCoreWithdrawalPreflightSnapshot {
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly environment: "core";
  readonly operationClass: "secure_l2_withdrawal";
  readonly endpoint: string;
  readonly signingChainId: 304;
  readonly settlementChainId: 1;
  readonly settlementNetworkName: "Ethereum mainnet";
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly walletAddress: Address;
  readonly destinationAddress: Address;
  readonly assetIndex: 3;
  readonly assetSymbol: "USDC";
  readonly assetDecimals: 6;
  readonly settlementTokenAddress: Address;
  readonly routeType: 0;
  readonly amountUnits: string;
  readonly minimumWithdrawalUnits: string;
  readonly availableBalanceUnits: string;
  readonly collateralUnits: string;
  readonly initialMarginRequirementUnits: string;
  readonly maintenanceMarginRequirementUnits: string;
  readonly pendingOrderCount: number;
  readonly openPositionCount: number;
  readonly activeOrderCount: number;
  readonly nextNonce: string;
  readonly registeredPublicKey: string;
  readonly keyTransactionTime: string;
  readonly withdrawalDelaySeconds: number;
  readonly delayObservedAt: string;
  readonly gatewayAddress: Address;
  readonly gatewayImplementationAddress: Address;
  readonly gatewayCodeHash: Hex;
  readonly settlementTokenCodeHash: Hex;
  readonly settlementBlockNumber: string;
  readonly pendingBalanceUnits: string;
  readonly legacyPendingBalanceUnits: string;
  readonly withdrawalHistoryCount: number;
  readonly nonterminalWithdrawalCount: 0;
}

export interface LighterCoreWithdrawalPreflightEvidence {
  readonly observedAt: Date;
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly amountUnits: bigint;
  readonly accountByIndex: LighterAccountResponse;
  readonly accountByWallet: LighterAccountResponse;
  readonly apiKeys: LighterApiKeysResponse;
  readonly nextNonce: LighterNextNonceResponse;
  readonly assets: LighterAssetDetailsResponse;
  readonly delay: LighterWithdrawalDelayResponse;
  readonly history: readonly LighterWithdrawHistoryItem[];
  readonly activeOrderCount: number;
  readonly settlement: {
    readonly chainId: number;
    readonly blockNumber: bigint;
    readonly blockTimestampSeconds: bigint;
    readonly gatewayCode: Hex | undefined;
    readonly tokenCode: Hex | undefined;
    readonly gatewayImplementationAddress: string | null;
    readonly gatewayAssetConfig: readonly [Address, number, bigint, bigint, bigint, bigint];
    readonly pendingBalanceUnits: bigint;
    readonly legacyPendingBalanceUnits: bigint;
  };
}

export async function readLighterCoreWithdrawalPreflight(input: {
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly amountUnits: bigint;
  readonly client: Pick<
    LighterClient,
    | "getAccount"
    | "getApiKeys"
    | "getNextNonce"
    | "getAssetDetails"
    | "getWithdrawalDelay"
    | "getWithdrawHistory"
    | "getAccountActiveOrders"
  >;
  readonly privilegedAuth: LighterPrivilegedAccountAuth;
  readonly publicClient: PublicClient;
  readonly now?: () => Date;
}): Promise<LighterCoreWithdrawalPreflightSnapshot> {
  const deployment = getLighterFundingDeployment("core");
  const walletAddress = normalizeAddress(input.walletAddress, "selected wallet");
  if (input.privilegedAuth.accountIndex !== input.accountIndex) {
    throw preflightError("The read-only account authorization does not match the selected Core account.");
  }
  const observedAt = input.now?.() ?? new Date();
  const historyPromise = readAllCoreWithdrawalHistory(
    input.client,
    input.accountIndex,
    input.privilegedAuth,
  );

  const [
    accountByIndex,
    accountByWallet,
    apiKeys,
    nextNonce,
    assets,
    delay,
    history,
    activeOrders,
    chainId,
    block,
    gatewayCode,
    tokenCode,
    gatewayImplementationAddress,
    gatewayAssetConfig,
    pendingBalanceUnits,
    legacyPendingBalanceUnits,
  ] = await Promise.all([
    input.client.getAccount("core", { by: "index", value: input.accountIndex }),
    input.client.getAccount("core", { by: "l1_address", value: walletAddress }),
    input.client.getApiKeys("core", {
      accountIndex: input.accountIndex,
      apiKeyIndex: input.apiKeyIndex,
    }),
    input.client.getNextNonce("core", {
      accountIndex: input.accountIndex,
      apiKeyIndex: input.apiKeyIndex,
    }),
    input.client.getAssetDetails("core"),
    input.client.getWithdrawalDelay("core"),
    historyPromise,
    input.client.getAccountActiveOrders(
      "core",
      { accountIndex: input.accountIndex, marketType: "all" },
      input.privilegedAuth,
    ),
    input.publicClient.getChainId(),
    input.publicClient.getBlock({ blockTag: "latest", includeTransactions: false }),
    input.publicClient.getBytecode({ address: deployment.gatewayProxy }),
    input.publicClient.getBytecode({ address: deployment.settlementTokenProxy }),
    readProxyImplementation(input.publicClient, deployment.gatewayProxy),
    input.publicClient.readContract({
      address: deployment.gatewayProxy,
      abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
      functionName: "assetConfigs",
      args: [deployment.settlementAssetIndex],
    }),
    input.publicClient.readContract({
      address: deployment.gatewayProxy,
      abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
      functionName: "getPendingBalance",
      args: [walletAddress, deployment.settlementAssetIndex],
    }),
    input.publicClient.readContract({
      address: deployment.gatewayProxy,
      abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
      functionName: "getPendingBalanceLegacy",
      args: [walletAddress],
    }),
  ]);

  return proveLighterCoreWithdrawalPreflight({
    observedAt,
    walletAddress,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    amountUnits: input.amountUnits,
    accountByIndex,
    accountByWallet,
    apiKeys,
    nextNonce,
    assets,
    delay,
    history,
    activeOrderCount: activeOrders.orders.length,
    settlement: {
      chainId,
      blockNumber: block.number,
      blockTimestampSeconds: block.timestamp,
      gatewayCode,
      tokenCode,
      gatewayImplementationAddress,
      gatewayAssetConfig,
      pendingBalanceUnits,
      legacyPendingBalanceUnits,
    },
  });
}

export function proveLighterCoreWithdrawalPreflight(
  evidence: LighterCoreWithdrawalPreflightEvidence,
): LighterCoreWithdrawalPreflightSnapshot {
  const deployment = getLighterFundingDeployment("core");
  const walletAddress = normalizeAddress(evidence.walletAddress, "selected wallet");
  if (!Number.isFinite(evidence.observedAt.getTime())) throw preflightError("The observation time is invalid.");
  requireSafeIndex(evidence.accountIndex, "account index");
  requireSafeIndex(evidence.apiKeyIndex, "API-key index");
  if (evidence.amountUnits <= 0n) throw preflightError("The withdrawal amount must be positive.");

  const account = uniqueOwnedAccount(evidence.accountByIndex, evidence.accountIndex, walletAddress);
  const walletAccount = uniqueOwnedAccount(evidence.accountByWallet, evidence.accountIndex, walletAddress);
  if ((account.index ?? account.account_index) !== (walletAccount.index ?? walletAccount.account_index)) {
    throw preflightError("Core account lookup by index and wallet did not resolve the same account.");
  }
  if (account.status !== 1) throw preflightError("The selected Core account is not active.");

  const availableBalanceUnits = readAccountAmount(account.available_balance, "available balance");
  const collateralUnits = readAccountAmount(account.collateral, "collateral");
  const initialMarginRequirementUnits = readAccountAmount(
    account.cross_initial_margin_requirement,
    "cross initial margin requirement",
  );
  const maintenanceMarginRequirementUnits = readAccountAmount(
    account.cross_maintenance_margin_requirement,
    "cross maintenance margin requirement",
  );
  if (evidence.amountUnits > availableBalanceUnits) {
    throw preflightError("The requested Core withdrawal exceeds the live available balance.");
  }
  if (collateralUnits - evidence.amountUnits < initialMarginRequirementUnits) {
    throw preflightError("The requested Core withdrawal would leave less than the live initial margin requirement.");
  }

  if (evidence.assets.code !== 200) throw preflightError("Core asset metadata is unavailable.");
  const assetRows = evidence.assets.asset_details.filter(
    (asset) => asset.asset_id === LIGHTER_CORE_WITHDRAW_ASSET_INDEX,
  );
  const asset = assetRows[0];
  if (assetRows.length !== 1 || asset === undefined) {
    throw preflightError("Core did not expose exactly one USDC asset 3 row.");
  }
  const tokenAddress = normalizeAddress(asset.l1_address, "Core USDC token");
  if (
    asset.symbol !== "USDC"
    || asset.l1_decimals !== LIGHTER_CORE_WITHDRAW_DECIMALS
    || asset.decimals !== LIGHTER_CORE_WITHDRAW_DECIMALS
    || asset.margin_mode !== "enabled"
    || tokenAddress !== deployment.settlementTokenProxy
  ) {
    throw preflightError("Live Core asset 3 metadata differs from the reviewed Ethereum USDC deployment.");
  }
  if (asset.min_withdrawal_amount === undefined) {
    throw preflightError("Core did not expose a live minimum withdrawal amount.");
  }
  const minimumWithdrawalUnits = parseProviderAmount(
    asset.min_withdrawal_amount,
    "minimum withdrawal amount",
  );
  if (minimumWithdrawalUnits !== deployment.minimumDepositUnits) {
    throw preflightError("Core's live USDC withdrawal minimum differs from the reviewed 1 USDC minimum.");
  }
  if (evidence.amountUnits < minimumWithdrawalUnits) {
    throw preflightError("The requested Core withdrawal is below the live minimum.");
  }

  const keyRows = evidence.apiKeys.api_keys.filter(
    (key) => key.account_index === evidence.accountIndex && key.api_key_index === evidence.apiKeyIndex,
  );
  const key = keyRows[0];
  if (evidence.apiKeys.code !== 200 || keyRows.length !== 1 || key === undefined) {
    throw preflightError("The exact managed API key is not registered to the selected Core account.");
  }
  if (key.public_key.trim().length === 0) throw preflightError("The registered Core API key has no public key.");
  if (evidence.nextNonce.code !== 200 || !Number.isSafeInteger(evidence.nextNonce.nonce) || evidence.nextNonce.nonce < 0) {
    throw preflightError("Core did not return a usable next nonce for the managed API key.");
  }

  if (!Number.isSafeInteger(evidence.delay.seconds) || evidence.delay.seconds < 0) {
    throw preflightError("Core returned an invalid withdrawal delay.");
  }
  const nonterminal = evidence.history.filter(
    (item) => item.asset_id === LIGHTER_CORE_WITHDRAW_ASSET_INDEX
      && (item.status === "pending" || item.status === "claimable"),
  );
  if (nonterminal.length > 0) {
    throw preflightError("A Core USDC withdrawal is already pending or claimable for this account.");
  }

  if (evidence.settlement.chainId !== deployment.settlementChainId) {
    throw preflightError("The settlement RPC is not Ethereum mainnet.");
  }
  assertFreshBlock(evidence.observedAt, evidence.settlement.blockTimestampSeconds);
  const gatewayCode = requireCode(evidence.settlement.gatewayCode, "Core gateway");
  const tokenCode = requireCode(evidence.settlement.tokenCode, "Ethereum USDC");
  const expectedImplementation = deployment.expectedGatewayImplementation;
  if (expectedImplementation === undefined) throw preflightError("The reviewed Core gateway implementation is not configured.");
  const gatewayImplementationAddress = evidence.settlement.gatewayImplementationAddress === null
    ? null
    : normalizeAddress(evidence.settlement.gatewayImplementationAddress, "Core gateway implementation");
  if (gatewayImplementationAddress !== expectedImplementation) {
    throw preflightError("The Core gateway implementation differs from the reviewed deployment.");
  }
  const [configuredToken, withdrawalsEnabled] = evidence.settlement.gatewayAssetConfig;
  if (normalizeAddress(configuredToken, "gateway asset token") !== deployment.settlementTokenProxy) {
    throw preflightError("The Core gateway asset 3 token is not the reviewed Ethereum USDC contract.");
  }
  if (withdrawalsEnabled !== 1) throw preflightError("Core gateway withdrawals are not enabled for USDC asset 3.");
  if (evidence.settlement.pendingBalanceUnits !== 0n) {
    throw preflightError("The destination wallet already has unresolved modern Core pending USDC.");
  }

  const positions = Array.isArray(account.positions) ? account.positions : [];
  const pendingOrderCount = account.pending_order_count;
  if (!Number.isSafeInteger(pendingOrderCount) || pendingOrderCount! < 0) {
    throw preflightError("Core did not return a usable pending-order count.");
  }
  if (!Number.isSafeInteger(evidence.activeOrderCount) || evidence.activeOrderCount < 0) {
    throw preflightError("Core did not return a usable active-order count.");
  }

  const observedAt = evidence.observedAt.toISOString();
  return {
    observedAt,
    expiresAt: new Date(evidence.observedAt.getTime() + LIGHTER_CORE_WITHDRAW_PREVIEW_TTL_MS).toISOString(),
    environment: "core",
    operationClass: "secure_l2_withdrawal",
    endpoint: deployment.restBaseUrl,
    signingChainId: 304,
    settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet",
    accountIndex: evidence.accountIndex,
    apiKeyIndex: evidence.apiKeyIndex,
    walletAddress,
    destinationAddress: walletAddress,
    assetIndex: 3,
    assetSymbol: "USDC",
    assetDecimals: 6,
    settlementTokenAddress: deployment.settlementTokenProxy,
    routeType: 0,
    amountUnits: evidence.amountUnits.toString(10),
    minimumWithdrawalUnits: minimumWithdrawalUnits.toString(10),
    availableBalanceUnits: availableBalanceUnits.toString(10),
    collateralUnits: collateralUnits.toString(10),
    initialMarginRequirementUnits: initialMarginRequirementUnits.toString(10),
    maintenanceMarginRequirementUnits: maintenanceMarginRequirementUnits.toString(10),
    pendingOrderCount: pendingOrderCount!,
    openPositionCount: positions.length,
    activeOrderCount: evidence.activeOrderCount,
    nextNonce: String(evidence.nextNonce.nonce),
    registeredPublicKey: key.public_key,
    keyTransactionTime: String(key.transaction_time),
    withdrawalDelaySeconds: evidence.delay.seconds,
    delayObservedAt: observedAt,
    gatewayAddress: deployment.gatewayProxy,
    gatewayImplementationAddress,
    gatewayCodeHash: keccak256(gatewayCode),
    settlementTokenCodeHash: keccak256(tokenCode),
    settlementBlockNumber: evidence.settlement.blockNumber.toString(10),
    pendingBalanceUnits: evidence.settlement.pendingBalanceUnits.toString(10),
    legacyPendingBalanceUnits: evidence.settlement.legacyPendingBalanceUnits.toString(10),
    withdrawalHistoryCount: evidence.history.length,
    nonterminalWithdrawalCount: 0,
  };
}

async function readAllCoreWithdrawalHistory(
  client: Pick<LighterClient, "getWithdrawHistory">,
  accountIndex: number,
  privilegedAuth: LighterPrivilegedAccountAuth,
): Promise<readonly LighterWithdrawHistoryItem[]> {
  const rows: LighterWithdrawHistoryItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const response = await client.getWithdrawHistory(
      "core",
      { accountIndex, cursor, filter: "all" },
      privilegedAuth,
    );
    if (response.code !== 200) throw preflightError("Authenticated Core withdrawal history is unavailable.");
    rows.push(...response.withdraws);
    const next = response.cursor.trim();
    if (next.length === 0) return rows;
    if (cursors.has(next)) throw preflightError("Core withdrawal history returned a repeated cursor.");
    cursors.add(next);
    cursor = next;
  }
  throw preflightError("Core withdrawal history exceeded the bounded page limit.");
}

async function readProxyImplementation(
  publicClient: PublicClient,
  proxy: Address,
): Promise<Address | null> {
  const stored = await publicClient.getStorageAt({ address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT });
  if (stored === undefined || /^0x0{64}$/i.test(stored)) return null;
  return getAddress(`0x${stored.slice(-40)}`);
}

function uniqueOwnedAccount(
  response: LighterAccountResponse,
  accountIndex: number,
  walletAddress: Address,
): LighterAccountResponse["accounts"][number] {
  if (response.code !== 200) throw preflightError("Core account lookup failed.");
  const matches = response.accounts.filter((candidate) =>
    (candidate.index ?? candidate.account_index) === accountIndex
      && typeof candidate.l1_address === "string"
      && normalizeAddress(candidate.l1_address, "Core account owner") === walletAddress);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw preflightError("The selected wallet does not uniquely own the selected Core account.");
  }
  return matches[0];
}

function readAccountAmount(value: string | undefined, field: string): bigint {
  if (value === undefined) throw preflightError(`Core did not expose the ${field}.`);
  return parseProviderAmount(value, field);
}

function parseProviderAmount(value: string, field: string): bigint {
  try {
    return decimalToBaseUnits(value, LIGHTER_CORE_WITHDRAW_DECIMALS);
  } catch {
    throw preflightError(`Core returned an invalid ${field}.`);
  }
}

function normalizeAddress(value: string, field: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw preflightError(`Core withdrawal preflight received an invalid ${field} address.`);
  }
}

function requireSafeIndex(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw preflightError(`The ${field} is invalid.`);
}

function requireCode(value: Hex | undefined, label: string): Hex {
  if (value === undefined || value === "0x" || /^0x0+$/i.test(value)) {
    throw preflightError(`${label} has no deployed bytecode.`);
  }
  return value;
}

function assertFreshBlock(observedAt: Date, timestampSeconds: bigint): void {
  if (timestampSeconds <= 0n) throw preflightError("Ethereum returned an invalid latest-block timestamp.");
  const observedSeconds = BigInt(Math.floor(observedAt.getTime() / 1_000));
  if (timestampSeconds > observedSeconds + MAX_BLOCK_FUTURE_SKEW_SECONDS) {
    throw preflightError("Ethereum returned a future latest block.");
  }
  if (observedSeconds - timestampSeconds > MAX_BLOCK_AGE_SECONDS) {
    throw preflightError("Ethereum latest block is stale.");
  }
}

function preflightError(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No Core withdrawal approval was prepared. Refresh live account and settlement evidence before retrying.",
  );
}
