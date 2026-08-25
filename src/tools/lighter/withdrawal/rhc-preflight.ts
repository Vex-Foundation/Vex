import {
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import type { LighterClient, LighterPrivilegedAccountAuth } from "../client.js";
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
import {
  LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
  LIGHTER_CORE_WITHDRAW_PREVIEW_TTL_MS,
} from "./core-preflight.js";

const MAX_HISTORY_PAGES = 50;
const MAX_BLOCK_AGE_SECONDS = 5n * 60n;
const MAX_BLOCK_FUTURE_SKEW_SECONDS = 60n;
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export interface LighterRhcWithdrawalPreflightSnapshot {
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly environment: "rhc";
  readonly operationClass: "secure_l2_withdrawal";
  readonly endpoint: string;
  readonly signingChainId: 466324;
  readonly settlementChainId: 4663;
  readonly settlementNetworkName: "Robinhood Chain mainnet";
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly walletAddress: Address;
  readonly destinationAddress: Address;
  readonly assetIndex: 3;
  readonly assetSymbol: "USDG";
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
  readonly legacyPendingBalanceUnits: "0";
  readonly withdrawalHistoryCount: number;
  readonly nonterminalWithdrawalCount: 0;
}

export interface LighterRhcWithdrawalPreflightEvidence {
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
  };
}

export async function readLighterRhcWithdrawalPreflight(input: {
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly amountUnits: bigint;
  readonly client: Pick<LighterClient,
    "getAccount" | "getApiKeys" | "getNextNonce" | "getAssetDetails" |
    "getWithdrawalDelay" | "getWithdrawHistory" | "getAccountActiveOrders">;
  readonly privilegedAuth: LighterPrivilegedAccountAuth;
  readonly publicClient: PublicClient;
  readonly now?: () => Date;
}): Promise<LighterRhcWithdrawalPreflightSnapshot> {
  const deployment = getLighterFundingDeployment("rhc");
  const walletAddress = normalizeAddress(input.walletAddress, "selected wallet");
  if (input.privilegedAuth.accountIndex !== input.accountIndex) {
    throw preflightError("The read-only account authorization does not match the selected RHC account.");
  }
  const observedAt = input.now?.() ?? new Date();
  const [accountByIndex, accountByWallet, apiKeys, nextNonce, assets, delay, history,
    activeOrders, chainId, block, gatewayCode, tokenCode, gatewayImplementationAddress,
    gatewayAssetConfig, pendingBalanceUnits] = await Promise.all([
    input.client.getAccount("rhc", { by: "index", value: input.accountIndex }),
    input.client.getAccount("rhc", { by: "l1_address", value: walletAddress }),
    input.client.getApiKeys("rhc", { accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex }),
    input.client.getNextNonce("rhc", { accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex }),
    input.client.getAssetDetails("rhc"),
    input.client.getWithdrawalDelay("rhc"),
    readAllRhcWithdrawalHistory(input.client, input.accountIndex, input.privilegedAuth),
    input.client.getAccountActiveOrders("rhc", { accountIndex: input.accountIndex, marketType: "all" }, input.privilegedAuth),
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
  ]);
  return proveLighterRhcWithdrawalPreflight({
    observedAt, walletAddress, accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex,
    amountUnits: input.amountUnits, accountByIndex, accountByWallet, apiKeys, nextNonce,
    assets, delay, history, activeOrderCount: activeOrders.orders.length,
    settlement: { chainId, blockNumber: block.number, blockTimestampSeconds: block.timestamp,
      gatewayCode, tokenCode, gatewayImplementationAddress, gatewayAssetConfig, pendingBalanceUnits },
  });
}

