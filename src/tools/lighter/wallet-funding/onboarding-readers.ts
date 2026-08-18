/**
 * Live read-only readers backing `lighter.account.onboarding.status`.
 *
 * This is the I/O layer: Ethereum L1 mainnet balance reads (via the existing
 * Uniswap chain-1 public client) and Lighter public account/API-key reads. It
 * is address-only and holds no keys. The trading-key check is a public
 * heuristic — a registered key in the trading index range — and never asserts
 * Vex control on its own; the execution path confirms vault control precisely.
 */

import { getAddress } from "viem";

import { readErc20Balance } from "../../evm-chains/erc20-reads.js";
import { getUniswapDeployment } from "../../uniswap/deployments.js";
import { getUniswapPublicClient } from "../../uniswap/evm-client.js";
import { getLighterClient } from "../client.js";
import { LIGHTER_API_KEY_INDEX_ALL } from "../constants.js";
import {
  LIGHTER_TRADING_API_KEY_INDEX_MAX,
  LIGHTER_TRADING_API_KEY_INDEX_MIN,
} from "../trading-credentials.js";
import {
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
  LIGHTER_DEPOSIT_CHAIN_ID,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  LIGHTER_USDC_ASSET_INDEX,
} from "./constants.js";
import { decimalToBaseUnits } from "./onboarding-plan.js";
import type { LighterAccountCollateralRow } from "./onboarding-observation.js";
import type { LighterOnboardingReaders } from "./onboarding-status.js";

export function buildLighterOnboardingReaders(): LighterOnboardingReaders {
  return {
    async readWalletSettlementUnits(walletAddress) {
      return await readErc20Balance(
        mainnetClient(),
        getAddress(LIGHTER_CORE_MAINNET_USDC_ADDRESS),
        getAddress(walletAddress),
      );
    },
    async readWalletCanAcquireSettlement(walletAddress) {
      const wei = await mainnetClient().getBalance({ address: getAddress(walletAddress) });
      return wei > 0n;
    },
    async readLighterAccount(environment, walletAddress) {
      let response;
      try {
        response = await getLighterClient().getAccount(environment, {
          by: "l1_address",
          value: walletAddress,
        });
      } catch (err) {
        // Lighter returns HTTP 400 "account not found" for an L1 address that
        // owns no account yet — the normal pre-onboarding state, not an error.
        if (isLighterAccountNotFound(err)) return null;
        throw err;
      }
      const first = response.accounts?.[0];
      if (!first) return null;
      const accountIndex = first.account_index ?? first.index;
      if (accountIndex === undefined) return null;
      const row: LighterAccountCollateralRow = {
        account_index: accountIndex,
        status: first.status,
        collateral: first.collateral,
        available_balance: first.available_balance,
      };
      return row;
    },
    async readVexTradingKeyRegistered(environment, accountIndex) {
      const response = await getLighterClient().getApiKeys(environment, {
        accountIndex,
        apiKeyIndex: LIGHTER_API_KEY_INDEX_ALL,
      });
      return (response.api_keys ?? []).some(
        (key) =>
          key.api_key_index >= LIGHTER_TRADING_API_KEY_INDEX_MIN &&
          key.api_key_index <= LIGHTER_TRADING_API_KEY_INDEX_MAX &&
          isRegisteredPubKey(key.public_key),
      );
    },
    async readMinimumDepositUnits(environment) {
      const response = await getLighterClient().getAssetDetails(environment);
      const rows = response.asset_details.filter(
        (asset) => asset.asset_id === LIGHTER_USDC_ASSET_INDEX,
      );
      const asset = rows[0];
      if (
        response.code !== 200
        || rows.length !== 1
        || asset === undefined
        || asset.symbol.toUpperCase() !== "USDC"
        || asset.l1_decimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS
        || asset.decimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS
        || getAddress(asset.l1_address) !== getAddress(LIGHTER_CORE_MAINNET_USDC_ADDRESS)
      ) {
        throw new Error("Lighter did not return one verified Core USDC deposit asset.");
      }
      const minimumUnits = decimalToBaseUnits(
        asset.min_transfer_amount,
        LIGHTER_SETTLEMENT_ASSET_DECIMALS,
      );
      if (minimumUnits <= 0n) {
        throw new Error("Lighter returned an invalid minimum Core USDC deposit amount.");
      }
      return minimumUnits;
    },
  };
}

function mainnetClient() {
  const deployment = getUniswapDeployment(LIGHTER_DEPOSIT_CHAIN_ID);
  if (!deployment) {
    throw new Error("Ethereum mainnet deployment is not configured for Lighter deposits.");
  }
  return getUniswapPublicClient(deployment);
}

/** True when a getAccount failure is Lighter's "no account for this L1 address". */
function isLighterAccountNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /account not found/i.test(message);
}

/** A slot is registered when its public key is present and not all zeros. */
function isRegisteredPubKey(pubKey: string | undefined): boolean {
  if (!pubKey) return false;
  const hex = pubKey.startsWith("0x") ? pubKey.slice(2) : pubKey;
  return hex.length > 0 && /[1-9a-f]/i.test(hex);
}
