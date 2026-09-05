/**
 * The READ surface of AgentTaxV2, and nothing else.
 *
 * Every entry is transcribed from the verified source
 * (`contracts/tax/AgentTaxV2.sol`, implementation 0xF6dE... on Base and
 * 0x4D4e... on Robinhood, both verified on their explorers) and every one of
 * them was exercised live on both chains on 2026-09-04.
 *
 * NO MUTATING ENTRY IS DECLARED HERE, deliberately. `swapForTokenAddress`,
 * `batchSwapForTokenAddress`, `depositTax`, `updateCreator` and the admin
 * setters all exist on the contract; none of them belongs in a read module, and
 * the one a creator would want (`swapForTokenAddress`) is gated on `SWAP_ROLE`
 * which the creator does not hold. Leaving them out means this module cannot
 * encode a transaction even by accident.
 */

/** `FFactoryV2.taxVault()` - the authority for which contract holds the tax. */
export const FFACTORY_TAX_VAULT_ABI = [
  {
    name: "taxVault",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const AGENT_TAX_V2_READ_ABI = [
  // -- contract-wide configuration ------------------------------------
  { name: "taxToken", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "assetToken", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "treasury", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "feeRate", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  {
    name: "minSwapThreshold",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxSwapThreshold",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // -- per-token accounting -------------------------------------------
  //
  // BOTH numbers are cumulative and denominated in `taxToken`. Pending is
  // `amountCollected - amountSwapped`, never a third stored field.
  {
    name: "getTokenTaxAmounts",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenAddress", type: "address" }],
    outputs: [
      { name: "amountCollected", type: "uint256" },
      { name: "amountSwapped", type: "uint256" },
    ],
  },
  // An UNREGISTERED token answers (0x0, 0x0) rather than reverting - measured
  // live against 0x...dEaD on Base. A zero creator therefore means "this token
  // has no tax recipient registered", which is a different fact from "this
  // creator has earned nothing", and the two are never collapsed.
  {
    name: "getTokenRecipient",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenAddress", type: "address" }],
    outputs: [
      { name: "tba", type: "address" },
      { name: "creator", type: "address" },
    ],
  },
  {
    name: "getTokenPartnerConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenAddress", type: "address" }],
    outputs: [
      { name: "partnerId", type: "bytes32" },
      { name: "partnerFeeRate", type: "uint16" },
    ],
  },
  {
    name: "partnerRecipients",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "partnerId", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },

  // -- authority -------------------------------------------------------
  //
  // The measurement behind the whole refusal: `hasRole(SWAP_ROLE, creator)`.
  {
    name: "hasRole",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** The three ERC-20 facts an amount needs to be readable. */
export const ERC20_METADATA_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
