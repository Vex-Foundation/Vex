/**
 * Pendle v2 — pinned addresses, method selectors, and the fund-safety constants
 * every broadcast is checked against.
 *
 * Pendle runs on 11 chains (see `@tools/pendle/chains.ts` for the registry). The
 * Router address is IDENTICAL on every supported chain (live-verified), so it is
 * the SINGLE canonical on-chain target: every mutating broadcast asserts
 * `tx.to === PENDLE_ROUTER` (checksummed) and rejects otherwise, regardless of
 * chain. `requiredApprovals` from the hosted Convert API carry NO spender field —
 * the spender is IMPLICITLY the Router, so approvals are ALWAYS granted to the
 * pinned Router for the EXACT amount.
 *
 * The Router methods below are the ONLY selectors a Pendle broadcast may carry.
 * The intent-binding check (see protocols/pendle/calldata.ts) FULL-decodes
 * `tx.data` against `PENDLE_ROUTER_ABI` and asserts receiver == session wallet,
 * market/YT == the quoted market/YT, and the ACTUAL spend token/amount inside the
 * TokenInput/TokenOutput tuples == the quoted intent. YT swaps
 * (`swapExactTokenForYt` / `swapExactYtForToken`, IPActionSwapYTV3) share the PT
 * struct layout. The income-sweep claim (`redeemDueInterestAndRewardsV2`,
 * IPActionMiscV3) has a DIFFERENT flat response shape and its own binding — its
 * ABI lives in the separate `PENDLE_CLAIM_ABI` so `decodeRouterCall` never treats
 * a claim selector as a swap.
 */

import { getAddress, type Address } from "viem";

/** Pendle v2 Router — IDENTICAL on all supported chains. Every broadcast pins tx.to here. */
export const PENDLE_ROUTER: Address = getAddress("0x888888888889758F76e7103c6CbF23ABbF58F946");

/** Native-token sentinel (Convert uses the zero address for native ETH input). */
export const PENDLE_NATIVE_TOKEN: Address = getAddress("0x0000000000000000000000000000000000000000");

/**
 * Aggregators Convert is ALLOWED to route through (the ceiling set). The convert
 * body sends the INTERSECTION of this set with the chain's supported aggregators
 * (`PendleClient.getSupportedAggregators`) — e.g. HyperEVM/Berachain support only
 * kyberswap, so okx is never sent there. Restricting to these keeps the
 * compute-unit spend bounded (convert = 5 base + 1 per aggregator) and the
 * broadcast surface to venues we have verified. Order is not significant.
 */
export const PENDLE_AGGREGATORS = ["kyberswap", "okx"] as const;

/**
 * Router method selectors (4-byte), pinned for documentation/audit. These are
 * the ONLY methods a Pendle broadcast may carry:
 *   - swapExactTokenForPt : token → PT (PT buy)
 *   - swapExactPtForToken : PT → token (PT early-exit sell)
 *   - swapExactTokenForYt : token → YT (YT buy — IPActionSwapYTV3)
 *   - swapExactYtForToken : YT → token (YT sell — IPActionSwapYTV3)
 *   - mintPyFromToken     : token → PT+YT (PY mint — IPActionMiscV3)
 *   - redeemPyToToken     : PT(+YT) → underlying (redeem; pre-expiry PY burns the
 *                           PT+YT pair, matured PT reuses the same method)
 *   - redeemPyToSy        : PT → SY (redeem fallback)
 *   - addLiquiditySingleToken    : token → LP (LP add, IPActionAddRemoveLiqV3)
 *   - removeLiquiditySingleToken : LP → token (LP remove, IPActionAddRemoveLiqV3)
 * The fund-safety extractor decodes against the FULL `PENDLE_ROUTER_ABI` below
 * (whose computed selectors are test-pinned to these values via live calldata).
 * The claim selector is separate (see `PENDLE_CLAIM_SELECTOR`).
 */
