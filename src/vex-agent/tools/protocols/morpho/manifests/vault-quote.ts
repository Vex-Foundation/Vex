import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_QUOTE_READ_DISCOVERY } from "../../embeddings/morpho/quote-reads.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS, VEX_MAX_SLIPPAGE_BPS } from "../../slippage-policy.js";

/**
 * `morpho.vault.quote` - price a vault deposit or withdrawal without doing one.
 *
 * WHY A READ TOOL LIVES IN A MUTATION LAYER. Everything under
 * `src/tools/morpho/mutations` builds, decodes and prices a transaction, and
 * NONE of it signs or sends one: `buildTx` is a pure encode, `getRequirements`
 * is a set of RPC reads, and the simulation is an `eth_call`. That makes this
 * tool `mutating: false` and `actionKind: "read"` as a fact about what it does
 * rather than a classification convenience. The `deriveOperation` lane labels it
 * operation "quote", which is intended.
 *
 * THE DECIMALS SENTENCE IS WRITTEN HERE RATHER THAN IMPORTED. Every other raw
 * amount in the tree ends with `CANONICAL_RAW_AMOUNT_SENTENCE`, which points the
 * agent at `token_find`. That is the wrong source twice over for this tool: the
 * scale that matters is the VAULT ASSET's, which is read off the vault itself
 * and is not the vault's SHARE scale reported next to it, and the canonical
 * sentence contains an em dash, which the morpho manifest suite bans in this
 * namespace. So each amount param names its own source in its own words.
 */
