/**
 * Trench Express money-path manifests (P2): the curve quote (read-only, records
 * the prequote the execute is gated against) and the curve buy/sell execute
 * (mutating, staged-broadcast, approval-gated).
 *
 * Both use swap-shaped params (`chain`, `tokenIn`, `tokenOut`, `amountIn`) so the
 * quote↔execute prequote match-hash binds tokenIn/tokenOut/amount/chain/provider
 * ("trench") exactly as the other swap venues do. A BUY passes `tokenIn:"ETH"`
 * and the token address as `tokenOut`; a SELL passes the token address as
 * `tokenIn` and `tokenOut:"ETH"`. `min`, `deadline`, `recipient` and any fee
 * parameter are NEVER accepted from the caller — Vex derives them.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_TRADE_DISCOVERY } from "../../embeddings/trench/trade.js";

const TRADE_PARAMS = [
  { key: "chain", type: "string" as const, required: false, description: 'Chain — Robinhood Chain / "robinhood" (the only chain; defaults to robinhood).' },
  { key: "tokenIn", type: "string" as const, required: true, description: 'Input token: "ETH" for a BUY, or the curve token address for a SELL.' },
  { key: "tokenOut", type: "string" as const, required: true, description: 'Output token: the curve token address for a BUY, or "ETH" for a SELL.' },
  { key: "amountIn", type: "string" as const, required: true, description: "Human amount of the input token (ETH for a buy, tokens for a sell), e.g. \"0.01\"." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: "Slippage tolerance in basis points (1 bps = 0.01%) for ETH-curve trading on Robinhood Chain; default 100 = 1%, which fits this deterministic, fee-inclusive curve. Pass the SAME value on trench.trade_quote and trench.trade_execute, or omit it on both — a mismatch blocks the execute (the prequote match requires identical params). It is the ONLY price protection on the trade: Vex derives the raw minimum output from a fresh quote at this tolerance (never zero, never from you). A thin or volatile fresh curve token can move between quote and broadcast, so raise it there. A too-tight tolerance USUALLY fails for FREE — the pre-sign gas estimate is refused before anything is signed, NO gas is spent, and the execute returns status \"not_attempted\" with failureCode slippage; LESS OFTEN the curve moves after that estimate passes and the transaction REVERTS after broadcast, recording mined_revert with the gas SPENT. After either, re-quote with a higher slippageBps and pass the same value. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept." },
];

export const TRENCH_TRADE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.trade_quote",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Read-only price quote for buying or selling a Trench Express bonding-curve token on Robinhood Chain (4663): reads the curve on-chain and returns the exact, fee-inclusive expected output, the 1% ETH-leg fee, the price impact against the curve reserves, and progress toward graduation. Records the quote so a matching trench.trade_execute can broadcast. Signs nothing and moves no funds. Pass tokenIn=\"ETH\" + tokenOut=<token> for a buy, or tokenIn=<token> + tokenOut=\"ETH\" for a sell.",
    mutating: false,
    actionKind: "read",
    params: TRADE_PARAMS,
    exampleParams: { chain: "robinhood", tokenIn: "ETH", tokenOut: "0x58659Ef9Be57216632BFD341FC57736a429EFB91", amountIn: "0.01" },
    discovery: TRENCH_TRADE_DISCOVERY["trench.trade_quote"],
  },
  {
    toolId: "trench.trade_execute",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Buy or sell a Trench Express bonding-curve token on Robinhood Chain (4663): a BUY spends ETH to acquire the token; a SELL approves then swaps the token back for ETH. Vex derives a minimum-output floor from a fresh on-chain quote (never zero, never from the caller) and sets the deadline locally; a 1% fee applies to the ETH leg. Spends real funds and is approval-gated — requires a fresh matching trench.trade_quote first. Pass tokenIn=\"ETH\" + tokenOut=<token> for a buy, or tokenIn=<token> + tokenOut=\"ETH\" for a sell.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: TRADE_PARAMS,
    exampleParams: { chain: "robinhood", tokenIn: "ETH", tokenOut: "0x58659Ef9Be57216632BFD341FC57736a429EFB91", amountIn: "0.01" },
    discovery: TRENCH_TRADE_DISCOVERY["trench.trade_execute"],
  },
];