export const PENDLE_SELECTORS = {
  swapExactTokenForPt: "0xc81f847a",
  swapExactPtForToken: "0x594a88cc",
  swapExactTokenForYt: "0xed48907e",
  swapExactYtForToken: "0x05eb5327",
  mintPyFromToken: "0xd0f42385",
  redeemPyToToken: "0x47f1de22",
  redeemPyToSy: "0x339748cb",
  // LP single-token (IPActionAddRemoveLiqV3, P5) — token → LP and LP → token.
  // Live-probed 2026-07-06 on chains 1 + 42161 (identical Router, identical
  // selectors); test-pinned by decoding the live calldata against the ABI below.
  addLiquiditySingleToken: "0x12599ac6",
  removeLiquiditySingleToken: "0x60da0860",
} as const;

export type PendleRouterMethod = keyof typeof PENDLE_SELECTORS;

/** selector (lowercase 0x-hex) → method name, for the calldata head decoder. */
export const PENDLE_SELECTOR_TO_METHOD: Readonly<Record<string, PendleRouterMethod>> = {
  [PENDLE_SELECTORS.swapExactTokenForPt]: "swapExactTokenForPt",
  [PENDLE_SELECTORS.swapExactPtForToken]: "swapExactPtForToken",
  [PENDLE_SELECTORS.swapExactTokenForYt]: "swapExactTokenForYt",
  [PENDLE_SELECTORS.swapExactYtForToken]: "swapExactYtForToken",
  [PENDLE_SELECTORS.mintPyFromToken]: "mintPyFromToken",
  [PENDLE_SELECTORS.redeemPyToToken]: "redeemPyToToken",
  [PENDLE_SELECTORS.redeemPyToSy]: "redeemPyToSy",
  [PENDLE_SELECTORS.addLiquiditySingleToken]: "addLiquiditySingleToken",
  [PENDLE_SELECTORS.removeLiquiditySingleToken]: "removeLiquiditySingleToken",
};

/**
 * Income-sweep claim selector (`redeemDueInterestAndRewardsV2`, IPActionMiscV3).
 * Live-probed (2026-07-06) + 4byte-confirmed; test-pinned via `PENDLE_CLAIM_ABI`.
 * Kept OUT of `PENDLE_SELECTORS` so the swap decode path can never accept it.
 */
export const PENDLE_CLAIM_SELECTOR = "0x0741a803" as const;

/**
 * Pendle's swap-helper contract the hosted SDK pins into `pendleSwap` — LIVE-pinned
 * 2026-07-06 from /v1/sdk/{chainId}/redeem-interests-and-rewards (identical on
 * chains 1/42161/8453; also the TokenInput.pendleSwap in live Convert routes).
 * Router source PROVES it is inert for a pure claim: with `swaps == []` the
 * dispatcher takes `__redeemDueInterestAndRewardsV2NoSwap`, which never receives
 * it (pendle-core-v2-public ActionMiscV3.sol:99-103). The claim binding still
 * pins `pendleSwap ∈ {zero, this}` as defense-in-depth — any other value fails
 * closed as an unverified helper.
 */
export const PENDLE_SWAP_HELPER: Address = getAddress("0xd4F480965D2347d421F1bEC7F545682E5Ec2151D");

// ── Full Router ABI (the allowed swap/redeem methods; structs from IPAllActionTypeV3) ──
//
// The fund-safety extractor FULL-decodes every broadcast against this ABI (Codex
// fix: the static head alone never bound the ACTUAL spend token/amount inside the
// dynamic TokenInput/TokenOutput tuples). Selector correctness is pinned by tests
// that decode LIVE-probed calldata — a wrong struct layout changes the selector
// and fails to decode.

const APPROX_PARAMS_COMPONENTS = [
  { name: "guessMin", type: "uint256" },
  { name: "guessMax", type: "uint256" },
  { name: "guessOffchain", type: "uint256" },
  { name: "maxIteration", type: "uint256" },
  { name: "eps", type: "uint256" },
] as const;

const SWAP_DATA_COMPONENTS = [
  { name: "swapType", type: "uint8" },
  { name: "extRouter", type: "address" },
  { name: "extCalldata", type: "bytes" },
  { name: "needScale", type: "bool" },
] as const;

const TOKEN_INPUT_COMPONENTS = [
  { name: "tokenIn", type: "address" },
  { name: "netTokenIn", type: "uint256" },
  { name: "tokenMintSy", type: "address" },
  { name: "pendleSwap", type: "address" },
  { name: "swapData", type: "tuple", components: SWAP_DATA_COMPONENTS },
] as const;