export const MORPHO_VAULT_QUOTE_TOOL: ProtocolToolManifest = {
  toolId: "morpho.vault.quote",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "PREVIEW one Morpho vault deposit or withdrawal end to end, without signing or sending anything. Use this BEFORE "
    + "recommending that a user put money into a vault or take it out, and whenever the question is 'how many shares "
    + "would I get', 'what would I have to approve first', or 'what would this cost in gas'. It builds the exact "
    + "transaction, decodes it leg by leg against Vex's own allowlist of permitted contracts and selectors, bounds "
    + "its gas with Vex's own headroom, and simulates it against current chain state. "
    + "RETURNS `input` and `expectedShares`, each as {raw, decimals, human, symbol}: on a deposit the asset going in "
    + "and the shares that would be minted, on a withdrawal the asset coming out and the shares that would be "
    + "burned. THE TWO SCALES ARE DIFFERENT and this is the most expensive confusion here: shares are typically 18 "
    + "decimals while a USDC asset is 6, so the two `raw` figures must never be compared, subtracted or presented as "
    + "one quantity. "
    + "`sharePrice` carries `assetsPerShareRaw` (what ONE whole share is worth now, in the asset's raw units), "
    + "`maxSharePriceRaw` (the ceiling the built transaction enforces ON CHAIN) and `vexCeilingRaw` (the ceiling Vex "
    + "derived independently and checked that guard against, rather than trusting the builder's own account of its "
    + "price protection). The last two are in a scaled unit comparable ONLY with each other, never with "
    + "`assetsPerShareRaw`. "
    + "`requirements` lists what the wallet would have to do FIRST, under Vex's approval policy: one plain ERC-20 "
    + "`approve()` for EXACTLY this operation's amount to the chain's pinned GeneralAdapter1, and nothing else. Vex "
    + "signs no permit and no permit2 message for Morpho, so any other spender or any other amount is REFUSED BY "
    + "NAME. An empty list means the wallet's existing allowance already covers this operation. Pass "
    + "`walletAddress` to have the requirements reflect that wallet's CURRENT allowance; without it they are what a "
    + "fresh wallet would face. "
    + "`bundle` is the decoded transaction: its shape, its target and that target's role, every leg with its "
    + "selector, signature, native value and a plain reading, and the amount and recipient the decoder PROVED the "
    + "bytes carry. A DEPOSIT IS A BUNDLER3 MULTICALL; A WITHDRAWAL IS NOT: withdrawals are a direct `withdraw` call "
    + "on the vault on both generations, and the decoder requires the shape to match the direction. So a withdrawal "
    + "legitimately has no legs, no `maxSharePriceRaw` and usually no requirements, and none of those absences is a "
    + "defect. "
    + "`gas` reports the node's fresh estimate and Vex's headroomed limit side by side, each labelled; a builder's or "
    + "provider's gas figure is a hint here and never a floor. "
    + "`preflight` is a NAMED THREE-WAY verdict, never a boolean: `ok` returned, `reverted` means the node PROVED a "
    + "revert and carries the reason, `transport-ambiguous` means the node did not answer so Vex does not know. A "
    + "DEPOSIT SIMULATION THAT REVERTS BEFORE THE APPROVAL EXISTS IS NORMAL AND IS NOT A FAULT IN THE VAULT: the "
    + "bundle pulls the asset through GeneralAdapter1, so with no approval there is nothing to pull. Report an "
    + "absent approval as an absent approval. The gas figures can be null for the same reason, and null is "
    + "reported as unavailable with a stated cause rather than guessed. "
    + "`governance` is lifted from Morpho's own vault read and carries the hazards the on-chain preview cannot see: "
    + "whether a gate contract can block a withdrawal or a deposit, the timelock a curator change waits out, how "
    + "many changes are ALREADY QUEUED, and any RED warning. NEVER recommend a deposit into a withdrawal-gated vault "
    + "without saying so first, and a deposit gate can refuse this very operation on chain however healthy the "
    + "numbers look. When that read fails, `governance.status` is `unavailable` and gating is UNKNOWN rather than "
    + "absent, which is not the same thing. Only V2 vaults have gates; a V1 vault has no such mechanism at all. "
    + "LIMITS: every figure is point-in-time and the share price accrues before any real transaction; Morpho "
    + "publishes no service guarantee. "
    + "Read-only. THIS IS A PREVIEW AND IT COMMITS NOTHING: nothing is signed, nothing is sent, no approval is "
    + "granted and no funds move. Present the result as what a transaction would do, never as something that has "
    + "been set up. It DOES authorize the matching execute for a limited time: `morpho.vault.deposit` and "
    + "`morpho.vault.withdraw` are REFUSED without a fresh quote for exactly the same params, and a quote for one "
    + "direction never authorizes the other.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "vaultAddress",
      type: "string",
      required: true,
      description:
        "The vault's 0x-prefixed 40-hex contract address, from `morpho.vaults.discover` or `morpho.vault.get`. A "
        + "64-hex value is rejected by name because that is a MARKET id, not a vault. Both generations are detected "
        + "automatically.",
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
      key: "direction",
      type: "string",
      required: true,
      enum: ["deposit", "withdraw"],
      description:
        "Which way the money would move: `deposit` puts the vault's asset in and mints shares, `withdraw` takes the "
        + "asset out and burns shares. It must AGREE with the amount parameter you send; a call whose direction and "
        + "amount key disagree is rejected by name rather than resolved either way.",
    },
    {
      key: "depositAmountRaw",
      type: "string",
      required: false,
      description:
        "How much of the vault's ASSET to price going IN, in that asset's RAW base units as a whole-number string. "
        + "Send it with `direction: deposit`, never alongside `withdrawAmountRaw`. THE SCALE IS THE VAULT ASSET'S "
        + "OWN: read `asset.decimals` from `morpho.vault.get` for this vault, not the vault's SHARE decimals, which "
        + "are a different number reported beside it. A human amount is refused, not rounded.",
    },
    {
      key: "withdrawAmountRaw",
      type: "string",
      required: false,
      description:
        "How much of the vault's ASSET to price coming OUT, in that asset's RAW base units as a whole-number "
        + "string. Send it with `direction: withdraw`, never alongside `depositAmountRaw`. THE SCALE IS THE VAULT "
        + "ASSET'S OWN: read `asset.decimals` from `morpho.vault.get` for this vault, not the SHARE decimals and "
        + "not the share count you want to burn, which is a different quantity in a different unit.",
    },
    {
      key: "slippageBps",
      type: "number",
      unit: "bps",
      description:
        `Price protection in basis points (1 bps = 0.01%). Default ${VEX_DEFAULT_SLIPPAGE_BPS} = `
        + `${VEX_DEFAULT_SLIPPAGE_BPS / 100}%. Vex caps this at ${VEX_MAX_SLIPPAGE_BPS} `
        + `(${VEX_MAX_SLIPPAGE_BPS / 100}%) and REJECTS a higher value rather than clamping it. On a DEPOSIT it `
        + "raises the maximum share price the transaction accepts on chain. A WITHDRAWAL has no share-price leg, so "
        + "the value binds on nothing there and the reply says so.",
    },
    {
      key: "walletAddress",
      type: "string",
      required: false,
      description:
        "The 0x-prefixed 40-hex account the preview is for. Supply it to have `requirements` reflect that wallet's "
        + "CURRENT allowance and permit state. Nothing is signed with it and no key is needed. Omit it entirely "
        + "rather than inventing a placeholder of your own.",
    },
  ],
  exclusiveParamGroups: [["depositAmountRaw", "withdrawAmountRaw"]],
  exampleParams: {
    vaultAddress: "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9",
    chain: "base",
    direction: "deposit",
    depositAmountRaw: "1000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_QUOTE_READ_DISCOVERY["morpho.vault.quote"],
};
