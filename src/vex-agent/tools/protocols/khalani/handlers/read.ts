/**
 * Khalani read-only handlers — chains, tokens, quotes, orders.
 *
 * ONE non-Khalani read lives here, deliberately: `khalani.tokens.balances`
 * answers its `solana` family from Solana's own RPC through the shared snapshot
 * service (`tools/solana-ecosystem/balances/wallet-snapshot.ts`), the same one
 * `WalletBalances` and the balance sync project from. Khalani's Solana scan
 * answers ZERO tokens, and this tool's own description tells the model to use it
 * to find a funded source asset before quoting a bridge or a swap - a funding
 * oracle on a blind lane. The `eip155` family stays Khalani-backed, because
 * those chains have no per-chain RPC reader and Khalani is legitimately their
 * enumerator. This tool keeps the wallet contract it owns (`walletAddress`, the
 * session scope check) across BOTH families.
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
import { findCallerSuppliedForbiddenParam, prepareQuoteRequest } from "@tools/khalani/request.js";
import { classifyKhalaniQuoteResponse } from "@tools/khalani/quote-result.js";
import {
  BRIDGE_FEE_RECEIVER_EVM,
  BRIDGE_FEE_RECEIVER_SOLANA,
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  evaluateEvmBridgeFeeEligibility,
  splitBridgeAmountForFee,
  type BridgeFeeSplit,
} from "@tools/bridge-fee/index.js";
import { estimateUsd, humanizeAmount, resolveKhalaniTokenInfo } from "./bridge-usd.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ChainFamily, KhalaniChain } from "@tools/khalani/types.js";
import { getLocalChain, resolveLocalChainId } from "@tools/evm-chains/registry.js";
import {
  readSolanaWalletSnapshot,
  type SolanaBalanceRow,
  type SolanaWalletSnapshotReader,
} from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";

import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../internal/wallet/resolve.js";
import { str, toResultData } from "../../handler-helpers.js";
import { projectChain, projectChains, projectQuoteRoutes, projectToken, projectTokens } from "../projectors.js";
import { venueFallbackNoteOnKhalaniFailure } from "./fallback.js";
import { resolveKhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import { renderProtocolFailureOutput, summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { readStringOrArrayParam } from "../../runtime/list-params.js";
import { describeKhalaniOrderCorrelation } from "../order-correlation.js";
import { throwIfAborted } from "@utils/cancellation.js";

// ── Shared helpers (exported for bridge handler) ────────────────

/**
 * A chain filter for the Khalani READ tools, resolved STRICTLY against the
 * Khalani registry — the capability boundary in `tools/evm-chains/resolver.ts`
 * is deliberate and stays closed here: a Khalani read must never treat a
 * local-only chain as Khalani-supported.
 *
 * What DOES change is the answer the agent gets when it names one. `TokenFind
 * chainIds:"robinhood"` used to die on the strict resolver's bare "Unsupported
 * chain: robinhood" — indistinguishable from a typo, and it sent the agent
 * looking for a better spelling of a chain no spelling can reach through this
 * tool. Robinhood Chain is a chain Vex fully supports; it is only Khalani's
 * token registry that does not cover it. So a LOCAL chain is named as such,
 * with the tools that DO answer the question. The lookup is local-registry-only
 * (no network) and runs after the Khalani registry has already been consulted,
 * so a chain Khalani later adds still resolves as Khalani.
 */
function assertNotLocalOnlyChain(part: string, chains: KhalaniChain[]): void {
  const localId = resolveLocalChainId(part);
  if (localId === undefined) return;
  if (chains.some((chain) => chain.id === localId)) return;
  const config = getLocalChain(localId);
  const name = config?.name ?? part;
  throw new VexError(
    ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
    `${name} (${localId}) is not in Khalani's registry — this tool cannot resolve tokens there.`,
    `Use dexscreener__pairs_search (chain slug ${part.trim().toLowerCase()}) for a symbol → address lookup, `
    + 'WalletTrackToken action:"list" for the tracked/seed token set, or '
    + `WalletBalances chainIds:"${part.trim().toLowerCase()}" for the tokens you actually hold.`,
  );
}

