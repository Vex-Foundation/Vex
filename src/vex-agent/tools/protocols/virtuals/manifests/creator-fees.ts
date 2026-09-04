import type { ProtocolToolManifest } from "../../types.js";
import { VIRTUALS_CREATOR_FEES_DISCOVERY } from "../../embeddings/virtuals/creator-fees.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VIRTUALS_CHAIN_SLUGS } from "../chain-param.js";
import { VIRTUALS_TAX_CHAIN_SLUGS } from "@tools/virtuals/creator-fees/deployments.js";

// The creator-side read. It exists because the honest answer to "what have my
// agent's fees earned me, and can I take it" has two halves that point in
// opposite directions: the amounts are fully on chain and exact, and the
// collection is not ours to perform. A tool that returned only the first half
// would read as an invitation to claim; one that returned only the second would
// read as "you have nothing".
//
// Both halves are MEASURED at the same block: the amounts from
// `getTokenTaxAmounts`, the authority from `hasRole(SWAP_ROLE, creator)`.
//
// WHY `chain` ADVERTISES ALL FOUR VIRTUALS CHAINS AND NOT JUST THE TWO THAT
// ANSWER. Narrowing the enum to base and robinhood would make the runtime
// refuse `solana` at the param boundary with a schema message ("allowed values
// ..."), which reads to a model like a mistake in its own call and says nothing
// about the provider. The namespace's chain vocabulary is four values on every
// other tool here, and an agent that just read `chain: "solana"` off a discover
// row deserves the MEASURED answer instead: AgentTaxV2 is an EVM contract and
// Virtuals deploys the launchpad V5 suite on base and robinhood only. So the
// enum stays the namespace's own, and the handler answers the two uncovered
// chains with `supported: false` plus that reason - the arc's rule that a
// closed path returns a typed unsupported outcome with its measured reason.

export const VIRTUALS_CREATOR_FEES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.creator_fees",
    publicName: "virtuals__creator_fees_get",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "What the CREATOR of one Virtuals agent has earned from its bonding-curve trading tax, read straight from the AgentTaxV2 contract at a single pinned block. Use this when the user asks what their agent has made, what is still owed to them, whether their creator fees have been paid out, or how the fee split works. Name the agent with tokenAddress (the agent token's contract) or id (the numeric Virtuals agent id), plus chain. "
      + "TWO ASSETS AT TWO SCALES, AND THE REPLY NEVER MIXES THEM: tax is COLLECTED in VIRTUAL (18 decimals) and the creator is PAID in USDC on base (6 decimals) or USDG on robinhood (6 decimals), so every amount carries its asset address, symbol, decimals, raw integer and human string. You get `accrued` (collected, swapped, pending = collected - swapped, plus the contract's own minSwapThreshold/maxSwapThreshold and whether pending has reached the threshold that lets the next swap move it), `creator` (the address the contract pays, its token-bound account, and whether that matches the wallet the Virtuals API shows), `split` (protocol fee, any partner fee and the creator's remaining share, all as parts in 10000 applied to the SWAP OUTPUT), and `providerRevenueClaim`. "
      + "THE CLAIM IS `unsupported`, WITH THE MEASUREMENT THAT PROVES IT, AND THAT IS THE POINT: AgentTaxV2 pays a creator only inside its swap-and-distribute path, reachable only through `swapForTokenAddress`/`batchSwapForTokenAddress`, both gated on SWAP_ROLE. Virtuals' backend holds that role and runs it; the creator wallet does not, so there is NO transaction Vex could sign that collects this, and the tool reads `hasRole(SWAP_ROLE, creator)` live to say so. Nothing is left for the creator to claim afterwards either - when the backend swaps, the creator's share is transferred to the creator address automatically. Collection is triggered from the Virtuals app, and the reply names it. "
      + `CHAIN COVERAGE IS MEASURED: AgentTaxV2 exists on ${VIRTUALS_TAX_CHAIN_SLUGS.join(" and ")} only; solana and ethereum answer \`supported: false\` with that reason rather than a zero. A token with no tax recipient registered is reported as \`registered: false\` with the contract's own refusal ("Token not registered"), never as "no fees". A chain that will not answer is a failure with its reason and is never reported as an empty balance. Read-only: this tool signs nothing and needs no wallet.`,
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "chain",
        type: "string",
        required: true,
        enum: [...VIRTUALS_CHAIN_SLUGS],
        description:
          `The chain the agent lives on. Creator fees are held by a per-chain contract with its own payout asset and its own swap thresholds, so the chain and the agent must agree. Only ${VIRTUALS_TAX_CHAIN_SLUGS.join(" and ")} have an AgentTaxV2; solana and ethereum are accepted and answered with \`supported: false\` and the measured reason rather than a schema error. ${CANONICAL_CHAIN_SENTENCE}`,
      },
      {
        key: "tokenAddress",
        type: "string",
        description:
          "The agent token's CONTRACT address - the bonding token while the agent is still on its curve, the same address after graduation. This is the key AgentTaxV2 accounts by, so it needs no provider lookup and works even when the Virtuals API is down. Give this OR id, never both.",
      },
      {
        key: "id",
        type: "number",
        description:
          "The numeric Virtuals agent id, exactly as virtuals__agents_discover returns it. The tool resolves the agent's bonding token from it and additionally cross-checks the contract's creator address against the wallet the provider shows. Give this OR tokenAddress, never both.",
      },
    ],
    exampleParams: { chain: "base", id: 135655 },
    discovery: VIRTUALS_CREATOR_FEES_DISCOVERY["virtuals.creator_fees"],
  },
];
