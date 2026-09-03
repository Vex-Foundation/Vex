/**
 * VEX'S OWN FEE, per tool, read from the constants that charge it.
 *
 * ## Why the notes live here and not in each registry entry
 *
 * A rate written by hand next to a tool is a claim about the user's money that
 * nothing keeps true. Every rate below is IMPORTED from the venue module the
 * executor charges from, so a venue that changes its rate changes what
 * `vex_ToolDescribe` says in the same commit, and
 * `__tests__/vex-agent/tools/tool-contract-fields.test.ts` fails if a note ever
 * stops agreeing with its constant. This is the same discipline
 * `studio/instructions/shared-usage.ts::STUDIO_FEE_NOTE` is held to by
 * `__tests__/vex-agent/studio/instructions-fee-note.test.ts`, applied one layer
 * down: that block tells a human-facing agent the rule, these fields answer the
 * per-tool question a caller asks before it spends.
 *
 * ## The three states, and why "none" carries a reason
 *
 * `{ bps, when }` states a charge. `{ none, reason }` states a deliberate
 * free path and says WHY, because "this costs nothing" is exactly the sentence
 * a user acts on. An ABSENT field is neither: it means nobody authored one, and
 * `vex_ToolDescribe` reports it absent rather than reporting zero.
 *
 * Nothing here is model input. The rate, the receiver and the collection
 * mechanism are product-owner constants; no tool exposes a fee-shaped
 * parameter, and `fee-params-never-from-model.test.ts` fails the build if one
 * appears.
 */

import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/constants.js";
import { JUPITER_SWAP_FEE_BPS } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/constants.js";

import { WALLET_TX_FEE_BPS } from "./internal/wallet/transaction/vex-fee.js";
import type { ToolVexFee } from "./types.js";

/** `25` rendered as the percentage a user reads. Derived, never written twice. */
function percentOf(bps: number): string {
  return `${String(bps / 100)}%`;
}

/**
 * How a swap fee is collected, and the mistake the sentence exists to stop.
 *
 * EMBEDDED means the quoted output is already net of it. An agent that adds it
 * on top when reporting what a swap cost reports a number the user never paid.
 */
function embeddedInTheRoute(bps: number, venue: string): string {
  return (
    `${String(bps)} bps (${percentOf(bps)}) of the input token, taken INSIDE the ${venue} route itself. `
    + "The quoted output is already net of it, so never add it on top when reporting what was spent, "
    + "and a swap that never lands is never charged."
  );
}

/** KyberSwap, the primary EVM swap venue behind `SwapQuote`/`SwapExecute`. */
export const KYBERSWAP_SWAP_VEX_FEE: ToolVexFee = {
  bps: KYBERSWAP_FEE_BPS,
  when: embeddedInTheRoute(KYBERSWAP_FEE_BPS, "KyberSwap"),
};

/**
 * Uniswap, the fallback EVM swap venue behind the `*Uniswap` pair.
 *
 * NOT embedded, unlike KyberSwap and Jupiter, and the difference is a fact
 * about the venue rather than a wording choice: V2 Router02 and V3 SwapRouter02
 * expose NO integrator-fee field (`@tools/uniswap/fee/constants.ts`), so the
 * fee can only be Vex's own transfer leg. The user-visible arithmetic is the
 * same - `amountIn` is the total debited and the swap runs on the remainder.
 */
export const UNISWAP_SWAP_VEX_FEE: ToolVexFee = {
  bps: UNISWAP_FEE_BPS,
  when:
    `${String(UNISWAP_FEE_BPS)} bps (${percentOf(UNISWAP_FEE_BPS)}) of the input token. Uniswap's routers `
    + "expose no integrator-fee field, so this is Vex's OWN transfer leg: the router swaps `amountIn` MINUS "
    + "the fee while the wallet is debited `amountIn` in total, and the leg is signed only AFTER the swap "
    + "confirms - a swap that fails is never charged. The result's `vexFee` block reports what was collected.",
};

/** Jupiter, the Solana leg of `SwapQuote`/`SwapExecute` and of `solana__swap_*`. */
export const JUPITER_SWAP_VEX_FEE: ToolVexFee = {
  bps: JUPITER_SWAP_FEE_BPS,
  when: embeddedInTheRoute(JUPITER_SWAP_FEE_BPS, "Jupiter"),
};

/**
 * A bridge fee is a SEPARATE transfer, not an embedded one.
 *
 * It runs only after the deposit lands, which is what makes "a bridge that does
 * not happen is never charged" true rather than aspirational.
 */
export const BRIDGE_VEX_FEE: ToolVexFee = {
  bps: BRIDGE_FEE_BPS,
  when:
    `${String(BRIDGE_FEE_BPS)} bps (${percentOf(BRIDGE_FEE_BPS)}) of the input token, as a SEPARATE transfer `
    + "that runs only AFTER the deposit lands on the source chain. A bridge that never happens is never "
    + "charged, and a fee leg that fails leaves the bridge itself untouched.",
};

/**
 * The GENERIC EVM signing lane, whose base is the transaction's OWN native
 * value - which is why a zero-value transaction pays nothing at all.
 */
