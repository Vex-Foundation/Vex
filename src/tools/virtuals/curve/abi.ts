/**
 * The MINIMAL ABIs the curve trade lane calls, transcribed from the first-party
 * sources in `agents-colab/protocol-contracts/contracts/launchpadv2/` and each
 * exercised live on both chains on 2026-09-04.
 *
 * Narrow on purpose: every function here is one this lane actually calls, so a
 * reader can see the whole contract surface Vex depends on without reading a
 * 900-line Solidity file. `tokenInfo` is the exception - its shape is the
 * Solidity AUTO-GETTER for `mapping(address => BondingConfig.Token) public
 * tokenInfo`, which omits the `uint8[] cores` member and flattens nothing else.
 * That shape was PROVEN by decoding a live response rather than reasoned about
 * (`virtuals-trade-2026-09-04/`), because getting it wrong silently shifts every
 * field after it.
 */

import { parseAbi } from "viem";

/** `BondingV5` - the entry point the user signs. */
export const BONDING_V5_ABI = parseAbi([
  "function buy(uint256 amountIn_, address tokenAddress_, uint256 amountOutMin_, uint256 deadline_) payable returns (bool)",
  "function sell(uint256 amountIn_, address tokenAddress_, uint256 amountOutMin_, uint256 deadline_) returns (bool)",
  "function tokenAntiSniperType(address token_) view returns (uint8)",
  "function router() view returns (address)",
  "function factory() view returns (address)",
  "function bondingConfig() view returns (address)",
]);

/**
 * `BondingV5.tokenInfo(address)` - the Solidity auto-getter, written as a raw
 * ABI entry because `parseAbi` cannot express the nested `Data` tuple.
 *
 * MEMBER ORDER IS THE CONTRACT. `cores` (`uint8[]`) is absent because auto
 * getters omit array members; every other member of `BondingConfig.Token` is
 * present in declaration order.
 */
export const BONDING_V5_TOKEN_INFO_ABI = [
  {
    type: "function",
    name: "tokenInfo",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "token", type: "address" },
      { name: "pair", type: "address" },
      { name: "agentToken", type: "address" },
      {
        name: "data",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "name", type: "string" },
          { name: "_name", type: "string" },
          { name: "ticker", type: "string" },
          { name: "supply", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "marketCap", type: "uint256" },
          { name: "liquidity", type: "uint256" },
          { name: "volume", type: "uint256" },
          { name: "volume24H", type: "uint256" },
          { name: "prevPrice", type: "uint256" },
          { name: "lastUpdated", type: "uint256" },
        ],
      },
      { name: "description", type: "string" },
      { name: "image", type: "string" },
      { name: "twitter", type: "string" },
      { name: "telegram", type: "string" },
      { name: "youtube", type: "string" },
      { name: "website", type: "string" },
      { name: "trading", type: "bool" },
      { name: "tradingOnUniswap", type: "bool" },
      { name: "applicationId", type: "uint256" },
      { name: "initialPurchase", type: "uint256" },
      { name: "virtualId", type: "uint256" },
      { name: "launchExecuted", type: "bool" },
    ],
  },
] as const;

/** `FRouterV3` - the quote source and the ALLOWANCE SPENDER. */
export const FROUTER_V3_ABI = parseAbi([
  "function getAmountsOut(address token, address assetToken_, uint256 amountIn) view returns (uint256)",
  "function assetToken() view returns (address)",
  "function factory() view returns (address)",
  "function hasAntiSniperTax(address pairAddress) view returns (bool)",
]);

/** `FFactoryV2` - the pair registry and the flat protocol taxes. */
export const FFACTORY_V2_ABI = parseAbi([
  "function getPair(address tokenA, address tokenB) view returns (address)",
  "function buyTax() view returns (uint256)",
  "function sellTax() view returns (uint256)",
  "function antiSniperBuyTaxStartValue() view returns (uint256)",
  "function taxVault() view returns (address)",
  "function antiSniperTaxVault() view returns (address)",
]);

/** `BondingConfig` - the anti-sniper type table (pure functions). */
export const BONDING_CONFIG_ABI = parseAbi([
  "function getAntiSniperDuration(uint8 antiSniperType_) pure returns (uint256)",
  "function appliesAntiSniperOnBuy(uint8 antiSniperType_) pure returns (bool)",
  "function appliesAntiSniperOnSell(uint8 antiSniperType_) pure returns (bool)",
]);

/** `FPairV2` - the anti-sniper clock and the curve reserves. */
export const FPAIR_V2_ABI = parseAbi([
  "function startTime() view returns (uint256)",
  "function taxStartTime() view returns (uint256)",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function getReserves() view returns (uint256, uint256)",
]);

/** The ERC-20 surface this lane reads and writes. */
export const CURVE_ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