const TOKEN_OUTPUT_COMPONENTS = [
  { name: "tokenOut", type: "address" },
  { name: "minTokenOut", type: "uint256" },
  { name: "tokenRedeemSy", type: "address" },
  { name: "pendleSwap", type: "address" },
  { name: "swapData", type: "tuple", components: SWAP_DATA_COMPONENTS },
] as const;

const ORDER_COMPONENTS = [
  { name: "salt", type: "uint256" },
  { name: "expiry", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "orderType", type: "uint8" },
  { name: "token", type: "address" },
  { name: "YT", type: "address" },
  { name: "maker", type: "address" },
  { name: "receiver", type: "address" },
  { name: "makingAmount", type: "uint256" },
  { name: "lnImpliedRate", type: "uint256" },
  { name: "failSafeRate", type: "uint256" },
  { name: "permit", type: "bytes" },
] as const;

const FILL_ORDER_PARAMS_COMPONENTS = [
  { name: "order", type: "tuple", components: ORDER_COMPONENTS },
  { name: "signature", type: "bytes" },
  { name: "makingAmount", type: "uint256" },
] as const;

const LIMIT_ORDER_DATA_COMPONENTS = [
  { name: "limitRouter", type: "address" },
  { name: "epsSkipMarket", type: "uint256" },
  { name: "normalFills", type: "tuple[]", components: FILL_ORDER_PARAMS_COMPONENTS },
  { name: "flashFills", type: "tuple[]", components: FILL_ORDER_PARAMS_COMPONENTS },
  { name: "optData", type: "bytes" },
] as const;

