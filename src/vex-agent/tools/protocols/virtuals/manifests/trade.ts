/**
 * The two Virtuals bonding-curve TRADE tools: quote and execute.
 *
 * They are named by FAMILY (`virtuals__agent_trade_*`) rather than by chain or
 * by side, because one curve surface serves both chains and both directions and
 * a second launchpad must not mint a second copy of every tool.
 *
 * EVERY CONTRACT FACT IN THESE DESCRIPTIONS WAS MEASURED on 2026-09-04 against
 * the live chains and against the first-party Solidity, and the provenance is in
 * `src/tools/virtuals/Virtuals.md`. The descriptions are long on purpose: an
 * agent choosing between a curve trade and an AMM swap needs to know that a
 * graduated agent is not tradable here, that the sell floor bounds a GROSS
 * amount, and that an active anti-sniper window can take up to 99 percent - and
 * none of those is guessable from a signature.
 */

import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS, VEX_MAX_SLIPPAGE_BPS } from "../../slippage-policy.js";
import { VIRTUALS_TRADE_DISCOVERY } from "../../embeddings/virtuals/trade.js";
import { VIRTUALS_CHAIN_SLUGS } from "../chain-param.js";
import { VIRTUALS_CURVE_FEE_BPS } from "@tools/virtuals/curve/index.js";

/** The shared shape of a trade call, so quote and execute cannot drift apart. */
function tradeParams(): ProtocolParamDef[] {
  return [
    {
      key: "chain",
      type: "string",
      required: true,
      enum: VIRTUALS_CHAIN_SLUGS,
      description:
        "REQUIRED. The chain the agent lives on. Vex signs bonding-curve trades on base and robinhood; solana and "
        + `ethereum answer with a typed hand-off naming the tool that does trade them. ${CANONICAL_CHAIN_SENTENCE}`,
    },
    {
      key: "token",
      type: "string",
      required: true,
      description:
        "REQUIRED. The agent's ERC-20 contract address, exactly as virtuals__agents_discover and virtuals__agent_get "
        + "return it: `preToken` while the agent is still on its bonding curve, `tokenAddress` once it has graduated. "
        + "The chain decides what is tradable here, not the API row: BondingV5 is re-read for every call.",
    },
    {
      key: "side",
      type: "string",
      required: true,
      enum: ["buy", "sell"],
      description:
        "REQUIRED. buy spends VIRTUAL and receives the agent token; sell spends the agent token and receives VIRTUAL. "
        + "The two are priced by different contract paths and are never interchangeable: a buy quote can never "
        + "authorize a sell.",
    },
    {
      key: "amountIn",
      type: "string",
      required: true,
      description:
        "REQUIRED. A plain decimal amount in WHOLE tokens, never wei and never a float: on a buy it is the total "
        + "VIRTUAL you commit (Vex's fee comes out of it, so this is exactly what leaves the wallet); on a sell it is "
        + "the agent tokens you sell.",
    },
    {
      key: "slippageBps",
      type: "number",
      unit: "bps",
      description:
        `Slippage tolerance in basis points (1 bps = 0.01%). Default ${VEX_DEFAULT_SLIPPAGE_BPS}. Vex caps it at `
        + `${VEX_MAX_SLIPPAGE_BPS} bps and REFUSES a higher value by name rather than clamping it. On a buy it bounds `
        + "the agent tokens delivered; on a sell it bounds the router's GROSS VIRTUAL output before the curve's taxes, "
        + "which is what the contract actually compares.",
    },
    {
      key: "acceptAntiSniperTaxPct",
      type: "number",
      description:
        "The maximum anti-sniper tax, in WHOLE PERCENT (1-98), you accept on the side you are trading. OMIT IT to "
        + "accept none, which is the default and refuses any active window. A fresh Virtuals launch is taxed by "
        + "FRouterV3 starting at 99% and decaying linearly to zero over the window its anti-sniper type defines (60s, "
        + "600s or 5880s), so a trade inside that window can lose almost the whole amount. This parameter is consent "
        + "to a BOUND, not to a value: the quote shows the current percent and the seconds remaining, and the execute "
        + "refuses if the percent has risen above what you accepted.",
    },
  ];
}

