/**
 * Deterministic match-hash over a swap/bridge trade identity (Stage 6c/7/8c/9).
 *
 * The hash is computed IDENTICALLY at record-time and gate-time so the digests
 * collide. This module owns the canonical identity shapes, the per-field
 * canonicalization (address case, amount normalization), and the fixed-order
 * hash material.
 *
 * VENUE-BOUND scheme (LOCKED Wave-2 correction #4): `provider`/venue IS part of
 * the identity - it is the LAST field of both the swap and the bridge hash
 * material. On EVM the provider does NOT derive from `family` (kyberswap and
 * uniswap are both eip155; khalani and relay both bridge), so binding it is what
 * stops a kyberswap quote from authorizing a uniswap execute (or a khalani quote
 * a relay execute) for the same tokens/amount.
 *
 * This file is the public entry point and the kind dispatcher; each identity
 * FAMILY (its shape, its doc, and its fixed-order material) lives in the
 * same-named sibling folder: `hash/swap.ts`, `hash/bridge.ts`, `hash/pendle-pt.ts`,
 * `hash/pendle-py.ts`, `hash/pendle-lp.ts`, `hash/pendle-sy.ts`, with the shared
 * per-field canonicalization in `hash/canonicalize.ts`.
 */

import { createHash } from "node:crypto";

import { bridgeHashMaterial } from "./hash/bridge.js";
import {
  lpAddHashMaterial,
  lpAddKeepYtHashMaterial,
  lpRemoveDualHashMaterial,
  lpRemoveHashMaterial,
  lpToPtHashMaterial,
  lpTransferHashMaterial,
} from "./hash/pendle-lp.js";
import { morphoBorrowHashMaterial } from "./hash/morpho-borrow.js";
import { lendHashMaterial } from "./hash/morpho-lend.js";
import { redeemHashMaterial, ptRolloverHashMaterial } from "./hash/pendle-pt.js";
import { mintHashMaterial, redeemPyHashMaterial } from "./hash/pendle-py.js";
import { syHashMaterial } from "./hash/pendle-sy.js";
import { swapHashMaterial } from "./hash/swap.js";
import { MORPHO_MARKET_LANE } from "./lane.js";

import type { BridgeMatchInput, BridgeTradeType } from "./hash/bridge.js";
import type {
  LpAddKeepYtMatchInput,
  LpAddMatchInput,
  LpRemoveDualMatchInput,
  LpRemoveMatchInput,
  LpToPtMatchInput,
  LpTransferMatchInput,
} from "./hash/pendle-lp.js";
import type {
  LendBorrowMatchInput,
  LendMarketSupplyMatchInput,
  LendMarketWithdrawMatchInput,
  LendRepayMatchInput,
  LendSupplyCollateralMatchInput,
  LendWithdrawCollateralMatchInput,
} from "./hash/morpho-borrow.js";
import type { LendDepositMatchInput, LendWithdrawMatchInput } from "./hash/morpho-lend.js";
import type { PtRolloverMatchInput, RedeemMatchInput } from "./hash/pendle-pt.js";
import type { MintMatchInput, RedeemPyMatchInput } from "./hash/pendle-py.js";
import type { SyMintMatchInput, SyRedeemMatchInput } from "./hash/pendle-sy.js";
import type { SwapMatchInput } from "./hash/swap.js";

export type { BridgeMatchInput, BridgeTradeType } from "./hash/bridge.js";
export type {
  LpAddKeepYtMatchInput,
  LpAddMatchInput,
  LpRemoveDualMatchInput,
  LpRemoveMatchInput,
  LpToPtMatchInput,
  LpTransferMatchInput,
} from "./hash/pendle-lp.js";
export type {
  LendBorrowMatchInput,
  LendMarketSupplyMatchInput,
  LendMarketWithdrawMatchInput,
  LendRepayMatchInput,
  LendSupplyCollateralMatchInput,
  LendWithdrawCollateralMatchInput,
  MorphoBorrowMatchInput,
} from "./hash/morpho-borrow.js";
export type { LendDepositMatchInput, LendWithdrawMatchInput } from "./hash/morpho-lend.js";
export type { PtRolloverMatchInput, RedeemMatchInput } from "./hash/pendle-pt.js";
export type { MintMatchInput, RedeemPyMatchInput } from "./hash/pendle-py.js";
export type { SyMintMatchInput, SyRedeemMatchInput } from "./hash/pendle-sy.js";
export type { SwapMatchInput } from "./hash/swap.js";

/**
 * Discriminated on `kind` - swap / bridge / redeem / mint / redeem_py / lp_add /
 * lp_remove identities never collide, and neither do the seven R5d kinds
 * (sy_mint / sy_redeem / lp_remove_dual / lp_add_keep_yt / pt_rollover /
 * lp_transfer / lp_to_pt), each of which carries its tag as the FIRST material
 * element.
 */
