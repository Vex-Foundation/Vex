/**
 * Verified constants for Lighter wallet-funded account onboarding (Phase 7).
 *
 * Every value here was confirmed 2026-08-17 against the Lighter API docs
 * (deposits-transfers-and-withdrawals, api-keys, get-started) and the vendored
 * Go SDK `github.com/elliottech/lighter-go@v1.0.7`. See
 * `.context/lighter_wallet_funding_plan.md` §7. Values that are NOT yet verified
 * are intentionally absent rather than guessed — a wrong deposit constant loses
 * user funds irreversibly.
 */

import type { LighterEnvironment } from "../constants.js";

/**
 * Lighter Core deposits settle on Ethereum L1 mainnet through a bridge contract.
 * The address is also served live at GET /info ("contract_address").
 */
export const LIGHTER_DEPOSIT_CHAIN_ID = 1 as const;
export const LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS =
  "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7" as const;

/**
 * Canonical native USDC on Ethereum L1 mainnet (the Core settlement asset),
 * cross-checked against the Uniswap chain-1 deployment connector list.
 */
export const LIGHTER_CORE_MAINNET_USDC_ADDRESS =
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;

/** deposit(...) function selector on the bridge contract. */
export const LIGHTER_DEPOSIT_SELECTOR = "0x8a857083" as const;

/** deposit `_routeType` param: 0 credits the perps account, 1 the spot account. */
export const LIGHTER_DEPOSIT_ROUTE_TYPE = {
  perps: 0,
  spot: 1,
} as const;

/**
 * Minimum credited deposit. Direct L1 deposits credit from 1 USDC; the CCTP
 * cross-chain path (Arbitrum/Base/Avalanche) has a 5 USDC floor and is deferred.
 * Below the floor the deposit is not credited and is effectively lost.
 */
export const LIGHTER_DEPOSIT_MIN_USDC = "1" as const;

/** Settlement/collateral asset symbol per environment. */
export const LIGHTER_SETTLEMENT_ASSET: Record<LighterEnvironment, string> = {
  core: "USDC",
  rhc: "USDG",
} as const;

/** USDC has 6 decimals; settlement amounts are integer base units at this scale. */
export const LIGHTER_SETTLEMENT_ASSET_DECIMALS = 6 as const;

/**
 * Usable API-key index bounds for Vex-registered trading keys are the existing
 * `LIGHTER_TRADING_API_KEY_INDEX_MIN`/`MAX` (4..254) in `trading-credentials.ts`
 * — the conservative floor that satisfies both doc readings and matches the
 * live-proven key 4. This module deliberately does not redefine them.
 */

/**
 * ChangePubKey transaction types (lighter-go types/txtypes/constants.go).
 * Vex uses the L2 variant: an L2 transaction carrying an off-chain L1 signature,
 * which costs no L1 gas. The L1 variant is a direct on-chain call for multisig
 * and is intentionally unused.
 */
export const LIGHTER_TX_TYPE_L1_CHANGE_PUB_KEY = 2 as const;
export const LIGHTER_TX_TYPE_L2_CHANGE_PUB_KEY = 8 as const;

/**
 * Human-readable message the L1 wallet signs to authorize L2ChangePubKey
 * (lighter-go TemplateChangePubKey). Registration is one-time per key.
 */
export const LIGHTER_CHANGE_PUB_KEY_SIGNATURE_TEMPLATE =
  "Register Lighter Account\n\npubkey: 0x%s\nnonce: %s\naccount index: %s\napi key index: %s\nOnly sign this message for a trusted client!" as const;