export const VIRTUALS_TRADE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.trade.quote",
    publicName: "virtuals__agent_trade_quote",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Price a BONDING-CURVE buy or sell of one Virtuals agent token and return the whole approval preview. Read-only: "
      + "nothing is signed and no allowance is granted. Everything it states is read from the CHAIN at one pinned "
      + "block - BondingV5's own lifecycle flags, FFactoryV2's protocol tax, the pair's anti-sniper clock and "
      + "FRouterV3.getAmountsOut - never from the Virtuals API, which this namespace uses for discovery only. The "
      + "answer carries: the agent and its curve pair, the BondingV5 and FRouterV3 addresses AND the exact proxy "
      + "implementations behind them, the total debited, the amount that reaches the curve, the curve's protocol tax "
      + "and any anti-sniper tax, the quoted output, the floor the contract will enforce, Vex's fee, the wallet's "
      + "balance and allowance, a proposalId and an expiry. THE TWO FLOORS ARE NOT THE SAME THING: on a buy the "
      + "contract floor bounds the agent tokens delivered; on a sell it bounds the router's GROSS VIRTUAL BEFORE the "
      + "curve removes its taxes, so the reply also shows a walletNetMin clearly labelled as an ESTIMATE the contract "
      + "does not enforce. IT REFUSES rather than guessing: a graduated agent answers with the AMM tool and pool to "
      + "use instead, solana answers with the Jupiter tools (its curve is a Meteora pool, not BondingV5), ethereum "
      + "has no curve at all, an unreadable tax or anti-sniper clock is refused rather than treated as zero, and an "
      + "ACTIVE anti-sniper window is refused unless you passed acceptAntiSniperTaxPct. Feed the proposalId and the "
      + "identical parameters to virtuals__agent_trade_execute; any difference is refused by name.",
    mutating: false,
    actionKind: "read",
    params: tradeParams(),
    exampleParams: { chain: "base", token: "0x1984edF491D3399FBc09E6d0856E01fF3721f952", side: "buy", amountIn: "0.5" },
    discovery: VIRTUALS_TRADE_DISCOVERY["virtuals.trade.quote"],
  },
  {
    toolId: "virtuals.trade.execute",
    publicName: "virtuals__agent_trade_execute",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Execute a BONDING-CURVE buy or sell of a Virtuals agent token against a quote you already took. REAL FUNDS, and "
      + "IRREVERSIBLE once broadcast. It "
      + "requires the proposalId from virtuals__agent_trade_quote plus the IDENTICAL chain, token, side, amountIn and "
      + "slippageBps; a changed parameter is refused by name rather than re-priced. Before anything is signed it "
      + "re-reads the chain and refuses if the BondingV5 or FRouterV3 proxy was upgraded, if the agent graduated or "
      + "stopped trading, if the curve's tax setup changed, if the anti-sniper tax rose above the bound you accepted, "
      + "or if the curve can no longer reach the floor your quote authorized - the floor is the one your quote sealed "
      + "and is never re-derived from a fresher price. It sends up to three transactions: an EXACT-amount approval to "
      + `FRouterV3 when the allowance is short (never unlimited), the curve trade, and Vex's ${VIRTUALS_CURVE_FEE_BPS} `
      + "bps fee as a separate VIRTUAL transfer that runs ONLY after the trade confirms - a trade that does not happen "
      + "is never charged. On a buy the fee is taken from the VIRTUAL you commit; on a sell it is taken from the "
      + "VIRTUAL you actually receive, decoded from the receipt, and if those proceeds cannot be decoded Vex takes no "
      + "fee at all. NOTHING IS EVER RETRIED: a trade whose outcome is unknown stays pending and is reconciled. Pass "
      + "simulateOnly: true (after a quote for the identical params, and with no proposalId, since nothing is "
      + "claimed) to get the exact transactions eth_call'd from your wallet with `executed: false` - no signer "
      + "opened, no quote consumed, nothing broadcast. It returns `executed`, `txHash`, `chain`, `chainId`, `venue`, "
      + "`side`, `token`, `symbol`, `status` (confirmed, confirmed_unrecorded, confirmed_pending_amounts or "
      + "pending_unknown), `settlement` (the decoded `spent`/`received` amounts with their raw values and symbols, or "
      + "`decoded: false` with the reason the receipt could not be read), `enforcedFloor` (the contract floor the "
      + "chain actually enforced) and `vexFee`.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      ...tradeParams(),
      {
        key: "proposalId",
        type: "string",
        // CONDITIONALLY required, which the manifest flag cannot express: a real
        // execute needs it, and `simulateOnly: true` must NOT, because the
        // simulation runs before the quote is claimed and exists precisely so a
        // caller can inspect the plan without having taken a quote yet. Marking
        // it `required` made the runtime's parameter validator refuse every
        // simulateOnly call before the handler ever ran (measured live,
        // 2026-09-04). The handler owns the conditional rule and refuses a real
        // execute without it, by name.
        required: false,
        description:
          "REQUIRED for a real execute, and REJECTED as unnecessary reasoning for simulateOnly: pass the proposalId "
          + "virtuals__agent_trade_quote returned. It is the digest of everything that quote bound - the contracts "
          + "and their implementations, the side, the amounts, the fee, the taxes and the floor - so passing it "
          + "proves the trade being executed is the trade that was priced. A stale or mismatched proposalId is "
          + "refused and nothing is signed. Omit it ONLY together with simulateOnly: true, which signs nothing.",
      },
      {
        key: "simulateOnly",
        type: "boolean",
        description:
          "When true, stop at the edge of signing: re-read the chain, re-price, build the exact transactions and "
          + "eth_call each of them from your wallet address, then return them with `executed: false`. No signing key "
          + "is opened, NO QUOTE IS CONSUMED, no activity row is written and nothing is broadcast. It still needs a "
          + "FRESH QUOTE for the identical parameters, because it is inspecting a real proposal rather than an "
          + "imaginary one - take the quote first, then simulate with the same chain, token, side, amountIn and "
          + "slippageBps and no proposalId. A leg that depends on an allowance the wallet does not hold yet reverts "
          + "in the simulation by construction, and that is reported rather than hidden.",
      },
    ],
    exampleParams: {
      chain: "base",
      token: "0x1984edF491D3399FBc09E6d0856E01fF3721f952",
      side: "buy",
      amountIn: "0.5",
      proposalId: "<proposalId from virtuals__agent_trade_quote>",
    },
    discovery: VIRTUALS_TRADE_DISCOVERY["virtuals.trade.execute"],
  },
];