export const EVM_TRANSACTION_VEX_FEE: ToolVexFee = {
  bps: WALLET_TX_FEE_BPS,
  when:
    `${String(WALLET_TX_FEE_BPS)} bps (${percentOf(WALLET_TX_FEE_BPS)}) of THIS transaction's own native `
    + "`valueWei`, as a SEPARATE treasury transfer signed only AFTER the transaction confirms, under its own "
    + "bounded gas ceiling. A zero-value transaction - every ERC-20 transfer and every approve - pays NOTHING, "
    + "and nothing is charged when the fee would cost more to collect than it is worth. The approval card shows "
    + "whichever applies. A transaction that reverts, stays unconfirmed or refuses before broadcast is never "
    + "charged.",
};

/** A read, a preview or a research call: nothing is spent, so nothing is charged. */
export const READ_ONLY_NO_VEX_FEE: ToolVexFee = {
  none: true,
  reason:
    "This tool moves no funds: it reads recorded or live state. Vex charges nothing for a read, a preview or a "
    + "research call. Where a fee applies at all it belongs to the execute that spends, and that tool states it.",
};

/**
 * The FAMILY ROUTER pair (`SwapQuote`/`SwapExecute`), which is KyberSwap on EVM
 * and Jupiter on Solana. One note because the two venues charge the SAME rate,
 * which the suite asserts against both constants rather than trusting this
 * sentence; the day they diverge, the note has to name the venue and the test
 * is what forces that.
 */
export const SWAP_ROUTER_VEX_FEE: ToolVexFee = {
  bps: KYBERSWAP_FEE_BPS,
  when: embeddedInTheRoute(KYBERSWAP_FEE_BPS, "KyberSwap (EVM) or Jupiter (Solana)"),
};

/**
 * A swap quote. Free to call, and the sentence has to say the second half too:
 * the amount it quotes is already net of what the execute will take, so an
 * agent that subtracts the fee again reports a number nobody was charged.
 */
function swapQuoteNoVexFee(bps: number, mechanism: string): ToolVexFee {
  return {
    none: true,
    reason:
      "A quote spends nothing and is never charged. The output it quotes is ALREADY NET of the "
      + `${String(bps)} bps input-token fee the execute it authorizes collects, ${mechanism}, so never `
      + "subtract it a second time when reporting the expected result.",
  };
}

/** `SwapQuote`, the family router: KyberSwap on EVM, Jupiter on Solana. */
export const SWAP_ROUTER_QUOTE_NO_VEX_FEE: ToolVexFee = swapQuoteNoVexFee(
  KYBERSWAP_FEE_BPS,
  "taken inside the KyberSwap (EVM) or Jupiter (Solana) route itself",
);

/** `SwapQuoteUniswap`, the fallback EVM venue, whose leg is separate. */
export const UNISWAP_SWAP_QUOTE_NO_VEX_FEE: ToolVexFee = swapQuoteNoVexFee(
  UNISWAP_FEE_BPS,
  "which on Uniswap is a separate leg: the quoted output is for `amountIn` MINUS the fee while `amountIn` "
  + "stays the total debited",
);

/** A bridge quote. Free, and its fee leg is separate rather than embedded. */
export const BRIDGE_QUOTE_NO_VEX_FEE: ToolVexFee = {
  none: true,
  reason:
    "A quote spends nothing and is never charged. The bridge it authorizes takes "
    + `${String(BRIDGE_FEE_BPS)} bps of the input token as a SEPARATE transfer after the deposit lands; the `
    + "quote reports that leg in its own `vexFee` field rather than hiding it in the amounts.",
};

/** The plain send pair. Free by product decision, and structurally unable to charge. */
export const SEND_NO_VEX_FEE: ToolVexFee = {
  none: true,
  reason:
    "VEX CHARGES NO FEE on the send path, for any asset and any amount. The send lane imports no fee module at "
    + "all, which `__tests__/vex-agent/studio/instructions-fee-note.test.ts` asserts structurally. The only cost "
    + "is network gas, which is not Vex's fee.",
};

/** The wrap pair. Free, and 1:1 by construction. */
export const WRAP_NO_VEX_FEE: ToolVexFee = {
  none: true,
  reason:
    "VEX CHARGES NO FEE on the wrap path: the conversion is exactly 1:1, one native unit for one wrapped unit and "
    + "back. The wrap lane imports no fee module at all, which "
    + "`__tests__/vex-agent/studio/instructions-fee-note.test.ts` asserts structurally. The only cost is network "
    + "gas.",
};

/**
 * The generic SOLANA signing lane, and why its silence is deliberate.
 *
 * No Solana fee-leg runtime exists on this lane, and appending an instruction
 * to a canonical message that has already been approved is forbidden by
 * construction: the bytes the user read are the bytes that get signed.
 * Migration 088 binds `tx_vex_fee` to `chain_family = 'eip155'`, so the gap is
 * enforced by the database and not by a comment
 * (`internal/wallet/transaction/vex-fee.ts`).
 */
export const SOLANA_TRANSACTION_NO_VEX_FEE: ToolVexFee = {
  none: true,
  reason:
    "Vex charges NOTHING on the generic Solana signing lane. No Solana fee leg exists there, and adding an "
    + "instruction to a canonical message the user already approved is forbidden by construction - the bytes read "
    + "are the bytes signed. The database enforces the gap: the fee row is bound to EVM chains only. The only cost "
    + "is the network and priority fee you capped.",
};

/** A tool that reads Vex's own catalogue. It reaches no chain and no provider. */
export const CATALOGUE_NO_VEX_FEE: ToolVexFee = {
  none: true,
  reason:
    "This tool answers from Vex's own tool catalogue. It runs no tool, reaches no chain and no provider, and is "
    + "never charged.",
};