export type PrequoteMatchInput =
  | SwapMatchInput
  | BridgeMatchInput
  | RedeemMatchInput
  | MintMatchInput
  | RedeemPyMatchInput
  | LpAddMatchInput
  | LpRemoveMatchInput
  | SyMintMatchInput
  | SyRedeemMatchInput
  | LpRemoveDualMatchInput
  | LpAddKeepYtMatchInput
  | PtRolloverMatchInput
  | LpTransferMatchInput
  | LpToPtMatchInput
  | LendDepositMatchInput
  | LendWithdrawMatchInput
  | LendMarketSupplyMatchInput
  | LendMarketWithdrawMatchInput
  | LendSupplyCollateralMatchInput
  | LendWithdrawCollateralMatchInput
  | LendBorrowMatchInput
  | LendRepayMatchInput;

/**
 * Deterministic sha256-hex match-hash over the trade identity. Identical at
 * record-time and gate-time. The quoting `provider`/venue IS bound (LOCKED
 * Wave-2 #4) as the LAST material field. Exported so the gate reuses the EXACT
 * function.
 *
 * Stage 8c: the material is prefixed with the `kind` discriminant tag and then
 * the kind-specific fields in a FIXED order, so a swap and a bridge with
 * otherwise-similar values produce different digests (Codex requirement #4).
 * Wave-2c appends the venue `provider` last on both kinds.
 *   - swap   : ["swap", sessionId, family, chainId|"", wallet, tokenIn, tokenOut,
 *               amount, recipient, approveExact, slippageBps, provider]
 *   - bridge : ["bridge", sessionId, sourceFamily, destFamily, fromChainId,
 *               toChainId, sourceWallet, recipient, fromToken, toToken, amount,
 *               tradeType, refundTo, referrer, referrerFeeBps, filler, provider,
 *               slippageBps]
 * EVM addresses/tokens lowercase; Solana mints case-preserved; amount via
 * `canonAmount`.
 *
 * Stage 9 swap tail (FIXED order, appended after `amount`): `recipient`
 * (family-canonical address - where the output lands), `approveExact` (stable
 * "1"/"0" allowance token), and `slippageBps` (integer string, or "" when
 * omitted). The recorder defaults `recipient`/`approveExact` to the executor's
 * omitted-value defaults (self / false) since the quote can't carry them, so a
 * quote↔execute that both omit them collide; an execute that redirects the
 * output or flips approveExact, or quotes 50bps then executes 10000bps,
 * diverges → block.
 *
 * Bridge: the source family canonicalizes `sourceWallet`/`fromToken`/`refundTo`;
 * the dest family canonicalizes `recipient`/`toToken` (derived from each chain
 * id). The money/fee tail (FIXED order, appended after `tradeType`): `refundTo`
 * (source-family address), `referrer` (EVM → lowercase), the already-canonical
 * `referrerFeeBps` integer string, and `filler` (opaque provider name,
 * case-preserved). Omitted money/fee fields are "" so a quote↔execute that both
 * omit them still collide.
 */
export function computePrequoteMatchHash(input: PrequoteMatchInput): string {
  let material: string;
  switch (input.kind) {
    case "swap":
      material = swapHashMaterial(input);
      break;
    case "bridge":
      material = bridgeHashMaterial(input);
      break;
    case "redeem":
      material = redeemHashMaterial(input);
      break;
    case "mint":
      material = mintHashMaterial(input);
      break;
    case "redeem_py":
      material = redeemPyHashMaterial(input);
      break;
    case "lp_add":
      material = lpAddHashMaterial(input);
      break;
    case "lp_remove":
      material = lpRemoveHashMaterial(input);
      break;
    case "sy_mint":
    case "sy_redeem":
      material = syHashMaterial(input);
      break;
    case "lp_remove_dual":
      material = lpRemoveDualHashMaterial(input);
      break;
    case "lp_add_keep_yt":
      material = lpAddKeepYtHashMaterial(input);
      break;
    case "pt_rollover":
      material = ptRolloverHashMaterial(input);
      break;
    case "lp_transfer":
      material = lpTransferHashMaterial(input);
      break;
    case "lp_to_pt":
      material = lpToPtHashMaterial(input);
      break;
    case "lend_deposit":
    case "lend_withdraw":
      // TWO KINDS, TWO LANES. A Morpho VAULT deposit/redeem (E3b-2) and a Blue
      // MARKET supply/withdraw share these kind tags, because supplying a loan
      // asset IS lending and a per-venue-shape kind would fragment the agent's
      // own history. The kind therefore no longer decides the material on its
      // own: `lane` does, and it is carried on the match input rather than only
      // on the registration precisely so this dispatch can read it. The vault
      // material is UNCHANGED and `lane` is in neither material - see
      // `hash/morpho-borrow.ts` for why the two can never collide anyway.
      material = input.lane === MORPHO_MARKET_LANE
        ? morphoBorrowHashMaterial(input)
        : lendHashMaterial(input);
      break;
    case "lend_supply_collateral":
    case "lend_withdraw_collateral":
    case "lend_borrow":
    case "lend_repay":
      // Morpho Blue borrow lane (E3c). One material function, four kind tags:
      // the tag is what keeps a collateral-supply quote from authorizing a
      // borrow execute on the same market, which is why it leads the material.
      material = morphoBorrowHashMaterial(input);
      break;
  }
  return createHash("sha256").update(material).digest("hex");
}
