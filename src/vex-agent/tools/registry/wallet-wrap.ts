/**
 * Native <-> wrapped-native conversion - its own pair, not an entry under the
 * generic transaction signing family.
 *
 * The separation is an ownership fact, not a taste: a wrap intent lives in
 * `wallet_wrap_intents` with its own digest version, its own refusal union and
 * its own confirm, and neither confirm may consume the other's row. What IS
 * shared is the gas-cap contract: the four EVM fee-bound params below are the
 * same declarations `WALLET_TRANSACTION_TOOLS` publishes, parsed by the same
 * `parseEvmFeeBounds`, so the model reads one spelling of one contract.
 *
 * There is deliberately NO fee-shaped, recipient-shaped or price-shaped param
 * here. The conversion is 1:1 by the contract's construction, the wrapped-native
 * contract credits `msg.sender`, and Vex charges nothing on this path, so none
 * of those inputs exists to be supplied.
 */

import type { ToolDef } from "../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../protocols/conventions.js";

/**
 * Repeated verbatim from `wallet-transaction.ts` rather than imported: the
 * sentence is model-visible copy on a param schema, and the two lanes must be
 * free to diverge in wording without one silently rewriting the other's
 * approval-relevant text.
 */
const EVM_FEE_BOUNDS_SENTENCE =
  "REQUIRED fee cap. Vex never derives a spending limit from a network estimate, so calling without "
  + "the caps refuses by name and returns the current estimate as a labelled hint.";

/** The verified set, named in the descriptions and in the refusal itself. */
const VERIFIED_CHAINS_SENTENCE =
  "ethereum, optimism, bsc, polygon, robinhood, base, arbitrum and avalanche";