export const PENDLE_ROUTER_ABI = [
  {
    type: "function",
    name: "swapExactTokenForPt",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "market", type: "address" },
      { name: "minPtOut", type: "uint256" },
      { name: "guessPtOut", type: "tuple", components: APPROX_PARAMS_COMPONENTS },
      { name: "input", type: "tuple", components: TOKEN_INPUT_COMPONENTS },
      { name: "limit", type: "tuple", components: LIMIT_ORDER_DATA_COMPONENTS },
    ],
    outputs: [
      { name: "netPtOut", type: "uint256" },
      { name: "netSyFee", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "swapExactPtForToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "market", type: "address" },
      { name: "exactPtIn", type: "uint256" },
      { name: "output", type: "tuple", components: TOKEN_OUTPUT_COMPONENTS },
      { name: "limit", type: "tuple", components: LIMIT_ORDER_DATA_COMPONENTS },
    ],
    outputs: [
      { name: "netTokenOut", type: "uint256" },
      { name: "netSyFee", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
  {
    // token → YT (YT buy, IPActionSwapYTV3). SAME struct layout as
    // swapExactTokenForPt (minYtOut/guessYtOut in place of minPtOut/guessPtOut) —
    // live-probed selector 0xed48907e (test-pinned via live calldata).
    type: "function",
    name: "swapExactTokenForYt",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "market", type: "address" },
      { name: "minYtOut", type: "uint256" },
      { name: "guessYtOut", type: "tuple", components: APPROX_PARAMS_COMPONENTS },
      { name: "input", type: "tuple", components: TOKEN_INPUT_COMPONENTS },
      { name: "limit", type: "tuple", components: LIMIT_ORDER_DATA_COMPONENTS },
    ],
    outputs: [
      { name: "netYtOut", type: "uint256" },
      { name: "netSyFee", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
  {
    // YT → token (YT sell, IPActionSwapYTV3). SAME struct layout as
    // swapExactPtForToken (exactYtIn in place of exactPtIn) — live-probed
    // selector 0x05eb5327 (test-pinned via live calldata).
    type: "function",
    name: "swapExactYtForToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "market", type: "address" },
      { name: "exactYtIn", type: "uint256" },
      { name: "output", type: "tuple", components: TOKEN_OUTPUT_COMPONENTS },
      { name: "limit", type: "tuple", components: LIMIT_ORDER_DATA_COMPONENTS },
    ],
    outputs: [
      { name: "netTokenOut", type: "uint256" },
      { name: "netSyFee", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "redeemPyToToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "YT", type: "address" },
      { name: "netPyIn", type: "uint256" },
      { name: "output", type: "tuple", components: TOKEN_OUTPUT_COMPONENTS },
    ],
    outputs: [
      { name: "netTokenOut", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "redeemPyToSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "YT", type: "address" },
      { name: "netPyIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
    ],
    outputs: [{ name: "netSyOut", type: "uint256" }],
  },
  {
    // token → PT+YT (PY mint, IPActionMiscV3). Live-probed selector 0xd0f42385
    // (test-pinned via live calldata). Splits ONE input token into an EQUAL
    // amount of PT and YT; the ONLY approval is the input token. arg1 is the YT
    // (the market's canonical YT), NOT the market — the intent binding asserts it
    // against the quoted market's YT. Same TokenInput layout as the PT/YT buys,
    // but at arg 3 (there is no ApproxParams/guess tuple).
    type: "function",
    name: "mintPyFromToken",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "YT", type: "address" },
      { name: "minPyOut", type: "uint256" },
      { name: "input", type: "tuple", components: TOKEN_INPUT_COMPONENTS },
    ],
    outputs: [
      { name: "netPyOut", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
  {
    // token → LP, single-token add (IPActionAddRemoveLiqV3, P5). Live-probed
    // selector 0x12599ac6 (test-pinned via live calldata). arg1 is the MARKET
    // (== the LP token address); the TokenInput at arg 4 carries the ACTUAL
    // spend token/amount, and the ONLY approval is the input token. minLpOut is
    // the slippage floor; guessPtReceivedFromSy is the on-chain PT/SY search.
    type: "function",
    name: "addLiquiditySingleToken",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "market", type: "address" },
      { name: "minLpOut", type: "uint256" },
      { name: "guessPtReceivedFromSy", type: "tuple", components: APPROX_PARAMS_COMPONENTS },
      { name: "input", type: "tuple", components: TOKEN_INPUT_COMPONENTS },
      { name: "limit", type: "tuple", components: LIMIT_ORDER_DATA_COMPONENTS },
    ],
    outputs: [
      { name: "netLpOut", type: "uint256" },
      { name: "netSyFee", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
  {
    // LP → token, single-token remove (IPActionAddRemoveLiqV3, P5). Live-probed
    // selector 0x60da0860 (test-pinned via live calldata). arg1 is the MARKET;
    // arg2 (netLpToRemove) is the ACTUAL LP burned, the TokenOutput at arg 3
    // carries the quoted output token, and the ONLY approval is the LP (market)
    // token itself.
    type: "function",
    name: "removeLiquiditySingleToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "market", type: "address" },
      { name: "netLpToRemove", type: "uint256" },
      { name: "output", type: "tuple", components: TOKEN_OUTPUT_COMPONENTS },
      { name: "limit", type: "tuple", components: LIMIT_ORDER_DATA_COMPONENTS },
    ],
    outputs: [
      { name: "netTokenOut", type: "uint256" },
      { name: "netSyFee", type: "uint256" },
      { name: "netSyInterm", type: "uint256" },
    ],
  },
] as const;

/**
 * `callAndReflect` — the Router's MULTI-LEG wrapper.
 *
 * LIVE-CAPTURED 2026-07-27 from a chain-1 `roll-over-pt` convert (recorded in
 * `__tests__/…/pendle/floor-fixtures.ts` as `rollOverPt`): selector `0x9fa02c86`,
 * shape `callAndReflect(address reflector, bytes selfCall1, bytes selfCall2,
 * bytes reflectCall)`, `selfCall2` empty, each non-empty leg carrying a nested
 * Router call. Leg 1's decoded receiver was the REFLECTOR
 * (`0x30544e00cf296b34a9ee59e5540ae2f9cccd55dd`), not the wallet; the final
 * leg's receiver was the wallet and its min-out equalled our computed floor to
 * the atomic unit.
 *
 * DELIBERATELY SEPARATE FROM {@link PENDLE_ROUTER_ABI}, exactly as the claim ABI
 * is: the single-leg swap decode path must never accept a reflect selector.
 * `calldata/decode.ts` reaches it only through `decodeReflectCall`, which
 * recurses into every leg with the ordinary `decodeRouterCall` so an inner
 * selector outside the 9 pinned ones is refused by the same allowlist.
 *
 * NO ACTION MAPS TO THIS TODAY. R5a ships the mechanism; the inner-leg layouts
 * (the live capture carries `0x3346d3a3` and `0x2a50917c`, neither pinned) are
 * probed and added by R5d. Until then every real reflect body is refused.
 */
export const PENDLE_REFLECT_SELECTOR = "0x9fa02c86" as const;

export const PENDLE_REFLECT_ABI = [
  {
    type: "function",
    name: "callAndReflect",
    stateMutability: "payable",
    inputs: [
      { name: "reflector", type: "address" },
      { name: "selfCall1", type: "bytes" },
      { name: "selfCall2", type: "bytes" },
      { name: "reflectCall", type: "bytes" },
    ],
    outputs: [
      { name: "selfRes1", type: "bytes" },
      { name: "selfRes2", type: "bytes" },
      { name: "reflectRes", type: "bytes" },
    ],
  },
] as const;

/**
 * Minimal Router ABI for the API-independent redeem fallback
 * (`redeemPyToSy(receiver, YT, netPyIn, minSyOut)` from IPActionMiscV3). The
 * always-exit path when the Convert API is unavailable for a MATURED position.
 */
export const PENDLE_ROUTER_REDEEM_ABI = [
  {
    type: "function",
    name: "redeemPyToSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "YT", type: "address" },
      { name: "netPyIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
    ],
    outputs: [{ name: "netSyOut", type: "uint256" }],
  },
] as const;

/**
 * Income-sweep claim ABI — `redeemDueInterestAndRewardsV2` (IPActionMiscV3).
 * Live-probed 2026-07-06 + 4byte-confirmed signature:
 *   redeemDueInterestAndRewardsV2(
 *     address[] SYs,
 *     (address yt, bool doRedeemInterest, bool doRedeemRewards,
 *      address tokenRedeemSy, uint256 minTokenRedeemOut)[] YTs,
 *     address[] markets,
 *     address pendleSwap,
 *     (address tokenIn, address tokenOut, uint256 minOut,
 *      (uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData)[] swaps)
 *
 * There is NO `receiver` argument — accrued interest/rewards go to msg.sender by
 * protocol. The ONLY external-call surface is `swaps` (extRouter/extCalldata); a
 * pure income sweep carries an EMPTY `swaps`, so the claim binding
 * (`protocols/pendle/calldata.ts` `assertClaimSafe`) REJECTS any non-empty
 * `swaps` and any non-empty `SYs`, and asserts each decoded `YTs[].yt` /
 * `markets[]` is a subset of the wallet's intended positions. Separate from
 * `PENDLE_ROUTER_ABI` so the swap decode path never accepts a claim selector.
 */
const YT_INCOME_COMPONENTS = [
  { name: "yt", type: "address" },
  { name: "doRedeemInterest", type: "bool" },
  { name: "doRedeemRewards", type: "bool" },
  { name: "tokenRedeemSy", type: "address" },
  { name: "minTokenRedeemOut", type: "uint256" },
] as const;

const SWAP_DATA_EXTRA_COMPONENTS = [
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "minOut", type: "uint256" },
  { name: "swapData", type: "tuple", components: SWAP_DATA_COMPONENTS },
] as const;

export const PENDLE_CLAIM_ABI = [
  {
    type: "function",
    name: "redeemDueInterestAndRewardsV2",
    stateMutability: "nonpayable",
    inputs: [
      { name: "SYs", type: "address[]" },
      { name: "YTs", type: "tuple[]", components: YT_INCOME_COMPONENTS },
      { name: "markets", type: "address[]" },
      { name: "pendleSwap", type: "address" },
      { name: "swaps", type: "tuple[]", components: SWAP_DATA_EXTRA_COMPONENTS },
    ],
    outputs: [],
  },
] as const;

/** ERC-20 read/approve ABI (balanceOf / decimals / symbol / allowance / approve). */
export const PENDLE_ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** Pendle-known category id that marks a points program (not fixed yield). */
export const PENDLE_POINTS_CATEGORY = "points";

/** Below this implied APY a points-bearing market's headline yield is misleading. */
export const PENDLE_LOW_APY_THRESHOLD = 0.03;