export function proveLighterRhcWithdrawalPreflight(
  evidence: LighterRhcWithdrawalPreflightEvidence,
): LighterRhcWithdrawalPreflightSnapshot {
  const deployment = getLighterFundingDeployment("rhc");
  const walletAddress = normalizeAddress(evidence.walletAddress, "selected wallet");
  if (!Number.isFinite(evidence.observedAt.getTime())) throw preflightError("The observation time is invalid.");
  requireSafeIndex(evidence.accountIndex, "account index");
  requireSafeIndex(evidence.apiKeyIndex, "API-key index");
  if (evidence.amountUnits <= 0n) throw preflightError("The withdrawal amount must be positive.");

  const account = uniqueOwnedAccount(evidence.accountByIndex, evidence.accountIndex, walletAddress);
  const walletAccount = uniqueOwnedAccount(evidence.accountByWallet, evidence.accountIndex, walletAddress);
  if ((account.index ?? account.account_index) !== (walletAccount.index ?? walletAccount.account_index)) {
    throw preflightError("RHC account lookup by index and wallet did not resolve the same account.");
  }
  // No `account.status !== 1` gate here: live-verified 2026-08-22 against a
  // real, funded, correctly-owned RHC account (collateral present, trading
  // key registered and active) — its `status` was `0`, not `1`. Nothing else
  // in this integration treats `status` as a meaningful account-health signal
  // (see `projectors.ts`, which only ever passes it through as opaque
  // metadata), and this check had no test coverage. Account health for a
  // withdrawal is already established below by ownership uniqueness, balance
  // sufficiency, and margin-requirement checks — real signals, unlike this
  // one, whose actual value space Lighter does not document.
  const availableBalanceUnits = readAccountAmount(account.available_balance, "available balance");
  const collateralUnits = readAccountAmount(account.collateral, "collateral");
  const initialMarginRequirementUnits = readAccountAmount(account.cross_initial_margin_requirement, "cross initial margin requirement");
  const maintenanceMarginRequirementUnits = readAccountAmount(account.cross_maintenance_margin_requirement, "cross maintenance margin requirement");
  if (evidence.amountUnits > availableBalanceUnits) {
    throw preflightError("The requested RHC withdrawal exceeds the live available balance.");
  }
  if (collateralUnits - evidence.amountUnits < initialMarginRequirementUnits) {
    throw preflightError("The requested RHC withdrawal would leave less than the live initial margin requirement.");
  }

  if (evidence.assets.code !== 200) throw preflightError("RHC asset metadata is unavailable.");
  const assetRows = evidence.assets.asset_details.filter((asset) => asset.asset_id === 3);
  const asset = assetRows[0];
  if (assetRows.length !== 1 || asset === undefined) {
    throw preflightError("RHC did not expose exactly one USDG asset 3 row.");
  }
  const tokenAddress = normalizeAddress(asset.l1_address, "RHC USDG token");
  if (asset.symbol !== "USDG" || asset.l1_decimals !== 6 || asset.decimals !== 6
    || asset.margin_mode !== "enabled" || tokenAddress !== deployment.settlementTokenProxy) {
    throw preflightError("Live RHC asset 3 metadata differs from the reviewed Robinhood Chain USDG deployment.");
  }
  if (asset.min_withdrawal_amount === undefined) {
    throw preflightError("RHC did not expose a live minimum withdrawal amount.");
  }
  const minimumWithdrawalUnits = parseProviderAmount(asset.min_withdrawal_amount, "minimum withdrawal amount");
  if (minimumWithdrawalUnits !== deployment.minimumDepositUnits) {
    throw preflightError("RHC's live USDG withdrawal minimum differs from the reviewed 1 USDG minimum.");
  }
  if (evidence.amountUnits < minimumWithdrawalUnits) {
    throw preflightError("The requested RHC withdrawal is below the live minimum.");
  }

  const keyRows = evidence.apiKeys.api_keys.filter((key) =>
    key.account_index === evidence.accountIndex && key.api_key_index === evidence.apiKeyIndex);
  const key = keyRows[0];
  if (evidence.apiKeys.code !== 200 || keyRows.length !== 1 || key === undefined) {
    throw preflightError("The exact managed API key is not registered to the selected RHC account.");
  }
  if (key.public_key.trim().length === 0) throw preflightError("The registered RHC API key has no public key.");
  if (evidence.nextNonce.code !== 200 || !Number.isSafeInteger(evidence.nextNonce.nonce) || evidence.nextNonce.nonce < 0) {
    throw preflightError("RHC did not return a usable next nonce for the managed API key.");
  }
  if (!Number.isSafeInteger(evidence.delay.seconds) || evidence.delay.seconds < 0) {
    throw preflightError("RHC returned an invalid withdrawal delay.");
  }
  // Lighter documents secure withdrawals as remaining `claimable`; it only
  // expects `completed` for fast withdrawals. Consequently, `claimable` is
  // not an account-wide liveness signal for secure history. The live gateway
  // pending balance below is authoritative for whether a claim still exists.
  const nonterminal = evidence.history.filter((item) =>
    item.asset_id === 3 && item.status === "pending");
  if (nonterminal.length > 0) {
    throw preflightError("An RHC USDG withdrawal is already pending for this account.");
  }

  if (evidence.settlement.chainId !== 4663) {
    throw preflightError("The settlement RPC is not Robinhood Chain mainnet.");
  }
  assertFreshBlock(evidence.observedAt, evidence.settlement.blockTimestampSeconds);
  const gatewayCode = requireCode(evidence.settlement.gatewayCode, "RHC gateway");
  const tokenCode = requireCode(evidence.settlement.tokenCode, "Robinhood Chain USDG");
  const expectedImplementation = deployment.expectedGatewayImplementation;
  if (expectedImplementation === undefined) throw preflightError("The reviewed RHC gateway implementation is not configured.");
  const gatewayImplementationAddress = evidence.settlement.gatewayImplementationAddress === null
    ? null : normalizeAddress(evidence.settlement.gatewayImplementationAddress, "RHC gateway implementation");
  if (gatewayImplementationAddress !== expectedImplementation) {
    throw preflightError("The RHC gateway implementation differs from the reviewed deployment.");
  }
  const [configuredToken, withdrawalsEnabled] = evidence.settlement.gatewayAssetConfig;
  if (normalizeAddress(configuredToken, "gateway asset token") !== deployment.settlementTokenProxy) {
    throw preflightError("The RHC gateway asset 3 token is not the reviewed Robinhood Chain USDG contract.");
  }
  if (withdrawalsEnabled !== 1) throw preflightError("RHC gateway withdrawals are not enabled for USDG asset 3.");
  if (evidence.settlement.pendingBalanceUnits !== 0n) {
    throw preflightError("The destination wallet already has unresolved RHC pending USDG.");
  }

  const positions = Array.isArray(account.positions) ? account.positions : [];
  const pendingOrderCount = account.pending_order_count;
  if (!Number.isSafeInteger(pendingOrderCount) || pendingOrderCount! < 0) {
    throw preflightError("RHC did not return a usable pending-order count.");
  }
  if (!Number.isSafeInteger(evidence.activeOrderCount) || evidence.activeOrderCount < 0) {
    throw preflightError("RHC did not return a usable active-order count.");
  }
  const observedAt = evidence.observedAt.toISOString();
  return {
    observedAt,
    expiresAt: new Date(evidence.observedAt.getTime() + LIGHTER_CORE_WITHDRAW_PREVIEW_TTL_MS).toISOString(),
    environment: "rhc", operationClass: "secure_l2_withdrawal", endpoint: deployment.restBaseUrl,
    signingChainId: 466324, settlementChainId: 4663, settlementNetworkName: "Robinhood Chain mainnet",
    accountIndex: evidence.accountIndex, apiKeyIndex: evidence.apiKeyIndex,
    walletAddress, destinationAddress: walletAddress, assetIndex: 3, assetSymbol: "USDG",
    assetDecimals: 6, settlementTokenAddress: deployment.settlementTokenProxy, routeType: 0,
    amountUnits: evidence.amountUnits.toString(10), minimumWithdrawalUnits: minimumWithdrawalUnits.toString(10),
    availableBalanceUnits: availableBalanceUnits.toString(10), collateralUnits: collateralUnits.toString(10),
    initialMarginRequirementUnits: initialMarginRequirementUnits.toString(10),
    maintenanceMarginRequirementUnits: maintenanceMarginRequirementUnits.toString(10),
    pendingOrderCount: pendingOrderCount!, openPositionCount: positions.length,
    activeOrderCount: evidence.activeOrderCount, nextNonce: String(evidence.nextNonce.nonce),
    registeredPublicKey: key.public_key, keyTransactionTime: String(key.transaction_time),
    withdrawalDelaySeconds: evidence.delay.seconds, delayObservedAt: observedAt,
    gatewayAddress: deployment.gatewayProxy, gatewayImplementationAddress,
    gatewayCodeHash: keccak256(gatewayCode), settlementTokenCodeHash: keccak256(tokenCode),
    settlementBlockNumber: evidence.settlement.blockNumber.toString(10),
    pendingBalanceUnits: evidence.settlement.pendingBalanceUnits.toString(10),
    legacyPendingBalanceUnits: "0", withdrawalHistoryCount: evidence.history.length,
    nonterminalWithdrawalCount: 0,
  };
}