export const WALLET_WRAP_TOOLS: readonly ToolDef[] = [
  {
    name: "WalletWrapPrepare",
    kind: "internal",
    mutating: false,
    pressureSafety: "mutating",
    actionKind: "approval_prepare",
    description:
      "Prepare a conversion between a chain's NATIVE currency and its WRAPPED-NATIVE ERC-20 form (ETH "
      + "<-> WETH, BNB <-> WBNB, POL <-> WPOL, AVAX <-> WAVAX). It SPENDS NOTHING and signs nothing: it "
      + "derives the transaction itself, simulates it, records one durable intent and hands back its id. "
      + "THE INTENT IS WHAT THE USER APPROVES, so the direction, amount, contract and fee caps recorded "
      + "here are exactly what is shown and confirmed. Use this when the user wants native currency in "
      + "its wrapped ERC-20 form or back, and specifically when a swap venue REFUSES a native <-> "
      + "wrapped-native pair - that pair is not a trade, it is this conversion, and no router will "
      + "quote it. Call this before any call to `WalletWrapConfirm`; confirm has no other way to obtain "
      + "an intentId. THE CONVERSION IS EXACTLY 1:1: one native unit becomes one wrapped unit and back, "
      + "with NO slippage, NO route, NO price and NO quote, because the wrapped-native contract mints "
      + "and burns at par. The recipient is ALWAYS the signer - the contract credits the sender, so "
      + "there is no recipient parameter and none can be supplied. VEX CHARGES NO FEE on this path: "
      + "the only cost is the network gas you cap below. REAL FAILURE MODES, each refused BY NAME with "
      + "nothing prepared and no row left behind: a chain on which Vex has not verified a "
      + "wrapped-native contract is refused and the refusal LISTS the verified set, which today is "
      + `${VERIFIED_CHAINS_SENTENCE}; a balance too small on the side the direction spends is refused `
      + "with the balance and the amount (a `wrap` must also leave room for the gas ceiling you "
      + "authorize, since both come out of the same native balance); a missing gas cap is refused by "
      + "name and carries the current network estimate as a LABELLED HINT you choose from, never as a "
      + "limit Vex sets for you; a failing simulation is refused with the decoded revert reason. "
      + "RETURNS intentId, chain, chainId, walletAddress, status 'prepared', direction, "
      + "wrappedNativeContract (address, symbol, decimals), amountRaw, amountHuman, rate '1:1', "
      + "expiresAt, the approval preview, approvedFeeBounds echoing the caps you supplied, and "
      + "nativeCurrency. The intent is scoped to this session, expires in 10 minutes, and binds the "
      + "wallet selected right now; if that selection changes, confirm refuses rather than signing from "
      + "another address.",
    parameters: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description:
            "The EVM chain the conversion executes on. Only chains with a verified wrapped-native "
            + `contract are accepted; today those are ${VERIFIED_CHAINS_SENTENCE}. `
            + CANONICAL_CHAIN_SENTENCE,
        },
        direction: {
          type: "string",
          enum: ["wrap", "unwrap"],
          description:
            "`wrap` turns native currency into its wrapped ERC-20 form and spends native; `unwrap` "
            + "turns the wrapped ERC-20 back into native and spends the token. Nothing else is "
            + "accepted, and the value is refused by name rather than guessed.",
        },
        amountRaw: {
          type: "string",
          description:
            "How much to convert, in the token's SMALLEST BASE UNITS, as decimal digits only (18 "
            + "decimals on every verified chain today, so \"1000000000000000000\" is one whole unit). "
            + "Never a human decimal such as \"1.5\", never a JSON number, never a unit suffix. Must be "
            + "greater than zero.",
        },
        gasLimit: {
          type: "string",
          description: `Maximum gas UNITS, as a decimal integer string. ${EVM_FEE_BOUNDS_SENTENCE}`,
        },
        maxFeePerGasWei: {
          type: "string",
          description:
            "EIP-1559 cap on the total price per gas unit, in RAW wei as a decimal integer string. "
            + `Pass this with maxPriorityFeePerGasWei, or pass gasPriceWei instead, never both. ${EVM_FEE_BOUNDS_SENTENCE}`,
        },
        maxPriorityFeePerGasWei: {
          type: "string",
          description:
            "EIP-1559 cap on the validator tip per gas unit, in RAW wei as a decimal integer string. "
            + `Cannot exceed maxFeePerGasWei. ${EVM_FEE_BOUNDS_SENTENCE}`,
        },
        gasPriceWei: {
          type: "string",
          description:
            "LEGACY cap on the price per gas unit, in RAW wei as a decimal integer string, for chains "
            + `without EIP-1559. Mutually exclusive with the 1559 pair. ${EVM_FEE_BOUNDS_SENTENCE}`,
        },
      },
      required: ["chain", "direction", "amountRaw", "gasLimit"],
    },
  },
  {
    name: "WalletWrapConfirm",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    actionKind: "user_wallet_broadcast",
    description:
      "Broadcast the native <-> wrapped-native conversion that `WalletWrapPrepare` already prepared. "
      + "This is the call that SPENDS REAL FUNDS: it signs with the user's wallet and sends an "
      + "IRREVERSIBLE on-chain transaction. Call it after the user has agreed to the prepared "
      + "conversion, and only with an intentId that prepare returned. APPROVAL: in a restricted "
      + "session it signs nothing, decrypts nothing and consumes nothing - it comes back asking for "
      + "approval, the intent stays pending, and that approval is bound to the exact conversion the "
      + "user read and to this intent's own expiry. BEFORE IT SIGNS it re-reads the session's selected "
      + "wallet, re-resolves the chain and requires it to still be the chain id that was approved, "
      + "re-reads the verified wrapped-native contract for that chain and requires it to still be the "
      + "one bound into the intent, RE-DERIVES the whole `{to, data, value}` triple from the approved "
      + "direction, contract and amount and compares all three byte for byte, then re-simulates. "
      + "REAL FAILURE MODES, every one of them leaving NOTHING SIGNED and no funds moved: a proposal "
      + "digest that does not match the row, an approval bound to a different proposal, an EXPIRED "
      + "intent, an ALREADY-CONSUMED or cancelled intent (an approval is never reusable), and a "
      + "re-derived transaction that differs in any of its three fields. The approved gas caps are "
      + "enforced on the request that is actually signed: a limit or price above them refuses before "
      + "signing. THE CONVERSION IS EXACTLY 1:1 with no slippage, no route and no price, the recipient "
      + "is always the signer, and VEX CHARGES NO FEE on this path - the only cost is network gas "
      + "inside the caps that were approved. RETURNS the outcome, txHash, chain, chainId, direction, "
      + "amountRaw, amountHuman, wrappedNativeContract and the echoed approvedFeeBounds, with a "
      + "DISTINCT outcome for confirmed, reverted on-chain, broadcast with confirmation UNKNOWN, and "
      + "failed before broadcast. Only the last is safe to prepare again: a reverted transaction is "
      + "real and paid a network fee, and an unknown one may be settling right now - Vex tracks it and "
      + "NEVER re-sends it, and neither should you.",
    parameters: {
      type: "object",
      properties: {
        intentId: {
          type: "string",
          description:
            "The intent id that `WalletWrapPrepare` returned. It is scoped to this session and to the "
            + "exact conversion that was approved.",
        },
      },
      required: ["intentId"],
    },
  },
];
