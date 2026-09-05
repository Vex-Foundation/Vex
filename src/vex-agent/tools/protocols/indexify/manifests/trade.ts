/**
 * Indexify trading manifests — the fee preview (public) and the two mutations.
 *
 * INDEXIFY IS A CUSTODIAL VENUE. `trade_execute` and `order_resolve` move the
 * LINKED INDEXIFY ACCOUNT's funds via an authenticated API call: the venue
 * executes server-side and answers with an order id. There is no local
 * transaction, no simulation, and no signature — which is why both carry
 * `actionKind: "external_post"` (the CEX-order class), are approval-gated
 * like every mutating tool, and are audited in `protocol_executions`. The
 * durable settlement truth is the venue's own order ledger, read back with
 * indexify__orders_list / indexify__history_list.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { INDEXIFY_TRADE_DISCOVERY } from "../../embeddings/indexify/trade.js";
import {
  INDEXIFY_API_KEY_ENV,
  INDEXIFY_PARTIAL_RESOLUTIONS,
  INDEXIFY_TRADE_DIRECTIONS,
} from "@tools/indexify/constants.js";

export const INDEXIFY_TRADE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "indexify.fees",
    publicName: "indexify__fees_get",
    namespace: "indexify",
    lifecycle: "active",
    description:
      "Preview Indexify's trading costs. Use this before a stack trade to state the real cost: the venue charges a 1% platform fee plus the stack's creator fee (bounded, currently up to 0.5%) on every buy and sell; Solana gas is sponsored. Returns the platform's minimum buy in USDC and the creator-fee bounds always, and — when amountIn and stackId are both given — the venue's own fee estimate for that amount on that stack. Provide amountIn and stackId together or neither; one without the other is refused by name. Read-only, no API key needed.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "amountIn",
        type: "string",
        description:
          "The USDC amount to estimate fees for, in HUMAN decimal units as a string (\"25\" = $25). Requires stackId beside it.",
      },
      {
        key: "stackId",
        type: "number",
        description:
          "The stack the estimate is for, by its numeric id — the creator fee varies per stack. Requires amountIn beside it.",
      },
    ],
    exampleParams: { amountIn: "25", stackId: 4139 },
    discovery: INDEXIFY_TRADE_DISCOVERY["indexify.fees"],
  },
  {
    toolId: "indexify.trade_execute",
    publicName: "indexify__stack_trade_execute",
    namespace: "indexify",
    lifecycle: "active",
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      "Buy or sell an Indexify stack for real. SPENDS REAL FUNDS from the linked Indexify account's custodial USDC balance — not from a Vex session wallet — the moment the venue accepts it; there is no signing step and no cancellation. A buy spends amountIn USDC (at least the venue minimum, $5 measured) split across the stack's tokens; a sell converts sellPercent (1-100) of the HELD position back to USDC — sells are sized ONLY as a percent of holdings, never in dollars, so never pass a dollar figure as sellPercent. Call indexify__portfolio_get before buying (balance) and indexify__fees_get to state costs. Returns TRUTHFUL-PENDING, never a confirmation: the order id, the stated direction and size, and the instruction to confirm settlement with indexify__orders_list — the venue fans one order out into per-token Solana swaps that can land SUCCESS, FAILED, or PARTIAL (resolve a PARTIAL with indexify__order_resolve).",
    mutating: true,
    actionKind: "external_post",
    exclusiveParamGroups: [["amountIn", "sellPercent"]],
    params: [
      {
        key: "stackId",
        type: "number",
        required: true,
        description:
          "The stack to trade, by its numeric id from discovery, search, or stack detail. Verify it is the stack the user means before spending.",
      },
      {
        key: "direction",
        type: "string",
        required: true,
        enum: [...INDEXIFY_TRADE_DIRECTIONS],
        description:
          "Which way the trade moves: buy (spend USDC into the stack) or sell (convert part of the held position back to USDC). Must agree with the amount param given — buy takes amountIn, sell takes sellPercent; a mismatch is refused by name.",
      },
      {
        key: "amountIn",
        type: "string",
        description:
          "BUY ONLY: the USDC to spend, in HUMAN decimal units as a string (\"10\" = $10), at least the venue minimum. Give either amountIn or sellPercent, never both.",
      },
      {
        key: "sellPercent",
        type: "number",
        description:
          "SELL ONLY: how much of the held position to sell, as a PERCENT of holdings from 1 to 100 (50 sells half). NOT a dollar amount.",
      },
    ],
    exampleParams: { stackId: 4139, direction: "buy", amountIn: "10" },
    discovery: INDEXIFY_TRADE_DISCOVERY["indexify.trade_execute"],
  },
  {
    toolId: "indexify.order_resolve",
    publicName: "indexify__order_resolve",
    namespace: "indexify",
    lifecycle: "active",
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      "Resolve a PARTIAL Indexify order — one where some of the stack's tokens filled and others failed. Use this only after indexify__orders_list showed the order is PARTIAL and which resolutions the venue offers. SPENDS REAL FUNDS on two of the three paths: retry re-buys the failed tokens with the order's reserved USDC, and sell_all liquidates every token the order did buy back to USDC; acknowledge accepts the partial fill as final and moves no funds. Returns the venue's acceptance for the chosen resolution — a retry returns a NEW order id to track with indexify__orders_list; acknowledge and sell_all return the venue's confirmation of the resolution.",
    mutating: true,
    actionKind: "external_post",
    params: [
      {
        key: "orderId",
        type: "string",
        required: true,
        description:
          "The PARTIAL order to resolve, by the id indexify__orders_list and the trade reply carry. Must belong to the linked account.",
      },
      {
        key: "action",
        type: "string",
        required: true,
        enum: [...INDEXIFY_PARTIAL_RESOLUTIONS],
        description:
          "Which resolution to apply: acknowledge (accept the partial fill, moves nothing), retry (re-buy the failed tokens), or sell_all (liquidate what did fill back to USDC).",
      },
    ],
    exampleParams: { orderId: "a1b2c3d4e5f6a7b8", action: "retry" },
    discovery: INDEXIFY_TRADE_DISCOVERY["indexify.order_resolve"],
  },
];