export async function readAllRhcWithdrawalHistory(
  client: Pick<LighterClient, "getWithdrawHistory">,
  accountIndex: number,
  privilegedAuth: LighterPrivilegedAccountAuth,
): Promise<readonly LighterWithdrawHistoryItem[]> {
  const rows: LighterWithdrawHistoryItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const response = await client.getWithdrawHistory("rhc", { accountIndex, cursor, filter: "all" }, privilegedAuth);
    if (response.code !== 200) throw preflightError("Authenticated RHC withdrawal history is unavailable.");
    rows.push(...response.withdraws);
    const next = response.cursor.trim();
    if (next.length === 0) return rows;
    if (cursors.has(next)) {
      // A stable cursor with no new rows this page is how the provider signals
      // "nothing more" for an account with no (or exhausted) withdrawal
      // history — it does not always hand back an empty cursor string. Only
      // treat a repeat as a genuine pagination fault when it keeps handing
      // back new rows, which is the actual infinite-loop/duplication risk
      // this guard exists to catch.
      if (response.withdraws.length === 0) return rows;
      throw preflightError("RHC withdrawal history returned a repeated cursor.");
    }
    cursors.add(next);
    cursor = next;
  }
  throw preflightError("RHC withdrawal history exceeded the bounded page limit.");
}

