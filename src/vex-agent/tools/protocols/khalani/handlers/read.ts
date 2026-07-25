/**
 * Khalani read-only handlers — chains, tokens, quotes, orders.
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import {
  getCachedKhalaniChains,
  getChainFamily,
  resolveChainId,
} from "@tools/khalani/chains.js";
import {
  getSelectedChainIdsForFamily,
  getTokenBalancesAcrossChains,
  parseBalanceChainSelection,
} from "@tools/khalani/balances.js";
import { walletAddressesEqual, familyToInventory } from "@tools/wallet/inventory.js";
import { findCallerSuppliedFeeParam, prepareQuoteRequest } from "@tools/khalani/request.js";
import { classifyKhalaniQuoteResponse } from "@tools/khalani/quote-result.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ChainFamily } from "@tools/khalani/types.js";

import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../internal/wallet/resolve.js";
import { str, toResultData } from "../../handler-helpers.js";
import { projectChain, projectChains, projectQuoteRoutes, projectToken, projectTokens } from "../projectors.js";
import { revealOnEligibleKhalaniFailure } from "./reveal.js";
import { resolveKhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";

// ── Shared helpers (exported for bridge handler) ────────────────

export async function parseChainIds(raw: string | undefined): Promise<number[] | undefined> {
  if (!raw) return undefined;
  const chains = await getCachedKhalaniChains();
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map(s => resolveChainId(s, chains));
}

export function resolveWalletFamily(params: Record<string, unknown>): ChainFamily {
  const walletFamily = str(params, "wallet") || "eip155";
  if (walletFamily === "eip155" || walletFamily === "solana") return walletFamily;
  throw new VexError(
    ErrorCodes.AGENT_VALIDATION_ERROR,
    `Unsupported wallet family: ${walletFamily}. Use eip155 or solana.`,
  );
}

export function resolveWalletAddress(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  walletFamily = resolveWalletFamily(params),
): string {
  const selected = resolveSelectedAddress(context.walletResolution, context.walletPolicy, walletFamily);
  const explicit = str(params, "address");
  if (!explicit) return selected;
  // Default resolution may query an arbitrary explicit address. A session scope
  // is locked to its selected wallet — an explicit address must match it
  // (Codex 5B #2); generic recipient/quote fields are separate params.
  if (context.walletResolution.source === "default") return explicit;
  if (!walletAddressesEqual(familyToInventory(walletFamily), explicit, selected)) {
    throw new VexError(
      ErrorCodes.WALLET_SCOPE_MISMATCH,
      "Explicit address is not the wallet selected for this session.",
    );
  }
  return selected;
}

// ── Handler map ──────────────────────────────────────────────────

export const READ_HANDLERS: Record<string, ProtocolHandler> = {
  "khalani.chains.list": async (params) => {
    const refresh = params.refresh === true;
    const chains = await getCachedKhalaniChains(refresh);
    // Project to concise chain rows (P0-4): drop rpcUrls/blockExplorers — the
    // internal rpc/explorer resolvers read those off the cached registry, not
    // this output.
    return {
      success: true,
      output: JSON.stringify({ chains: chains.length, data: projectChains(chains) }, null, 2),
      data: { chains },
    };
  },

  "khalani.tokens.top": async (params) => {
    const chainIds = await parseChainIds(str(params, "chainIds"));
    const tokens = await getKhalaniClient().getTopTokens(chainIds);
    // Project to concise token rows (P0-4): keep identity + lifted
    // priceUsd/balance/isRiskToken, drop logoURI + open extensions bag.
    return {
      success: true,
      output: JSON.stringify({ count: tokens.length, tokens: projectTokens(tokens) }, null, 2),
      data: { tokens },
    };
  },

  "khalani.tokens.search": async (params) => {
    const query = str(params, "query");
    if (!query) return { success: false, output: "Missing required parameter: query" };

    const chainIds = await parseChainIds(str(params, "chainIds"));
    const result = await getKhalaniClient().searchTokens(query, chainIds);
    // Project to concise token rows (P0-4) — this is the hot pre-mutation
    // contract-resolver path, so the surfaced address + price signal matters.
    return {
      success: true,
      output: JSON.stringify({ count: result.data.length, tokens: projectTokens(result.data) }, null, 2),
      data: { tokens: result.data },
    };
  },

  "khalani.tokens.autocomplete": async (params) => {
    const keyword = str(params, "keyword");
    if (!keyword) return { success: false, output: "Missing required parameter: keyword" };

    const chainIds = await parseChainIds(str(params, "chainIds"));
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const result = await getKhalaniClient().autocompleteToken(keyword, { chainIds, limit });
    // Project to concise rows (P0-4): each entry nests a FULL chain AND token —
    // project both, keep the semantic fields (description/amount/usdAmount) and
    // the top-level parse hints (parsed/nextSlots).
    return {
      success: true,
      output: JSON.stringify({
        data: result.data.map(entry => ({
          description: entry.description,
          chain: projectChain(entry.chain),
          token: projectToken(entry.token),
          amount: entry.amount,
          usdAmount: entry.usdAmount,
        })),
        parsed: result.parsed,
        nextSlots: result.nextSlots,
      }, null, 2),
      data: toResultData(result),
    };
  },

  "khalani.tokens.balances": async (params, context) => {
    const walletFamily = resolveWalletFamily(params);
    const address = resolveWalletAddress(params, context, walletFamily);
    const selection = await parseBalanceChainSelection(str(params, "chainIds"));
    const chainIds = getSelectedChainIdsForFamily(selection, walletFamily);
    if (selection.rawProvided && chainIds?.length === 0) {
      return {
        success: false,
        output: `No ${walletFamily} chains matched chainIds="${str(params, "chainIds")}".`,
      };
    }
    // Live read tool (khalani_tokens_balances): opt into the EVM native-coin
    // top-up, like wallet_balances. Only the sync/projection path stays
    // native-free (it full-replaces proj_balances).
    const scan = await getTokenBalancesAcrossChains({ address, family: walletFamily, chainIds, includeNative: true });
    return {
      success: true,
      output: JSON.stringify({
        address,
        wallet: walletFamily,
        count: scan.tokens.length,
        totalUsd: scan.totalUsd,
        scannedChainIds: scan.scannedChainIds,
        chainErrors: scan.chainErrors,
        // Project to concise token rows (P0-4): the balances path is where
        // `extensions.balance` lives, so the lifted balance/price stay surfaced.
        tokens: projectTokens(scan.tokens),
      }, null, 2),
      data: {
        address,
        wallet: walletFamily,
        totalUsd: scan.totalUsd,
        scannedChainIds: scan.scannedChainIds,
        chainErrors: scan.chainErrors,
        tokens: scan.tokens,
      },
    };
  },

  "khalani.quote.get": async (params, context) => {
    const fromChain = str(params, "fromChain");
    const toChain = str(params, "toChain");
    const fromToken = str(params, "fromToken");
    const toToken = str(params, "toToken");
    const amount = str(params, "amount");

    if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
      return { success: false, output: "Missing required parameters: fromChain, toChain, fromToken, toToken, amount" };
    }

    // Fee params are never accepted from tool input (see the bridge referral-fee
    // policy in `@tools/khalani/request.js`). Rejecting here matters as much as
    // on the execute: the prequote gate binds the money/fee leg, so a quote
    // carrying a fee is what would later let a matching execute through. No
    // quote with a caller-supplied fee can be recorded in the first place.
    const suppliedFeeParam = findCallerSuppliedFeeParam(params);
    if (suppliedFeeParam !== null) {
      return {
        success: false,
        output: `khalani.quote.get failed: ${suppliedFeeParam} is not an accepted parameter — Vex never charges a bridge referral fee and never takes fee parameters from tool input. Remove it and retry.`,
      };
    }

    // Pre-quote route guard (R9 — same wiring as the execute handler): a local
    // chain routes statically to Relay; a nonlocal endpoint absent from the
    // LIVE registry is a typed no-route that surfaces the route-bound Relay
    // reveal (previously the raw resolver throw returned a bare message with
    // no reveal — coordinator live-smoke finding, 2026-07-23).
    let prequote: Awaited<ReturnType<typeof resolveKhalaniPrequoteRoute>>;
    try {
      prequote = await resolveKhalaniPrequoteRoute(fromChain, toChain);
    } catch (err) {
      // Route resolution reads Khalani's live registry, so this catch can hold
      // PROVIDER-controlled text (`mapKhalaniError` builds its message from the
      // response body). Raw `err.message` bypassed the scrub boundary entirely.
      return { success: false, output: `khalani.quote.get failed: ${summarizeProtocolError(err).message}` };
    }
    if (prequote.outcome === "static_relay") {
      return {
        success: false,
        output: "This route touches a local chain (e.g. Robinhood) that Khalani does not serve — use the Relay bridge tools directly for it.",
      };
    }
    if (prequote.outcome === "no_route") {
      const revealSuffix = revealOnEligibleKhalaniFailure({ kind: "empty_routes" }, context.sessionId, params);
      return {
        success: false,
        output: `khalani.quote.get failed: Khalani has no route (${prequote.missing.join(", ")} chain not in the live registry).${revealSuffix}`,
      };
    }

    // Per-session wallet scope (5D-protocols p4) — the quote uses the session's
    // selected source/dest wallets, not the primary. Read-only (no signing).
    const chains = await getCachedKhalaniChains();
    let fromFamily: "eip155" | "solana";
    let toFamily: "eip155" | "solana";
    try {
      fromFamily = getChainFamily(resolveChainId(fromChain, chains), chains);
      toFamily = getChainFamily(resolveChainId(toChain, chains), chains);
    } catch (err) {
      // Locally authored, but it echoes the MODEL-SUPPLIED fromChain/toChain
      // verbatim — untrusted input reaching an output sink, so it goes through
      // the same boundary as provider text.
      return { success: false, output: summarizeProtocolError(err).message };
    }
    const explicitFrom = str(params, "fromAddress") || undefined;
    let fromAddress: string;
    try {
      fromAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, fromFamily);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (
      context.walletResolution.source === "session" && explicitFrom
      && !walletAddressesEqual(familyToInventory(fromFamily), explicitFrom, fromAddress)
    ) {
      return { success: false, output: "The provided fromAddress does not match the session's selected wallet for the source chain." };
    }
    const explicitRecipient = str(params, "recipient") || undefined;
    let recipient: string;
    try {
      recipient = explicitRecipient ?? resolveSelectedAddress(context.walletResolution, context.walletPolicy, toFamily);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    const prepared = await prepareQuoteRequest({
      fromChain,
      fromToken,
      toChain,
      toToken,
      amount,
      tradeType: str(params, "tradeType") || undefined,
      fromAddress,
      recipient,
      refundTo: str(params, "refundTo") || undefined,
      filler: str(params, "filler") || undefined,
    });

    // Read-only quote: a Khalani no-route (empty routes[]) or a reveal-eligible
    // exception is a FAILURE that surfaces the route-bound Relay reveal. No
    // activity row is written (a read miss records nothing — R15).
    let outcome: ReturnType<typeof classifyKhalaniQuoteResponse>;
    try {
      outcome = classifyKhalaniQuoteResponse(await getKhalaniClient().getQuotes(prepared.request));
    } catch (err) {
      const externalName = err instanceof VexError ? err.externalName : undefined;
      const revealSuffix = revealOnEligibleKhalaniFailure({ kind: "exception", externalName }, context.sessionId, params);
      return { success: false, output: `khalani.quote.get failed: ${summarizeProtocolError(err).message}.${revealSuffix}` };
    }
    if (outcome.outcome === "no_route") {
      const revealSuffix = revealOnEligibleKhalaniFailure({ kind: "empty_routes" }, context.sessionId, params);
      return { success: false, output: `khalani.quote.get: Khalani has no route for this pair.${revealSuffix}` };
    }

    return {
      success: true,
      output: JSON.stringify({
        quoteId: outcome.quoteId,
        routeCount: outcome.routes.length,
        routes: projectQuoteRoutes(outcome.routes, Date.now()),
        expiryNote: "khalani.bridge.execute re-quotes and hard-fails with deadline_expired once expiresAtUnixSeconds "
          + "passes — treat expiresInSeconds as the window you have to act in, not a guarantee the same route survives.",
      }, null, 2),
      data: { quoteId: outcome.quoteId, routes: outcome.routes },
    };
  },

  "khalani.orders.list": async (params, context) => {
    const address = resolveWalletAddress(params, context);
    const chains = await getCachedKhalaniChains();
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const cursor = typeof params.cursor === "number" ? params.cursor : undefined;
    const fromChainId = str(params, "fromChain") ? resolveChainId(str(params, "fromChain"), chains) : undefined;
    const toChainId = str(params, "toChain") ? resolveChainId(str(params, "toChain"), chains) : undefined;
    const orderIds = str(params, "orderIds") || undefined;
    const txHashSearch = str(params, "txHashSearch") || undefined;

    const result = await getKhalaniClient().getOrders(address, {
      limit, cursor, fromChainId, toChainId, orderIds, txHashSearch,
    });
    return {
      success: true,
      output: JSON.stringify({ count: result.data.length, cursor: result.cursor, orders: result.data }, null, 2),
      data: { orders: result.data, cursor: result.cursor },
    };
  },

  "khalani.orders.get": async (params) => {
    const orderId = str(params, "orderId");
    if (!orderId) return { success: false, output: "Missing required parameter: orderId" };

    const order = await getKhalaniClient().getOrderById(orderId);
    return {
      success: true,
      output: JSON.stringify(order, null, 2),
      data: toResultData(order),
    };
  },
};