/**
 * A list param the model may spell as a comma-string OR as a JSON array — the
 * manifest declares `acceptsStringArray` on both `chainIds` and `orderIds`, and
 * this is the reader that honours it. Rejections carry the reader's own
 * by-position message rather than degrading to "no filter".
 */
function readListParam(
  toolId: string,
  params: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; result: ToolResult } {
  const read = readStringOrArrayParam(params, key);
  if (!read.ok) return { ok: false, result: { success: false, output: `${toolId}: ${read.reason}` } };
  return { ok: true, value: read.value === null || read.value === "" ? undefined : read.value };
}

export async function parseChainIds(raw: string | undefined): Promise<number[] | undefined> {
  if (!raw) return undefined;
  const chains = await getCachedKhalaniChains();
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map(s => {
    assertNotLocalOnlyChain(s, chains);
    return resolveChainId(s, chains);
  });
}

export function resolveWalletFamily(params: Record<string, unknown>): ChainFamily {
  // The canonical key (owner decision D15). A call that arrived with the retired
  // `wallet` spelling was already rewritten to `walletFamily` at the runtime
  // boundary (`protocols/runtime/param-aliases.ts`), so there is exactly one
  // spelling to read here. The default is unchanged.
  const walletFamily = str(params, "walletFamily") || "eip155";
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
  const explicit = str(params, "walletAddress");
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

// ── khalani.tokens.balances ──────────────────────────────────────

/**
 * A Solana balance row as this tool emits it.
 *
 * SEPARATE from `ConciseKhalaniToken` on purpose: Solana mint metadata is
 * genuinely optional, so `symbol` / `name` stay NULLABLE and a mint no source
 * can label is reported honestly rather than relabelled with its own address.
 * `ConciseKhalaniToken` is deliberately NOT widened - its Khalani rows always
 * carry both labels, and widening it would make every other Khalani read tool
 * claim a nullability it does not have.
 */
interface SolanaBalanceTokenRow {
  symbol: string | null;
  name: string | null;
  address: string;
  chainId: number;
  decimals: number;
  priceUsd?: string;
  balance?: string;
}

/**
 * One TOKEN ACCOUNT the Solana read could not trust. Never folded into a token
 * row: the holdings behind these accounts are ABSENT from `tokens`, and an
 * agent that cannot see that would read the gap as "you hold none of it".
 */
interface AccountReadError {
  chainId: number;
  accountAddress: string;
  reason: string;
}

/** Same bound and reason as the `WalletBalances` snapshot's own account-error cap. */
const MAX_ACCOUNT_ERRORS = 20;

function solanaRowToTokenRow(row: SolanaBalanceRow): SolanaBalanceTokenRow {
  return {
    symbol: row.symbol,
    name: row.name,
    address: row.mint,
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    decimals: row.decimals,
    balance: row.amountRaw,
    ...(row.priceUsd !== null ? { priceUsd: String(row.priceUsd) } : {}),
  };
}

/**
 * The narrow, optional dependency this handler takes so a test can drive the
 * REAL handler over a scripted RPC. Production callers pass nothing.
 */
export interface TokenBalancesDependencies {
  readonly readSolanaSnapshot?: SolanaWalletSnapshotReader;
}

export async function handleTokenBalances(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  dependencies: TokenBalancesDependencies = {},
): Promise<ToolResult> {
  const walletFamily = resolveWalletFamily(params);
  // The wallet contract this tool owns, unchanged for BOTH families: an
  // explicit `walletAddress` reads someone else's wallet under default
  // resolution, and must equal the selected wallet under a session scope.
  const address = resolveWalletAddress(params, context, walletFamily);
  const chainIdsRead = readListParam("khalani.tokens.balances", params, "chainIds");
  if (!chainIdsRead.ok) return chainIdsRead.result;
  // The chain FILTER still resolves through Khalani's registry for both
  // families - the Solana chain id and its aliases are Khalani's - so an
  // explicit filter that keeps no chain for this family still fails the same
  // way it always did. Only the BALANCE SOURCE for solana changes.
  const selection = await parseBalanceChainSelection(chainIdsRead.value);
  const chainIds = getSelectedChainIdsForFamily(selection, walletFamily);
  if (selection.rawProvided && chainIds?.length === 0) {
    return {
      success: false,
      output: `No ${walletFamily} chains matched chainIds="${chainIdsRead.value ?? ""}".`,
    };
  }

  if (walletFamily === "solana") {
    const readSnapshot = dependencies.readSolanaSnapshot ?? readSolanaWalletSnapshot;
    let snapshot: Awaited<ReturnType<SolanaWalletSnapshotReader>>;
    try {
      snapshot = await readSnapshot(address, { signal: context.abortSignal });
    } catch (err) {
      // An operator Stop is the CALLER's outcome, not the provider's: it
      // propagates as the signal's own reason instead of being relabelled a
      // Solana read failure the agent might retry.
      throwIfAborted(context.abortSignal);
      // SECURITY: a raw Solana RPC error can carry the configured RPC URL (with
      // its key) and HTML bodies, so only the scrubbed summary reaches the model.
      return {
        success: false,
        output: renderProtocolFailureOutput("khalani.tokens.balances", summarizeProtocolError(err)),
      };
    }
    const accountErrors: AccountReadError[] = [];
    let accountErrorsOmitted = 0;
    for (const failure of snapshot.accountFailures) {
      if (accountErrors.length < MAX_ACCOUNT_ERRORS) {
        accountErrors.push({
          chainId: SOLANA_SYNTHETIC_CHAIN_ID,
          accountAddress: failure.pubkey,
          reason: failure.reason,
        });
      } else accountErrorsOmitted += 1;
    }
    const tokens = snapshot.rows.map(solanaRowToTokenRow);
    const payload = {
      address,
      wallet: walletFamily,
      count: tokens.length,
      totalUsd: snapshot.totalUsd,
      scannedChainIds: [SOLANA_SYNTHETIC_CHAIN_ID],
      chainErrors: [],
      accountErrors,
      ...(accountErrorsOmitted > 0 ? { accountErrorsOmitted } : {}),
      tokens,
    };
    return {
      success: true,
      output: JSON.stringify(payload, null, 2),
      data: payload,
    };
  }

  // Live read tool (khalani.tokens.balances): opt into the EVM native-coin
  // top-up, like WalletBalances. Only the sync/projection path stays
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
      // An EVM scan reads no Solana token accounts, so the field is present and
      // empty rather than absent: an absent field would read as "no answer".
      accountErrors: [],
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
      accountErrors: [],
      tokens: scan.tokens,
    },
  };
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
    const chainIdsRead = readListParam("khalani.tokens.top", params, "chainIds");
    if (!chainIdsRead.ok) return chainIdsRead.result;
    const chainIds = await parseChainIds(chainIdsRead.value);
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

    const chainIdsRead = readListParam("khalani.tokens.search", params, "chainIds");
    if (!chainIdsRead.ok) return chainIdsRead.result;
    const chainIds = await parseChainIds(chainIdsRead.value);
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

    const chainIdsRead = readListParam("khalani.tokens.autocomplete", params, "chainIds");
    if (!chainIdsRead.ok) return chainIdsRead.result;
    const chainIds = await parseChainIds(chainIdsRead.value);
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

  "khalani.tokens.balances": (params, context) => handleTokenBalances(params, context),

  "khalani.quote.get": async (params, context) => {
    const fromChain = str(params, "fromChain");
    const toChain = str(params, "toChain");
    const fromToken = str(params, "fromToken");
    const toToken = str(params, "toToken");
    const amount = str(params, "amountRaw");

    if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
      return { success: false, output: "Missing required parameters: fromChain, toChain, fromToken, toToken, amountRaw" };
    }

    // Fee params AND the refund destination are never accepted from tool input
    // (see the two policy blocks in `@tools/khalani/request.js`). Rejecting
    // here matters as much as on the execute: the prequote gate binds the
    // money/fee leg, so a quote carrying either is what would later let a
    // matching execute through — an attacker who sets the SAME value on the
    // quote and the execute gets two colliding hashes and a passing gate. No
    // such quote can be recorded in the first place.
    const forbiddenParam = findCallerSuppliedForbiddenParam(params);
    if (forbiddenParam !== null) {
      return {
        success: false,
        output: `khalani__bridge_quote_get failed: ${forbiddenParam.param} is not an accepted parameter - ${forbiddenParam.reason} Remove it and retry.`,
      };
    }

    // Pre-quote route guard (R9 — same wiring as the execute handler): a local
    // chain routes statically to Relay; a nonlocal endpoint absent from the
    // LIVE registry is a typed no-route that surfaces the route-bound Relay
    // fallback note (previously the raw resolver throw returned a bare
    // message with no alternative — live-smoke finding, 2026-07-23).
    let prequote: Awaited<ReturnType<typeof resolveKhalaniPrequoteRoute>>;
    try {
      prequote = await resolveKhalaniPrequoteRoute(fromChain, toChain);
    } catch (err) {
      // Route resolution reads Khalani's live registry, so this catch can hold
      // PROVIDER-controlled text (`mapKhalaniError` builds its message from the
      // response body). Raw `err.message` bypassed the scrub boundary entirely.
      return { success: false, output: renderProtocolFailureOutput("khalani.quote.get", summarizeProtocolError(err)) };
    }
    if (prequote.outcome === "static_relay") {
      return {
        success: false,
        output: "This route touches a local chain (e.g. Robinhood) that Khalani does not serve — use the Relay bridge tools directly for it.",
      };
    }
    if (prequote.outcome === "no_route") {
      const fallbackNote = venueFallbackNoteOnKhalaniFailure({ kind: "empty_routes" }, context.sessionId, params);
      return {
        success: false,
        output: `khalani__bridge_quote_get failed: Khalani has no route (${prequote.missing.join(", ")} chain not in the live registry).${fallbackNote}`,
      };
    }

    // Per-session wallet scope (5D-protocols p4) — the quote uses the session's
    // selected source/dest wallets, not the primary. Read-only (no signing).
    const chains = await getCachedKhalaniChains();
    let fromChainId: number;
    let fromFamily: "eip155" | "solana";
    let toFamily: "eip155" | "solana";
    try {
      fromChainId = resolveChainId(fromChain, chains);
      fromFamily = getChainFamily(fromChainId, chains);
      toFamily = getChainFamily(resolveChainId(toChain, chains), chains);
    } catch (err) {
      // Locally authored, but it echoes the MODEL-SUPPLIED fromChain/toChain
      // verbatim — untrusted input reaching an output sink, so it goes through
      // the same boundary as provider text.
      return { success: false, output: renderProtocolFailureOutput("khalani.quote.get", summarizeProtocolError(err)) };
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
      // No `refundTo`: derived from `fromAddress` (refund-destination policy
      // in `@tools/khalani/request.js`), so the quote binds the same derived
      // value the execute will.
      filler: str(params, "filler") || undefined,
    });

    // Vex integrator fee — the SAME split the execute applies, so the quoted
    // `amountOut` is what the user actually receives and the disclosed fee is
    // the fee that will actually be taken. Resolved through the shared
    // `@tools/bridge-fee` module, never re-derived here.
    let feeSplit: BridgeFeeSplit;
    try {
      feeSplit = splitBridgeAmountForFee(prepared.request.amount);
    } catch (err) {
      return { success: false, output: renderProtocolFailureOutput("khalani.quote.get", summarizeProtocolError(err)) };
    }
    let feeSkipReason: string | null = feeSplit.charged
      ? null
      : "25 bps of the requested amount floors to 0 in smallest units";
    if (feeSplit.charged && fromFamily === "eip155") {
      const eligibility = await evaluateEvmBridgeFeeEligibility(fromChainId, fromToken);
      if (!eligibility.charge) feeSkipReason = eligibility.reason;
    }
    const chargeFee = feeSkipReason === null;
    const quoteRequest = {
      ...prepared.request,
      amount: (chargeFee ? feeSplit.bridgedRaw : feeSplit.totalRaw).toString(),
    };

    // Read-only quote: a Khalani no-route (empty routes[]) or a fallback-eligible
    // exception is a FAILURE that surfaces the Relay fallback note. No
    // activity row is written (a read miss records nothing — R15).
    let outcome: ReturnType<typeof classifyKhalaniQuoteResponse>;
    try {
      outcome = classifyKhalaniQuoteResponse(await getKhalaniClient().getQuotes(quoteRequest));
    } catch (err) {
      const externalName = err instanceof VexError ? err.externalName : undefined;
      const fallbackNote = venueFallbackNoteOnKhalaniFailure({ kind: "exception", externalName }, context.sessionId, params);
      return {
        success: false,
        output: `${renderProtocolFailureOutput("khalani__bridge_quote_get", summarizeProtocolError(err))}${fallbackNote}`,
      };
    }
    if (outcome.outcome === "no_route") {
      const fallbackNote = venueFallbackNoteOnKhalaniFailure({ kind: "empty_routes" }, context.sessionId, params);
      return { success: false, output: `khalani__bridge_quote_get: Khalani has no route for this pair.${fallbackNote}` };
    }

    // Fee disclosure (fail-soft token facts — a lookup miss degrades the human
    // amount and USD to null, never to a fabricated figure).
    const fromInfo = await resolveKhalaniTokenInfo(fromToken, fromChainId);
    const vexFee = chargeFee
      ? buildBridgeFeeDisclosure({
          tokenAddress: fromToken,
          tokenSymbol: fromInfo?.symbol,
          tokenDecimals: fromInfo?.decimals,
          feeRaw: feeSplit.feeRaw,
          bridgedRaw: feeSplit.bridgedRaw,
          totalRaw: feeSplit.totalRaw,
          receiver: fromFamily === "solana" ? BRIDGE_FEE_RECEIVER_SOLANA : BRIDGE_FEE_RECEIVER_EVM,
          feeUsdEstimate: estimateUsd(
            humanizeAmount(feeSplit.feeRaw.toString(), fromInfo?.decimals),
            fromInfo?.priceUsd,
          ),
        })
      : buildBridgeFeeSkippedDisclosure({
          reason: feeSkipReason ?? "no fee applies to this bridge",
          totalRaw: feeSplit.totalRaw,
        });

    return {
      success: true,
      output: JSON.stringify({
        quoteId: outcome.quoteId,
        routeCount: outcome.routes.length,
        routes: projectQuoteRoutes(outcome.routes, Date.now()),
        vexFee,
        expiryNote: "khalani__bridge_execute re-quotes and hard-fails with deadline_expired once expiresAtUnixSeconds "
          + "passes — treat expiresInSeconds as the window you have to act in, not a guarantee the same route survives.",
      }, null, 2),
      data: { quoteId: outcome.quoteId, routes: outcome.routes, vexFee },
    };
  },

  "khalani.orders.list": async (params, context) => {
    const address = resolveWalletAddress(params, context);
    const chains = await getCachedKhalaniChains();
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const cursor = typeof params.cursor === "number" ? params.cursor : undefined;
    const fromChainId = str(params, "fromChain") ? resolveChainId(str(params, "fromChain"), chains) : undefined;
    const toChainId = str(params, "toChain") ? resolveChainId(str(params, "toChain"), chains) : undefined;
    const orderIdsRead = readListParam("khalani.orders.list", params, "orderIds");
    if (!orderIdsRead.ok) return orderIdsRead.result;
    const orderIds = orderIdsRead.value;
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
    // W9b — merge Vex's OWN record with the provider's. A status check that
    // shows only Khalani's view can contradict the `filled_unverified` the
    // bridge tool returned a turn earlier, with nothing reconciling the two.
    // Fail-soft: the provider order is always the answer, the correlation is
    // additive (see `../order-correlation.ts`).
    const { correlation, correlationNote } = await describeKhalaniOrderCorrelation(orderId);
    const merged = {
      order,
      vex: correlation,
      ...(correlationNote === undefined ? {} : { vexNote: correlationNote }),
      // Mirrored at the top level under the same key every mutating bridge
      // result already uses, so one lookup works across both surfaces.
      _executionId: correlation?._executionId ?? null,
    };
    return {
      success: true,
      output: JSON.stringify(merged, null, 2),
      data: toResultData(merged),
    };
  },
};