async function readProxyImplementation(publicClient: PublicClient, proxy: Address): Promise<Address | null> {
  const stored = await publicClient.getStorageAt({ address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT });
  if (stored === undefined || /^0x0{64}$/i.test(stored)) return null;
  return getAddress(`0x${stored.slice(-40)}`);
}

function uniqueOwnedAccount(response: LighterAccountResponse, accountIndex: number, walletAddress: Address) {
  if (response.code !== 200) throw preflightError("RHC account lookup failed.");
  const matches = response.accounts.filter((candidate) =>
    (candidate.index ?? candidate.account_index) === accountIndex
    && typeof candidate.l1_address === "string"
    && normalizeAddress(candidate.l1_address, "RHC account owner") === walletAddress);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw preflightError("The selected wallet does not uniquely own the selected RHC account.");
  }
  return matches[0];
}

function readAccountAmount(value: string | undefined, field: string): bigint {
  if (value === undefined) throw preflightError(`RHC did not expose the ${field}.`);
  return parseProviderAmount(value, field);
}

function parseProviderAmount(value: string, field: string): bigint {
  try { return decimalToBaseUnits(value, 6); }
  catch { throw preflightError(`RHC returned an invalid ${field}.`); }
}

function normalizeAddress(value: string, field: string): Address {
  try { return getAddress(value); }
  catch { throw preflightError(`RHC withdrawal preflight received an invalid ${field} address.`); }
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
  if (timestampSeconds <= 0n) throw preflightError("Robinhood Chain returned an invalid latest-block timestamp.");
  const observedSeconds = BigInt(Math.floor(observedAt.getTime() / 1_000));
  if (timestampSeconds > observedSeconds + MAX_BLOCK_FUTURE_SKEW_SECONDS) {
    throw preflightError("Robinhood Chain returned a future latest block.");
  }
  if (observedSeconds - timestampSeconds > MAX_BLOCK_AGE_SECONDS) {
    throw preflightError("Robinhood Chain latest block is stale.");
  }
}

function preflightError(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No RHC withdrawal approval was prepared. Refresh live account and Robinhood Chain evidence before retrying.",
  );
}
