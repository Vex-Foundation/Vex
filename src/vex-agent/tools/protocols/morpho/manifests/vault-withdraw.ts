import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_EXECUTE_WRITE_DISCOVERY } from "../../embeddings/morpho/execute-writes.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import {
  MORPHO_DRY_RUN_PARAM_DESCRIPTION,
  MORPHO_GATING_SENTENCE,
  MORPHO_LEDGER_SENTENCE,
  MORPHO_QUOTE_FIRST_SENTENCE,
  MORPHO_SHARE_FLOOR_SENTENCE,
  MORPHO_SLIPPAGE_PARAM_DESCRIPTION,
  MORPHO_VAULT_ADDRESS_PARAM_DESCRIPTION,
} from "./vault-execute-shared.js";

/**
 * `morpho.vault.withdraw` - redeem the wallet's assets back out of a Morpho
 * vault.
 *
 * STRUCTURALLY SIMPLER THAN THE DEPOSIT, AND THE DIFFERENCE IS REAL RATHER THAN
 * A SIMPLIFICATION. A withdrawal is a DIRECT `withdraw()` call on the vault
 * itself on both vault generations: the vault burns the caller's OWN shares, so
 * nothing has to be authorised to pull anything. That means no approval leg, no
 * Bundler3 multicall, no residual-allowance failure mode, and no on-chain
 * share-price guard. None of those absences is a missing step, and the manifest
 * says so rather than leaving the agent to wonder what it forgot.
 *
 * It still spends: it signs and broadcasts one real transaction, so it is
 * `mutating: true`, `actionKind: "user_wallet_broadcast"`, prequote-gated on a
 * fresh `lend_withdraw` quote and subject to the approval gate.
 */
export const MORPHO_VAULT_WITHDRAW_TOOL: ProtocolToolManifest = {
  toolId: "morpho.vault.withdraw",
  publicName: "morpho__vault_withdraw",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "WITHDRAW assets out of a Morpho vault back to the user's wallet, burning the vault shares it holds. This SPENDS "
    + "gas and signs an on-chain transaction from the user's wallet. Use it when the user wants their money out of a "
    + "vault they are already in. "
    + `${MORPHO_QUOTE_FIRST_SENTENCE} `
    + "WHAT GETS SIGNED: ONE transaction, and only one. A withdrawal is a DIRECT call on the vault on both "
    + "generations, so there is no approval, no bundle and no standing allowance left behind. Ask for the amount in "
    + "the vault's ASSET, not in shares; the shares to burn are derived. "
    + `${MORPHO_SHARE_FLOOR_SENTENCE} A withdrawal carries no on-chain share-price leg, so on this side the bound is `
    + "Vex's own report on the burn rather than something the chain refused, and the reply says so. "
    + `${MORPHO_GATING_SENTENCE} A withdrawal gate is the sharper case: it can refuse the exit itself. `
    + `${MORPHO_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash, the shares that were actually burned and the assets that actually "
    + "came out, each with its own decimals, plus the accrual drift and the bound verdict. THE TWO SCALES ARE "
    + "DIFFERENT and the raw figures must never be compared or presented as one quantity. On any non-success it "
    + "returns the REAL cause and what to do about it, never a generic error. "
    + "Pass `dryRun: true` to get the full preview and sign nothing.",
  mutating: true,
  actionKind: "user_wallet_broadcast",
  params: [
    {
      key: "vaultAddress",
      type: "string",
      required: true,
      description: MORPHO_VAULT_ADDRESS_PARAM_DESCRIPTION,
    },
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        `The chain the vault lives on. ${CANONICAL_CHAIN_SENTENCE} Required because a vault address is chain-scoped: `
        + "the same address on the wrong chain is a different contract entirely.",
    },
    {
      key: "withdrawAmountRaw",
      type: "string",
      required: true,
      description:
        "How much of the vault's ASSET to take out, in that asset's RAW base units as a whole-number string. THE "
        + "SCALE IS THE VAULT ASSET'S OWN: read `asset.decimals` from `morpho.vault.get` for this vault, not the "
        + "SHARE decimals and not the share count you want to burn, which is a different quantity in a different "
        + "unit. A human amount is refused, not rounded. It must equal the amount the quote priced.",
    },
    {
      key: "slippageBps",
      type: "number",
      unit: "bps",
      description: MORPHO_SLIPPAGE_PARAM_DESCRIPTION,
    },
    {
      key: "dryRun",
      type: "boolean",
      description: MORPHO_DRY_RUN_PARAM_DESCRIPTION,
    },
  ],
  exampleParams: {
    vaultAddress: "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9",
    chain: "base",
    withdrawAmountRaw: "1000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_EXECUTE_WRITE_DISCOVERY["morpho.vault.withdraw"],
};
