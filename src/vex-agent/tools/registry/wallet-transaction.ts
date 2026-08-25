/**
 * Generic transaction signing tools - two family pairs over one shared policy,
 * persistence, decode, preview and execution layer.
 *
 * TWO PAIRS AND NOT ONE, because `ToolDef.JsonSchema` cannot express a
 * top-level discriminated union: an EVM proposal is `to`/`data`/`valueWei` with
 * gas caps, a Solana proposal is a serialized message with compute-unit caps,
 * and a merged manifest would document every field as optional and leave the
 * model to guess which half applies. The shared layers are MODULES
 * (`internal/wallet/transaction/*`), not a merged manifest.
 *
 * Risk class first in every description: prepare signs nothing and spends
 * nothing, confirm is the irreversible call. Unit sentences are per field, and
 * every raw value says RAW: `valueWei` is wei, gas caps are wei, Solana caps are
 * lamports and micro-lamports.
 */

import type { ToolDef } from "../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../protocols/conventions.js";

const EVM_FEE_BOUNDS_SENTENCE =
  "REQUIRED fee cap. Vex never derives a spending limit from a network estimate, so calling without "
  + "the caps refuses by name and returns the current estimate as a labelled hint you can choose from.";

export const WALLET_TRANSACTION_TOOLS: readonly ToolDef[] = [
  {
    name: "WalletEvmTransactionPrepare",
    kind: "internal",
    mutating: false,
    pressureSafety: "mutating",
    actionKind: "approval_prepare",
    description:
      "Prepare an ARBITRARY EVM transaction for approval. It SPENDS NOTHING and signs nothing: it "
      + "decodes the calldata, simulates it, records one durable intent and hands back its id. THE "
      + "INTENT IS WHAT GETS APPROVED, so the decoded effects and the fee caps recorded here are "
      + "exactly what the user is shown and confirms. Use this when the user wants to send a "
      + "transaction Vex has no dedicated tool for, and before any call to `WalletEvmTransactionConfirm` "
      + "- confirm has no other way to obtain an intentId. DECODE IS FAIL CLOSED: the v1 set is ERC-20 "
      + "transfer/approve/transferFrom/increaseAllowance/permit, Permit2 approve/permit/transferFrom at "
      + "the canonical Permit2 address for the chain, and a plain native transfer with `data` of `0x` "
      + "sent to an address that has no code. An unknown selector, a malformed layout, a Permit2 call "
      + "to any other address, or empty calldata sent to a contract is REFUSED BY NAME before an intent "
      + "exists; router and aggregator calldata is deliberately outside v1. A caller-supplied `from`, "
      + "fee payer or fee receiver is refused by name too: the sender is the wallet selected for this "
      + "session. VEX FEE: Vex charges 25 bps (0.25%) of this transaction's own valueWei, as a "
      + "SEPARATE transfer to the Vex treasury that runs only AFTER the transaction confirms, with "
      + "its own bounded network fee on top of the transaction's. A zero-value transaction - every "
      + "ERC-20 transfer and every approve - pays NOTHING. Nor is anything charged when the 25 bps "
      + "would be at or below what its own collection transfer could cost at the gas caps you set: "
      + "Vex does not take a fee that costs the user more to collect than it is worth. Whichever "
      + "applies is shown ON THE APPROVAL CARD, with its amount, the treasury address and that extra "
      + "network-fee ceiling, or the explicit reason no fee is taken. The fee is not a parameter and "
      + "cannot be set, redirected or waived by a caller. RETURNS intentId, chain, chainId, "
      + "walletAddress, status 'prepared', expiresAt, the decoded effects, the approval preview, "
      + "approvedFeeBounds echoing the caps you supplied, and vexFee stating the charge or the reason "
      + "there is none. The intent is scoped to this session, expires in 10 minutes, and binds the "
      + "wallet selected right now; if that selection changes, confirm refuses rather than signing "
      + "from another address.",
    parameters: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description: `The EVM chain the transaction executes on. ${CANONICAL_CHAIN_SENTENCE}`,
        },
        to: {
          type: "string",
          description:
            "Destination address (0x, 20 bytes): the contract being called, or the recipient for a "
            + "plain native transfer.",
        },
        data: {
          type: "string",
          description:
            "Transaction calldata as 0x-prefixed hex. Pass `0x` (the default) for a plain native "
            + "transfer, which is accepted only when `to` has no contract code.",
        },
        valueWei: {
          type: "string",
          description:
            "Native coin to send with the call, in RAW wei as a decimal integer STRING (never a human "
            + "decimal such as \"0.1\", never a JSON number). Defaults to \"0\". Must be \"0\" for a "
            + "contract call: every function in the v1 decode set is non-payable.",
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
      required: ["chain", "to", "gasLimit"],
    },
  },
  {
    name: "WalletEvmTransactionConfirm",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    actionKind: "user_wallet_broadcast",
    description:
      "Broadcast the EVM transaction that `WalletEvmTransactionPrepare` already prepared. This is the "
      + "call that SPENDS REAL FUNDS: it signs with the user's wallet and sends an IRREVERSIBLE "
      + "on-chain transaction. APPROVAL: in a restricted session it signs nothing, decrypts nothing "
      + "and consumes nothing - it comes back asking for approval, and that approval is bound to the "
      + "exact decoded proposal and to this intent's own expiry. BEFORE IT SIGNS it re-reads the "
      + "session's selected wallet, re-resolves the chain, re-decodes the calldata against current "
      + "chain state (which re-checks that a `data` of `0x` still targets an address with no code), "
      + "re-simulates, and re-derives the proposal digest; any drift REFUSES BY NAME with nothing "
      + "signed and the intent left pending. The approved fee caps are enforced on the request that "
      + "is actually signed: a gas limit or price above them refuses before signing. RETURNS the "
      + "outcome, txHash, chain and the echoed approvedFeeBounds, with a DISTINCT outcome for "
      + "confirmed, reverted on-chain, broadcast with confirmation UNKNOWN, and failed before "
      + "broadcast. Only the last is safe to prepare again: a reverted transaction is real and paid "
      + "a network fee, and an unknown one may be settling right now - Vex tracks it and NEVER "
      + "re-sends it, and neither should you. VEX FEE: the 25 bps fee shown on the approval card is "
      + "charged ONLY if this transaction CONFIRMS, as a separate treasury transfer signed afterwards "
      + "under its own bounded gas ceiling. A transaction that reverts, stays unconfirmed or refuses "
      + "before broadcast is never charged. A fee that fails, reverts or cannot be confirmed leaves "
      + "this transaction completely unaffected and is NEVER re-sent. The result echoes vexFee with "
      + "its own outcome, the amount planned, and - only where the chain proved it - the amount "
      + "collected.",
    parameters: {
      type: "object",
      properties: {
        intentId: {
          type: "string",
          description:
            "The intent id that `WalletEvmTransactionPrepare` returned. It is scoped to this session "
            + "and to the exact proposal that was approved.",
        },
      },
      required: ["intentId"],
    },
  },
  {
    name: "WalletSolanaTransactionPrepare",
    kind: "internal",
    mutating: false,
    pressureSafety: "mutating",
    actionKind: "approval_prepare",
    description:
      "Prepare an ARBITRARY Solana transaction for approval. It SPENDS NOTHING and signs nothing, and "
      + "it never touches a private key: it verifies the fee payer and sole-signer shape against the "
      + "wallet selected for this session, INSTALLS A FRESH BLOCKHASH before anything is simulated or "
      + "shown, decodes every instruction, simulates the canonical message and records one durable "
      + "intent. The fresh blockhash matters: it means the message the user approves is byte-for-byte "
      + "the message that will be signed. Use this when the user wants to send a Solana transaction Vex "
      + "has no dedicated tool for, and before any call to `WalletSolanaTransactionConfirm`. DECODE IS "
      + "FAIL CLOSED and allowlists exact instruction VARIANTS, not program names: System transfer, "
      + "classic SPL Token transfer/transferChecked/approve/revoke, ComputeBudget compute-unit limit "
      + "and price, and Memo. TOKEN-2022 IS REFUSED BY NAME because its extensions can add a transfer "
      + "fee or invoke an external hook program on every transfer. Versioned messages resolve their "
      + "address lookup tables first, and an unresolvable table refuses. A caller-supplied fee payer or "
      + "redirect field is refused by name. RETURNS intentId, walletAddress, feePayer, status "
      + "'prepared', recentBlockhash, lastValidBlockHeight, canonicalMessageBase64, the decoded "
      + "instructions, the approval preview, approvedFeeBounds and expiresAt. That displayed expiry is "
      + "a 60 second readability cap; lastValidBlockHeight is the real bound and confirm rechecks the "
      + "current block height against it.",
    parameters: {
      type: "object",
      properties: {
        transactionBase64: {
          type: "string",
          description:
            "The UNSIGNED Solana transaction or transaction message, base64 encoded. A proposal that "
            + "already carries a signature is refused, because preparing installs a fresh blockhash "
            + "and would invalidate it.",
        },
        computeUnitLimit: {
          type: "string",
          description:
            "REQUIRED cap on the requested COMPUTE UNITS, as a decimal integer string. The priority "
            + "fee is charged on the requested limit rather than on units actually used, so this is "
            + "part of what you authorize. Calling without the caps refuses by name and returns the "
            + "current network estimate as a labelled hint.",
        },
        computeUnitPriceMicroLamports: {
          type: "string",
          description:
            "REQUIRED cap on the priority price per compute unit, in RAW micro-lamports as a decimal "
            + "integer string. Together with computeUnitLimit it fixes the maximum priority fee in "
            + "lamports, which is echoed back in approvedFeeBounds.",
        },
      },
      required: ["transactionBase64", "computeUnitLimit", "computeUnitPriceMicroLamports"],
    },
  },
  {
    name: "WalletSolanaTransactionConfirm",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    actionKind: "user_wallet_broadcast",
    description:
      "Broadcast the Solana transaction that `WalletSolanaTransactionPrepare` already prepared. This "
      + "is the call that SPENDS REAL FUNDS: it signs with the user's wallet and sends an "
      + "IRREVERSIBLE transaction. APPROVAL: in a restricted session it signs nothing, decrypts "
      + "nothing and consumes nothing - it comes back asking for approval, and that approval is bound "
      + "to the exact canonical message and to this intent's own expiry. BEFORE IT SIGNS it re-reads "
      + "the session's selected wallet, checks the CURRENT BLOCK HEIGHT against the intent's "
      + "lastValidBlockHeight (the real expiry; the displayed 60 second cap is only for readability), "
      + "re-resolves every address lookup table, re-decodes every instruction, re-simulates, checks "
      + "the message's own compute-budget instructions against the approved lamport ceiling, and "
      + "asserts the message bytes are UNCHANGED with only the signature slot differing. Any drift "
      + "REFUSES BY NAME with nothing signed and the intent left pending. RETURNS the outcome, the "
      + "transaction signature and the echoed approvedFeeBounds, with a DISTINCT outcome for "
      + "confirmed, failed on-chain, broadcast with confirmation UNKNOWN, and failed before "
      + "broadcast. Only the last is safe to prepare again: Vex tracks an unknown one and NEVER "
      + "re-sends it, and neither should you.",
    parameters: {
      type: "object",
      properties: {
        intentId: {
          type: "string",
          description:
            "The intent id that `WalletSolanaTransactionPrepare` returned. It is scoped to this "
            + "session and to the exact canonical message that was approved.",
        },
      },
      required: ["intentId"],
    },
  },
];
