/**
 * Solana/Jupiter core handlers — prices, tokens, swap.
 */

import {
  searchJupiterTokens,
  getJupiterTokensByCategory,
  getJupiterTokensByTag,
  getJupiterRecentTokens,
} from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import type {
  JupiterTokenCategory,
  JupiterTokenTag,
  JupiterTokenInterval,
  JupiterTokenStatsInterval,
} from "@tools/solana-ecosystem/jupiter/jupiter-tokens/types.js";
import {
  filterJupiterTokensByThreshold,
  validateJupiterTokenThresholdFilters,
  type JupiterTokenThresholdFilters,
} from "@tools/solana-ecosystem/jupiter/jupiter-tokens/token-filters.js";
import {
  getJupiterPricesByMint,
  getJupiterPricesForTokenQueries,
} from "@tools/solana-ecosystem/jupiter/jupiter-prices/service.js";
import { requireJupiterResolvedTokenWithSafety } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import { uiToTokenAmount, solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import { walletAddressesEqual } from "@tools/wallet/inventory.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { Keypair } from "@solana/web3.js";
import {
  prepareFeeBearingJupiterSwap,
  resolveJupiterFeeSwapKnobs,
  buildJupiterFeePreview,
  jupiterFeePreviewSchema,
  type JupiterFeeSwapKnobs,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import { assertExactInSwapMode, assertFeePolicyUnchanged } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap-revalidate.js";
import { buildSolanaSettlementRouteProvenance } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";
import {
  getSolanaConnection,
  prepareVersionedTx,
  type PreparedSolanaTx,
} from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { findFreshMatchedSwapPrequote } from "@vex-agent/tools/protocols/swap-prequote.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivitySolanaBroadcast,
  failActivityEvent,
  type AgentActivityFailureCode,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { checkSlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";
import logger from "@utils/logger.js";

import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { str, num, bool, ok, fail, strArray } from "../../handler-helpers.js";
import { buildActivityTokenLeg } from "../activity-token-leg.js";
import { projectJupiterSwapRoute } from "../swap-route-projector.js";
import { broadcastStagedSolanaTx } from "../staged-broadcast.js";
import { projectJupiterTokens } from "../projectors.js";

const SWAP_PROTOCOL = "jupiter";
const SWAP_NAMESPACE = "solana";

/** The ONE entry point for provider-error text reaching an output/log/reason (scrub boundary — mirrors kyberswap/lend). */
function swapFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

/**
 * Vex's slippage ceiling, applied to the Jupiter venue.
 *
 * Jupiter's own range check permits 0–10,000 bps
 * (`jupiter-swaps/validation.ts`), and the manifest `unit: "bps"` gate
 * (`runtime/bps-param.ts`) proves integrality but deliberately applies no
 * maximum — so before this check a model could authorise a 5,000 bps swap here
 * while the identical KyberSwap request was refused. The ceiling is product
 * policy and has ONE owner (`slippage-policy.ts`); this is Jupiter's call site.
 *
 * No `venueMaxBps` is passed: Jupiter's 10,000 is ABOVE Vex's ceiling, so the
 * ceiling binds on its own (`effectiveMaxSlippageBps`).
 *
 * REJECTED, never clamped, and checked BEFORE wallet resolution or any provider
 * call — a price-protection parameter the caller got wrong must surface as the
 * caller's mistake, not be quietly lowered at the boundary where it costs money.
 *
 * @returns the agent-actionable rejection reason, or `null` when permitted.
 * An omitted value takes Jupiter's own default and is not this gate's business.
 */
function jupiterSlippageViolation(toolId: string, p: Record<string, unknown>): string | null {
  const raw = num(p, "slippageBps");
  if (raw === undefined) return null;
  return checkSlippageBps(`Parameter "slippageBps" for ${toolId}`, raw);
}

// ── Shared helpers (exported for predict + lend handlers) ───────

export function walletAddress(p: Record<string, unknown>, ctx: ProtocolExecutionContext): string {
  const explicit = str(p, "address");
  if (ctx.walletResolution.source === "session") {
    // Session authority: the selected Solana wallet is the only valid owner.
    // An explicit (renderer/LLM-supplied) address that differs is rejected — it
    // must never override session scope.
    const selected = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "solana");
    if (explicit && !walletAddressesEqual("solana", explicit, selected)) {
      throw new VexError(
        ErrorCodes.WALLET_SCOPE_MISMATCH,
        "The provided address does not match the session's selected Solana wallet.",
      );
    }
    return selected;
  }
  // source:"default" — explicit override preserved; else the primary.
  return explicit || resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "solana");
}

export function walletSecret(ctx: ProtocolExecutionContext): Uint8Array {
  const signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "solana");
  if (signer.family !== "solana") {
    throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "Resolved wallet family mismatch (expected solana).");
  }
  return signer.secretKey;
}

