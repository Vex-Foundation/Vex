import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_EXECUTE_WRITE_DISCOVERY } from "../../embeddings/morpho/execute-writes.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import {
  MORPHO_DRY_RUN_PARAM_DESCRIPTION,
  MORPHO_GATING_SENTENCE,
  MORPHO_LEDGER_SENTENCE,
  MORPHO_QUOTE_FIRST_SENTENCE,
  MORPHO_RESIDUAL_SENTENCE,
  MORPHO_SHARE_FLOOR_SENTENCE,
  MORPHO_SLIPPAGE_PARAM_DESCRIPTION,
  MORPHO_TWO_TX_SENTENCE,
  MORPHO_VAULT_ADDRESS_PARAM_DESCRIPTION,
} from "./vault-execute-shared.js";

/**
 * `morpho.vault.deposit` - supply the wallet's own assets to a Morpho vault.
 *
 * THE FIRST MORPHO TOOL THAT SPENDS. Everything in this namespace before it read
 * or previewed; this one signs, broadcasts and moves real funds, so it carries
 * `mutating: true` and `actionKind: "user_wallet_broadcast"` and it is gated
 * twice over: the prequote gate refuses it without a fresh matching
 * `morpho.vault.quote` of kind `lend_deposit`, and the approval gate governs
 * whether it may broadcast at all under the session's permission.
 *
 * THE DESCRIPTION IS LONG ON PURPOSE and every paragraph of it is a safety claim
 * rather than prose: the two-transaction consent model, the exact-amount
 * approval, the non-atomicity and its remediations, the gating hazard, the
 * absolute share bound, and what the four endings mean. The shared sentences
 * live in `./vault-execute-shared.ts` so the withdrawal cannot drift from them.
 */
export const MORPHO_VAULT_DEPOSIT_TOOL: ProtocolToolManifest = {
  toolId: "morpho.vault.deposit",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "DEPOSIT the wallet's own assets into a Morpho vault and receive that vault's shares. This SPENDS real funds: it "
    + "signs and broadcasts on-chain transactions from the user's wallet and cannot be undone. Use it when the user "
    + "has decided to put money into a specific vault they already know the address of. "
    + `${MORPHO_QUOTE_FIRST_SENTENCE} `
    + `${MORPHO_TWO_TX_SENTENCE} `
    + `${MORPHO_RESIDUAL_SENTENCE} `
    + `${MORPHO_SHARE_FLOOR_SENTENCE} `
    + `${MORPHO_GATING_SENTENCE} `
    + `${MORPHO_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash, the assets that actually went in and the shares that were actually "
    + "minted, each with its own decimals, plus the accrual drift and the bound verdict. THE TWO SCALES ARE "
    + "DIFFERENT: shares are typically 18 decimals while a USDC asset is 6, so the two raw figures must never be "
    + "compared or presented as one quantity. On any non-success it returns the REAL cause and what to do about it, "
    + "never a generic error.",
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
      key: "depositAmountRaw",
      type: "string",
      required: true,
      description:
        "How much of the vault's ASSET to deposit, in that asset's RAW base units as a whole-number string. THE "
        + "SCALE IS THE VAULT ASSET'S OWN: read `asset.decimals` from `morpho.vault.get` for this vault, not the "
        + "vault's SHARE decimals, which are a different number reported beside it. A human amount is refused, not "
        + "rounded. It must equal the amount the quote priced.",
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
    depositAmountRaw: "1000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_EXECUTE_WRITE_DISCOVERY["morpho.vault.deposit"],
};