// ── Category routing for tokens.trending ─────────────────────────

// Membership uses Sets (not the maps' `in` operator) so prototype keys like
// "constructor"/"toString" cannot pass a check and route to an undefined value.
const VALID_TAGS = new Set<JupiterTokenTag>(["lst", "verified", "stocks"]);
const VALID_CATEGORIES = new Set<string>([
  "toptrending",
  "toptraded",
  "toporganicscore",
  "recent",
  "lst",
  "verified",
  "stocks",
]);
const VALID_INTERVALS = new Set<JupiterTokenInterval>(["5m", "1h", "6h", "24h"]);
// Vex-side output-shaping knob (never sent to Jupiter) — see projectors.ts's
// `ProjectJupiterTokenOptions.statsInterval`. "all" is Vex's own escape hatch.
const VALID_STATS_INTERVALS = new Set<JupiterTokenStatsInterval>(["5m", "1h", "6h", "24h", "all"]);

// ── Handler map ──────────────────────────────────────────────────

export const CORE_HANDLERS: Record<string, ProtocolHandler> = {
  // Core — prices
  //
  // Two mutually-exclusive lookup shapes: `mints` (raw addresses, unchanged
  // fast path) or `queries` (symbols/names/mints, resolved via
  // `getJupiterPricesForTokenQueries` — collapses the former
  // tokens.search → prices two-hop into one call). Jupiter's `/price/v3`
  // silently omits any id it cannot price rather than erroring or returning
  // a null placeholder (confirmed live: `price-v3-bogus-mint.json` fixture
  // returns `200 {}` for an unresolvable mint) — both branches diff the
  // request against the response and surface an explicit `missing` list so
  // that silent omission never reaches the agent unexplained.
  "solana.prices": async (p) => {
    const mints = strArray(p, "mints");
    const queries = strArray(p, "queries");

    if (mints && queries) return fail("Provide either mints or queries, not both.");

    if (queries) {
      const { resolved, raw } = await getJupiterPricesForTokenQueries(queries);
      const missing = resolved.filter((entry) => !entry.found).map((entry) => entry.query);
      return ok({ resolved, raw, missing });
    }

    if (mints) {
      const prices = await getJupiterPricesByMint(mints);
      const missing = mints.filter((mint) => !Object.hasOwn(prices, mint));
      return ok({ prices, missing });
    }

    return fail("Missing required parameter: mints or queries.");
  },

  // Core — token search
  "solana.tokens.search": async (p) => {
    const q = str(p, "query");
    if (!q) return fail("Missing required parameter: query");

    const rawStatsInterval = str(p, "statsInterval");
    const statsInterval = (rawStatsInterval || "1h") as JupiterTokenStatsInterval;
    if (!VALID_STATS_INTERVALS.has(statsInterval)) {
      return fail("Unknown statsInterval '" + rawStatsInterval + "'. Valid stats intervals: 5m, 1h, 6h, 24h, all.");
    }

    const filters: JupiterTokenThresholdFilters = {
      minOrganicScore: num(p, "minOrganicScore"),
      verifiedOnly: bool(p, "verifiedOnly"),
      minLiquidity: num(p, "minLiquidity"),
    };
    const filterError = validateJupiterTokenThresholdFilters(filters);
    if (filterError) return fail(filterError);

    // Project the raw ~40-field JupiterMintInformation to the concise signal
    // set before emitting (P0-3c) — read tool, no _tradeCapture, safe to trim.
    // Threshold filters (Vex-side, no server-side equivalent — W1-G) apply to
    // the raw array BEFORE projection.
    const tokens = filterJupiterTokensByThreshold(await searchJupiterTokens(q), filters);
    return ok(projectJupiterTokens(tokens, { statsInterval }));
  },

  // Core — token trending (routes to category, recent, or tag)
  "solana.tokens.trending": async (p) => {
    const category = str(p, "category") || "toptrending";
    const interval = (str(p, "interval") || "1h") as JupiterTokenInterval;
    const limit = num(p, "limit") ?? 20;

    // Guard a PRESENT-but-unrecognized category (don't silently fall back to toptrending).
    if (str(p, "category") && !VALID_CATEGORIES.has(category)) {
      return fail("Unknown category '" + category + "'. Valid categories: toptrending, toptraded, toporganicscore, recent, lst, verified, stocks.");
    }
    // Guard a PRESENT-but-unrecognized interval (don't let it fail deep in the client with a generic HTTP error).
    if (str(p, "interval") && !VALID_INTERVALS.has(interval)) {
      return fail("Unknown interval '" + interval + "'. Valid intervals: 5m, 1h, 6h, 24h.");
    }

    // Vex-side output-shaping knob (W1-G): defaults to the resolved `interval`
    // above so a caller who only sets `interval` gets a matching single stats
    // window, not all four — explicit "all" opts back into every window.
    const rawStatsInterval = str(p, "statsInterval");
    const statsInterval = (rawStatsInterval || interval) as JupiterTokenStatsInterval;
    if (!VALID_STATS_INTERVALS.has(statsInterval)) {
      return fail("Unknown statsInterval '" + rawStatsInterval + "'. Valid stats intervals: 5m, 1h, 6h, 24h, all.");
    }

    // Vex-side threshold filters (W1-G) — Jupiter has no server-side
    // organicScore/liquidity/verification filter on any read endpoint
    // (recon-docs-tokens.md §7); applied to the raw array BEFORE projection.
    const filters: JupiterTokenThresholdFilters = {
      minOrganicScore: num(p, "minOrganicScore"),
      verifiedOnly: bool(p, "verifiedOnly"),
      minLiquidity: num(p, "minLiquidity"),
    };
    const filterError = validateJupiterTokenThresholdFilters(filters);
    if (filterError) return fail(filterError);

    // Every return path maps the raw token array through the concise projector
    // (P0-3c) so default-limit trending stays under the overflow threshold.
    if (category === "recent") {
      const tokens = filterJupiterTokensByThreshold(await getJupiterRecentTokens(), filters);
      return ok(projectJupiterTokens(tokens, { statsInterval }));
    }
    // Casts are safe: membership was validated by the Sets above (recent + tags
    // handled here; unknown categories already failed), so `category` is one of
    // the real tag/category literals.
    if (VALID_TAGS.has(category as JupiterTokenTag)) {
      const tokens = filterJupiterTokensByThreshold(
        await getJupiterTokensByTag(category as JupiterTokenTag),
        filters,
      );
      return ok(projectJupiterTokens(tokens, { statsInterval }));
    }
    const tokens = filterJupiterTokensByThreshold(
      await getJupiterTokensByCategory({ category: category as JupiterTokenCategory, interval, limit }),
      filters,
    );
    return ok(projectJupiterTokens(tokens, { statsInterval }));
  },

  // ── Swap (W5 design §6/R4 — fee-bearing /build atomic flip) ───
  //
  // Both quote and execute build via `prepareFeeBearingJupiterSwap` (the ONE
  // place `platformFeeBps`/`feeAccount` are set — always the hardcoded 25bps
  // + the derived treasury ATA, never model-controllable). The quote is
  // wallet-scoped (unlike the old `/order` path): a fee-bearing `/build`
  // needs a real `taker`. Execute writes durable truth DIRECTLY to
  // `agent_activity` via the K2 staged Solana seam (capture:"none" in
  // mutation-matrix.ts) instead of the legacy `_tradeCapture` pipeline.
  "solana.swap.quote": async (p, ctx) => {
    const inputRaw = str(p, "inputToken"), outputRaw = str(p, "outputToken");
    const amount = num(p, "amount");
    if (!inputRaw || !outputRaw || amount == null) return fail("Missing required: inputToken, outputToken, amount");

    const slippageViolation = jupiterSlippageViolation("solana.swap.quote", p);
    if (slippageViolation) return fail(slippageViolation);

    let taker: string;
    try {
      taker = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    let knobs: JupiterFeeSwapKnobs;
    try {
      knobs = resolveJupiterFeeSwapKnobs(p);
    } catch (err) {
      return fail(`solana.swap.quote failed: ${swapFailureMessage(err)}`);
    }

    const [{ token: inputToken, safety: inputSafety }, { token: outputToken, safety: outputSafety }] = await Promise.all([
      requireJupiterResolvedTokenWithSafety(inputRaw),
      requireJupiterResolvedTokenWithSafety(outputRaw),
    ]);
    const amountRaw = uiToTokenAmount(amount, inputToken.decimals).toString();

    let prepared;
    try {
      prepared = await prepareFeeBearingJupiterSwap({
        connection: getSolanaConnection(),
        inputMint: inputToken.address,
        outputMint: outputToken.address,
        amountRaw,
        taker,
        knobs,
        inputDecimals: inputToken.decimals,
      });
    } catch (err) {
      return fail(`solana.swap.quote failed: ${swapFailureMessage(err)}`);
    }

    const safety = inputSafety || outputSafety
      ? { ...(inputSafety ? { inputToken: inputSafety } : {}), ...(outputSafety ? { outputToken: outputSafety } : {}) }
      : undefined;

    const { priceImpactFraction, routePlan } = projectJupiterSwapRoute(prepared.raw);
    return ok({
      inputToken,
      outputToken,
      ...(safety ? { safety } : {}),
      inputAmountRaw: prepared.raw.inAmount,
      outputAmountRaw: prepared.raw.outAmount,
      otherAmountThreshold: prepared.raw.otherAmountThreshold,
      slippageBps: knobs.slippageBps,
      // Decimal FRACTION, not a percent — see `../swap-route-projector.ts`.
      priceImpactFraction,
      routePlan,
      feePreview: buildJupiterFeePreview(prepared),
    });
  },

  "solana.swap.execute": async (p, ctx): Promise<ToolResult> => {
    const toolId = "solana.swap.execute";
    const inputRaw = str(p, "inputToken"), outputRaw = str(p, "outputToken");
    const amount = num(p, "amount");
    if (!inputRaw || !outputRaw || amount == null) return fail("Missing required: inputToken, outputToken, amount");

    const slippageViolation = jupiterSlippageViolation(toolId, p);
    if (slippageViolation) return fail(slippageViolation);

    const sessionId = ctx.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);

    // Resolve owner + signer BEFORE any provider call (5D-protocols p2) so a
    // session scope mismatch fails closed without an on-chain side effect.
    let addr: string, secret: Uint8Array;
    try {
      addr = walletAddress(p, ctx);
      secret = walletSecret(ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    let knobs: JupiterFeeSwapKnobs;
    try {
      knobs = resolveJupiterFeeSwapKnobs(p);
    } catch (err) {
      return fail(`${toolId} failed: ${swapFailureMessage(err)}`);
    }

    const [{ token: inputToken }, { token: outputToken }] = await Promise.all([
      requireJupiterResolvedTokenWithSafety(inputRaw),
      requireJupiterResolvedTokenWithSafety(outputRaw),
    ]);
    const amountRaw = uiToTokenAmount(amount, inputToken.decimals).toString();

    // R4: re-fetch the SAME fresh matched quote the prequote gate
    // (executeProtocolTool, BEFORE this handler runs) already proved exists.
    // The gate's hash match already proves every REQUEST param (mints,
    // amount, fee/tip/CU-strategy/DEX-filter/maxAccounts/wrap knobs) is
    // identical to the quote; what it CANNOT prove is that this fresh fee
    // derivation still lands on the same treasury ATA — that check runs
    // explicitly below, against the persisted preview read here.
    const matched = await findFreshMatchedSwapPrequote(toolId, sessionId, p, ctx);
    const persistedFeePreview = matched
      ? jupiterFeePreviewSchema.safeParse((matched.safetyDetail as Record<string, unknown>).feePreview)
      : undefined;
    if (!matched || !persistedFeePreview?.success) {
      return fail(`${toolId} failed: no matching fee-bearing quote found. Call solana.swap.quote first with the exact same params, then retry.`);
    }

    const connection = getSolanaConnection();
    const sharedEventFields = {
      eventRole: "swap" as const,
      protocol: SWAP_PROTOCOL,
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      chainSlug: "solana",
      chainFamily: "solana" as const,
      walletAddress: addr,
      sessionId,
      // `buildActivityTokenLeg` (../activity-token-leg.ts) owns the leg shape:
      // it adds the exact-decimal `amountHuman` sibling the activity feed
      // shows the agent as its primary human amount. The repo stores that
      // field verbatim and derives nothing, so omitting it leaves the row's
      // human amount null forever.
      tokenIn: buildActivityTokenLeg({
        tokenAddress: inputToken.address, tokenSymbol: inputToken.symbol,
        tokenDecimals: inputToken.decimals, amountRaw,
      }),
    };

    // Phase A (pre-intent): fresh /build + R4 shape revalidation. ANY failure
    // here is pre-broadcast — nothing has been signed or recorded yet. Per
    // K1's stage/error mapping table (validation.ts) every rejection at this
    // stage is `route_not_found`, the generic build-rejection bucket: what
    // remains are trade-SHAPE divergences (swap mode, fee destination), and
    // none of them is a slippage event the agent could answer by widening its
    // tolerance. The quote-to-quote price floor that used to file `slippage`
    // here was removed by owner decision — see `fee-swap-revalidate.ts`.
    const preBroadcastFail = async (failureCode: AgentActivityFailureCode, err: unknown): Promise<ToolResult> => {
      const reason = swapFailureMessage(err);
      const { executionId } = await createAgentActivityPreBroadcastFailure({
        toolId, namespace: SWAP_NAMESPACE, intentParams: p,
        event: {
          ...sharedEventFields,
          kind: "swap",
          eventIndex: 0,
          failureCode,
          failureReason: reason,
          // No output amount exists yet on a pre-broadcast failure — only the
          // token identity is known, so the leg carries no human amount.
          tokenOut: buildActivityTokenLeg({
            tokenAddress: outputToken.address, tokenSymbol: outputToken.symbol,
            tokenDecimals: outputToken.decimals,
          }),
        },
      });
      return { success: false, output: `${toolId} failed: ${reason}`, data: { _executionId: executionId } };
    };

    let prepared: Awaited<ReturnType<typeof prepareFeeBearingJupiterSwap>>;
    try {
      prepared = await prepareFeeBearingJupiterSwap({
        connection, inputMint: inputToken.address, outputMint: outputToken.address, amountRaw, taker: addr, knobs,
        inputDecimals: inputToken.decimals,
      });
    } catch (err) {
      return preBroadcastFail("route_not_found", err);
    }
    try {
      assertExactInSwapMode(prepared.raw);
    } catch (err) {
      return preBroadcastFail("route_not_found", err);
    }
    try {
      assertFeePolicyUnchanged(persistedFeePreview.data, prepared.feeMint, prepared.feeAccount);
    } catch (err) {
      return preBroadcastFail("route_not_found", err);
    }

    // Record the intent BEFORE signing. The settlement profile
    // (`jupiter-swaps/settlement-profile.ts`) is the row's OWN evidence of the
    // economics Vex approved — the tip the build-response guard certified, the
    // exact-in amount, the wrap knob — and is what later lets the K3 sweep
    // decode a native-SOL swap instead of leaving it pending forever. It is
    // omitted (never faked) when those facts cannot be stated honestly; the
    // sweep then falls back to the generic decoder.
    const routeProvenance = buildSolanaSettlementRouteProvenance({
      inputMint: inputToken.address,
      outputMint: outputToken.address,
      inputAmountRaw: amountRaw,
      approvedTipLamports: prepared.knobs.tipLamports,
      certifiedTip: prepared.submitTipProof?.describe() ?? null,
      wrapAndUnwrapSol: prepared.knobs.wrapAndUnwrapSol,
    });
    const { executionId, events } = await createAgentActivityIntent({
      toolId, namespace: SWAP_NAMESPACE, intentParams: p,
      events: [{
        ...sharedEventFields,
        kind: "swap",
        eventIndex: 0,
        tokenOut: buildActivityTokenLeg({
          tokenAddress: outputToken.address, tokenSymbol: outputToken.symbol,
          tokenDecimals: outputToken.decimals, amountRaw: prepared.raw.outAmount,
        }),
        // Vex's 25 bps, recorded as the exact token amount (migration 050
        // Part 2). This path fetches NO USD price, so `usd_vex_fee_est` is
        // NULL on every Jupiter swap row and would read as "Vex charged
        // nothing" if the amount were not here. Both figures come from
        // `fee-swap.ts`'s single exact bigint derivation — the same numbers
        // `assertFeePolicyUnchanged` re-checked and the approval preview
        // disclosed — so the fee shown, the fee charged and the fee recorded
        // are one value. `feeMint` IS the input mint by construction (the fee
        // is charged on the input side), which is why the input token's
        // symbol/decimals describe it.
        vexFee: {
          tokenAddress: prepared.feeMint,
          tokenSymbol: inputToken.symbol,
          tokenDecimals: inputToken.decimals,
          amountRaw: prepared.feeAmountRaw,
          amountHuman: prepared.feeAmountDecimal,
        },
        ...(routeProvenance ? { routeProvenance } : {}),
      }],
    });
    const eventRow = events[0]!;

    // Sign-only, VERIFY mode — the fresh `/build` response's OWN
    // `blockhashWithMetadata` is evidence tied to these exact bytes. A throw
    // here is a POST-INTENT failure: finalize the EXISTING row, never a
    // second intent (design R2).
    let signedTx: PreparedSolanaTx;
    try {
      const keypair = Keypair.fromSecretKey(secret);
      signedTx = await prepareVersionedTx(prepared.unsignedTx.serialize(), keypair, {
        knownBlockhash: { blockhash: prepared.recentBlockhash, lastValidBlockHeight: prepared.lastValidBlockHeight },
        connection,
      });
    } catch (err) {
      const reason = swapFailureMessage(err);
      await failActivityEvent(eventRow.id, { failureCode: "unknown", failureReason: reason });
      return {
        success: false,
        output: `${toolId} failed: ${reason} — recorded (execution ${executionId}); nothing was broadcast.`,
        data: { _executionId: executionId },
      };
    }

    // Persist signature + blockhash evidence BEFORE the submit call (CAS).
    const staged = await markActivitySolanaBroadcast(eventRow.id, {
      txHash: signedTx.signature,
      fromAddress: addr,
      recentBlockhash: signedTx.recentBlockhash,
      lastValidBlockHeight: signedTx.lastValidBlockHeight,
    });
    if (!staged.applied) {
      logger.warn(`${toolId}.staging_cas_miss`, { executionId, eventId: eventRow.id });
      return {
        success: false,
        output: `${toolId}: an internal error left this swap unrecorded before broadcast — refusing to submit untracked. Check execution ${executionId}; do not retry blindly.`,
        data: { _executionId: executionId },
      };
    }

    // Broadcast. The fee-bearing `/build` response is the ONE Solana path that
    // can carry a qualifying Jupiter tip, and `assertBuildResponseSafeToSign`
    // has already PROVEN it (recipient on the published allowlist, exact
    // approved amount) — that proof is what unlocks `/tx/v1/submit`. An
    // agent-approved zero tip yields no proof and lands over RPC instead of
    // being silently dropped. A signature mismatch or an ambiguous transport
    // failure NEVER terminalizes the row; the canonical local signature stays
    // and the Solana sweep (K3) resolves the row later.
    const broadcast = await broadcastStagedSolanaTx({
      toolId,
      rowId: eventRow.id,
      prepared: signedTx,
      lane: prepared.submitTipProof
        ? { kind: "jupiter_submit", tipProof: prepared.submitTipProof }
        : { kind: "rpc" },
    });
    if (broadcast.kind === "rejected_before_broadcast") {
      // The landing service ANSWERED and refused: nothing went on-chain.
      // Reporting this as "pending confirmation" would be a lie. The row still
      // stays pending — the sweep owns terminality (design D4).
      return {
        success: false,
        output: `${toolId}: this swap was rejected before broadcast — nothing went on-chain: ${broadcast.reason}. Recorded (execution ${executionId}); do not retry until the cause is fixed.`,
        data: {
          _executionId: executionId,
          status: "rejected_before_broadcast",
          reason: broadcast.reason,
        },
      };
    }

    return {
      success: false,
      output: `Swap broadcast (signature ${signedTx.signature}) — confirmation pending, tracked automatically. Do not retry.`,
      data: {
        _executionId: executionId,
        status: "pending",
        signature: signedTx.signature,
        explorerUrl: solanaExplorerUrl(signedTx.signature),
        inputToken: inputToken.symbol,
        outputToken: outputToken.symbol,
        feePreview: buildJupiterFeePreview(prepared),
      },
    };
  },
};
