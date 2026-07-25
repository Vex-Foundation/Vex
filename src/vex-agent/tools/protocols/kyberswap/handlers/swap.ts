/**
 * KyberSwap swap + chain + token handlers.
 *
 * `kyberswap.swap.execute` (Agent Scan plan §4.2/§11.1) drives the staged
 * sign→persist→broadcast contract on `agent_activity` primitives: every
 * planned broadcast (an allowance reset, an allowance grant, the swap
 * itself) gets its `agent_activity` event row created — atomically, with the
 * `protocol_executions` intent row — BEFORE anything is signed. Each
 * broadcast persists its signed hash BEFORE it reaches the network. The swap
 * event is finalized ONLY from receipt Transfer-delta decoding
 * (`evm/swap-settlement.ts`) — the quote/build response is never recorded as
 * executed truth.
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import { getKyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import { getKyberCommonClient } from "@tools/kyberswap/common/client.js";
import { getKyberChains, resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import {
  getKyberEvmClients,
  verifyRouterAddress,
  planKyberAllowance,
  buildApproveCalldata,
  signStageBroadcast,
  decodeKyberSwapSettlement,
  type StagedBroadcastOutcome,
} from "@tools/kyberswap/evm-utils.js";
import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  META_AGGREGATION_ROUTER_V2,
  NATIVE_TOKEN_ADDRESS,
  KYBERSWAP_FEE_BPS,
  KYBERSWAP_FEE_CHARGE_BY,
  KYBERSWAP_FEE_RECEIVER,
  KYBERSWAP_DEFAULT_SLIPPAGE_BPS,
  KYBERSWAP_MAX_SLIPPAGE_BPS,
} from "@tools/kyberswap/constants.js";
import { verifyBuiltKyberSwap } from "@tools/kyberswap/evm/swap-calldata-guard.js";
import {
  computeApprovedMinOut,
  parseRouteRefPriceFloor,
  KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
} from "@tools/kyberswap/swap-price-floor.js";
import { computeKyberVexFeeRaw } from "@tools/kyberswap/swap-vex-fee.js";
import { checkSlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";
import { findFreshMatchedSwapPrequote } from "@vex-agent/tools/protocols/swap-prequote.js";
import { getKyberWrappedNativeAddress } from "@tools/kyberswap/wrapped-native.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { resolveTokenMetadataStrict, type ResolvedKyberTokenMetadata, requireFeature, resolveChainWithId } from "@tools/kyberswap/helpers.js";
import { formatRouteSummary, sanitizeProviderNote } from "../helpers.js";
import { estimateKyberSwapCostsUsd } from "../swap-cost-estimate.js";
import logger from "@utils/logger.js";
import { isRecord } from "@utils/validation-helpers.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  abortPlannedEvents,
  type AgentActivityEvent,
  type AgentActivityEventRole,
  type AgentActivityLegInput,
  type CreatePendingActivityEventInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { registerSettlementDecoder } from "@vex-agent/sync/settlement-decoders.js";
import { revealUniswapPair } from "../../../registry/uniswap-reveal.js";
import { isRevealEligibleKyberFailure } from "../../../registry/uniswap-reveal-eligibility.js";
import { mapKyberFailureToActivityCode, deriveKyberRevealFailure, deriveKyberMinedRevertRevealFailure } from "../failure-mapping.js";

import { parseUnits, formatUnits, getAddress, type Address, type Hex } from "viem";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

const PROTOCOL = "kyberswap";

// ── Read-only token safety surfacing for kyberswap.swap.quote (Stage 6b) ──
//
// The quote is informational: it surfaces honeypot / fee-on-transfer risk so
// the agent can see EVM token danger at quote time. It NEVER aborts — gating
// stays in kyberswap.swap.execute. Each leg is one of:
//  - { native: true }                   native sentinel — no honeypot concept
//  - { isHoneypot, isFOT, tax }          live token API audit
//  - { checkFailed: true, reason }       fail-soft: bounded reason class only

/**
 * Bounded failure class for a swallowed honeypot/FoT check.
 *
 * NEVER carries raw provider/HTTP text. It is derived defensively from the
 * caught value's VexError code / numeric status / message keywords so neither
 * the log payload nor the quote output can leak URLs, HTML, API keys, or status
 * bodies.
 */
type SafetyCheckFailureReason = "timeout" | "rate_limited" | "kyber_error" | "unavailable";

type QuoteSafetyLeg =
  | { readonly native: true }
  | { readonly isHoneypot: boolean; readonly isFOT: boolean; readonly tax: number }
  | { readonly checkFailed: true; readonly reason: SafetyCheckFailureReason };

interface QuoteSafety {
  readonly tokenIn: QuoteSafetyLeg;
  readonly tokenOut: QuoteSafetyLeg;
}

/**
 * Classify a caught (untrusted) value into a bounded failure reason.
 *
 * Defensive: treats the value as `unknown`, inspects only a VexError `code`, a
 * numeric `status`, and lowercased keyword matches on a string `message`. The
 * raw message text is NEVER returned or logged — only one of the four bounded
 * literals leaves this function.
 */
function classifySafetyCheckFailure(err: unknown): SafetyCheckFailureReason {
  const code = err instanceof VexError ? err.code : undefined;
  if (code === ErrorCodes.KYBER_TIMEOUT || code === ErrorCodes.HTTP_TIMEOUT) return "timeout";
  if (code === ErrorCodes.KYBER_RATE_LIMITED) return "rate_limited";
  if (typeof code === "string" && code.startsWith("KYBER_")) return "kyber_error";

  const record = isRecord(err) ? err : undefined;
  const status = record && typeof record.status === "number" ? record.status : undefined;
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";

  const message = record && typeof record.message === "string" ? record.message.toLowerCase() : "";
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limited";
  }
  if (message.includes("timeout") || message.includes("timed out") || message.includes("etimedout") || message.includes("abort")) {
    return "timeout";
  }
  return "unavailable";
}

/**
 * Resolve the read-only safety leg for a single resolved token.
 *
 * Native tokens have no honeypot concept and are marked, not checked.
 * Any failure of the (untrusted, network) honeypot check is swallowed into a
 * bounded `{ checkFailed: true, reason }` marker — raw provider/HTTP text
 * (URLs, HTML, keys, status bodies) is never propagated into the log payload
 * or the quote output.
 */
async function resolveQuoteSafetyLeg(
  chainId: number,
  token: { readonly address: Address; readonly isNative: boolean },
): Promise<QuoteSafetyLeg> {
  if (token.isNative) return { native: true };
  try {
    const info = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, token.address);
    return { isHoneypot: info.isHoneypot, isFOT: info.isFOT, tax: info.tax };
  } catch (err) {
    // Read-only fail-soft: log only a bounded class (no raw provider/HTTP text).
    const reason = classifySafetyCheckFailure(err);
    logger.warn("kyberswap.swap.quote.safety_check_failed", {
      chainId,
      address: token.address,
      reason,
    });
    return { checkFailed: true, reason };
  }
}

/**
 * Vex integrator fee fields for GET /routes. Sourced ONLY from the
 * product-owner-reviewed venue constants (never from tool/model params) and
 * spread IDENTICALLY into the quote and the execute re-quote, so the route the
 * user was shown and the route that broadcasts carry the same fee line. Kyber
 * echoes these back inside `routeSummary.extraFee`, which POST /route/build
 * consumes verbatim — we never mutate the summary.
 */
const VEX_INTEGRATOR_FEE_ROUTE_PARAMS = {
  feeAmount: String(KYBERSWAP_FEE_BPS),
  isInBps: true,
  chargeFeeBy: KYBERSWAP_FEE_CHARGE_BY,
  feeReceiver: KYBERSWAP_FEE_RECEIVER,
} as const;

type KyberGetRouteResponse = Awaited<ReturnType<ReturnType<typeof getKyberAggregatorClient>["getRoute"]>>;
type KyberBuildRouteResponse = Awaited<ReturnType<ReturnType<typeof getKyberAggregatorClient>["buildRoute"]>>;

// ── Reveal-on-failure (plan §11.2) ──────────────────────────────────

/**
 * On an eligible Kyber failure, reveal the hidden Uniswap pair for this
 * session and return the reveal-aware suffix for the agent-facing message.
 * A missing/undefined `sessionId` never reveals (fail-closed) — the caller
 * still gets the base failure message.
 */
function revealOnEligibleFailure(
  err: unknown,
  sessionId: string | undefined,
  tokenInputsValidated: boolean,
): string {
  const revealFailure = deriveKyberRevealFailure(err, tokenInputsValidated);
  if (!revealFailure || !isRevealEligibleKyberFailure(revealFailure) || sessionId === undefined) {
    return "";
  }
  revealUniswapPair(sessionId);
  return " Uniswap (swap_quote_uniswap / swap_execute_uniswap) is now available for this session as a fallback venue.";
}

/**
 * REVISION 1 (reveal-on-execute-revert design) — on a `swap`-role MINED
 * on-chain revert (`outcome.kind === "reverted"` in the staged broadcast
 * loop), reveal the hidden Uniswap pair and return the EXECUTE-stage suffix
 * (R5) — distinct wording from `revealOnEligibleFailure`'s quote-stage suffix
 * so the agent does not blindly resubmit the identical failing Kyber route on
 * the fallback. `eventRole` gates construction of the reveal signal at
 * `deriveKyberMinedRevertRevealFailure` (R1): an allowance/allowance_reset
 * leg reverting NEVER reaches `revealUniswapPair`.
 */
function revealOnSwapMinedRevert(eventRole: AgentActivityEventRole, sessionId: string): string {
  const revealFailure = deriveKyberMinedRevertRevealFailure(eventRole);
  if (!revealFailure || !isRevealEligibleKyberFailure(revealFailure)) return "";
  revealUniswapPair(sessionId);
  return " The Kyber swap transaction reverted on-chain. Do not retry that Kyber route. Uniswap quoting is now unlocked for this session — request a fresh swap_quote_uniswap before considering execution.";
}

/**
 * The ONE entry point for provider-error text that reaches a ToolResult
 * `output` string, a log payload, or a persisted `agent_activity` reason —
 * never `err.message`/the raw caught value directly (Codex final-review
 * round 3, finding 1 / C37). A thin delegate to the canonical scrubber:
 * `runtime/errors.ts`'s `summarizeProtocolError` is the SINGLE owner of
 * provider-error redaction (secrets, URLs, JSON/bracket bodies, HTML
 * documents, Authorization/Cookie/Bearer/key-token-secret-password
 * assignments, whitespace collapse, length cap) for BOTH thrown errors and
 * (via this delegate) values this handler returns as `ToolResult`s instead
 * of throwing. FIX3-W2a's two venue-local pre-scrub supplements (HTML
 * stripping; a Bearer-before-header-name fix) are DELETED here — C37 moves
 * both fixes into the shared scrub core itself so every consumer benefits,
 * not just this venue; forking a second copy locally is exactly what C37
 * forbids ("delete venue-local preprocessors").
 */
function kyberFailureMessage(toolId: string, err: unknown): string {
  return summarizeProtocolError(err).message;
}

// ── Slippage + price floor ───────────────────────────────────────────

/**
 * Resolve the slippage this call will apply, or a rejection reason.
 *
 * `slippageBps` is BOTH the number handed to `/route/build` and the number the
 * approved price floor is computed from, so it is resolved identically at quote
 * time and execute time — an omitted value takes the SAME venue default on both
 * sides, which is what lets a quote-without-slippage authorize an
 * execute-without-slippage. The Vex ceiling is applied here (and only here for
 * this venue): the manifest `unit: "bps"` gate proves integrality but
 * deliberately applies no maximum.
 */
function resolveKyberSlippageBps(
  toolId: string,
  p: Record<string, unknown>,
): { readonly ok: true; readonly bps: number } | { readonly ok: false; readonly reason: string } {
  const raw = num(p, "slippageBps");
  const bps = raw ?? KYBERSWAP_DEFAULT_SLIPPAGE_BPS;
  const violation = checkSlippageBps(
    `Parameter "slippageBps" for ${toolId}`,
    bps,
    KYBERSWAP_MAX_SLIPPAGE_BPS,
  );
  return violation ? { ok: false, reason: violation } : { ok: true, bps };
}

/**
 * The persisted quote-time floor for THIS execute, or a refusal.
 *
 * Re-reads the SAME fresh matched prequote row the gate already proved exists
 * (mirrors `solana.swap.execute`), and pulls the `route_ref` price floor Vex
 * computed when the user was shown the quote. Fail-closed: no row, or a row
 * without a floor (a pre-upgrade quote, or one whose route output was
 * unusable), refuses rather than signing with no independent floor at all.
 */
async function requireApprovedMinOut(
  toolId: string,
  sessionId: string,
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<{ readonly ok: true; readonly approvedMinOutRaw: bigint } | { readonly ok: false; readonly reason: string }> {
  const noFloor = {
    ok: false,
    reason:
      "no approved price floor is on record for this trade. "
      + "Call kyberswap.swap.quote with the exact same params, then retry.",
  } as const;
  let matched: Awaited<ReturnType<typeof findFreshMatchedSwapPrequote>>;
  try {
    matched = await findFreshMatchedSwapPrequote(toolId, sessionId, p, context);
  } catch {
    return noFloor;
  }
  if (!matched) return noFloor;
  const floor = parseRouteRefPriceFloor(matched.routeRef);
  if (!floor) return noFloor;
  return { ok: true, approvedMinOutRaw: BigInt(floor.approvedMinOutRaw) };
}

// ── Settlement decoding (registered once at module load) ───────────

interface KyberSettlementReceipt {
  readonly logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}

function isKyberSettlementReceipt(value: unknown): value is KyberSettlementReceipt {
  return isRecord(value) && Array.isArray(value.logs);
}

registerSettlementDecoder(PROTOCOL, (input) => {
  if (!isKyberSettlementReceipt(input.receipt)) return null;
  if (input.tokenInAddress === null || input.tokenOutAddress === null) return null;

  const isNativeAddr = (addr: string) => addr.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
  const decoded = decodeKyberSwapSettlement({
    logs: input.receipt.logs,
    walletAddress: input.walletAddress,
    tokenIn: { isNative: isNativeAddr(input.tokenInAddress), address: input.tokenInAddress },
    tokenOut: { isNative: isNativeAddr(input.tokenOutAddress), address: input.tokenOutAddress },
    // NOTE (named residual risk): a native tokenIn leg's executed amount is a
    // KNOWN certainty from the signed transaction's own value (Kyber is
    // exact-input), but the repair sweep's decoder input carries no amount
    // fields (only addresses) — this decoder therefore CANNOT determine a
    // native tokenIn leg's executed amount outside the execute handler's own
    // immediate-confirm path (which supplies it directly, see below). A
    // crash between broadcast and immediate confirm for a native-tokenIn swap
    // stays pending until manual repair — see the handler's module doc.
    wrappedNativeAddress: (() => {
      const slug = chainIdToSlugSafe(input.chainId);
      return slug ? tryGetWrappedNativeAddress(slug) : undefined;
    })(),
    // C21 (Codex final-review finding 6): bind the WETH Withdrawal event to
    // the router that actually unwraps it. The aggregator router is the SAME
    // fixed address on every Kyber-supported chain, so — unlike the signed
    // tx's own native-in value — this one IS available without any per-row
    // context.
    wrappedNativeWithdrawalSource: META_AGGREGATION_ROUTER_V2,
  });
  return decoded
    ? {
        executedAmountInRaw: decoded.amountInRaw,
        executedAmountOutRaw: decoded.amountOutRaw,
      }
    : null;
});

function chainIdToSlugSafe(chainId: number): KyberChainSlug | undefined {
  const chains = getKyberChains();
  return chains.find((c) => c.chainId === chainId)?.slug;
}

function tryGetWrappedNativeAddress(slug: KyberChainSlug): string | undefined {
  try {
    return getKyberWrappedNativeAddress(slug);
  } catch {
    return undefined;
  }
}

// ── Shared execute plumbing ──────────────────────────────────────────

interface SwapEventPlan {
  readonly eventRole: AgentActivityEventRole;
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value?: bigint };
  readonly event: Omit<CreatePendingActivityEventInput, "protocolExecutionId" | "eventIndex">;
}

/** A route/validation failure before anything could be signed — hashless `definitively_failed` row. */
async function failPreBroadcast(
  toolId: string,
  p: Record<string, unknown>,
  sessionId: string,
  walletAddress: string,
  chainId: number,
  chainSlug: string,
  tokenIn: AgentActivityLegInput | undefined,
  tokenOut: AgentActivityLegInput | undefined,
  err: unknown,
  tokenInputsValidated: boolean,
): Promise<ToolResult> {
  const failureCode = mapKyberFailureToActivityCode(err);
  const failureReason = kyberFailureMessage(toolId, err);
  const { executionId } = await createAgentActivityPreBroadcastFailure({
    toolId,
    namespace: PROTOCOL,
    intentParams: p,
    event: {
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: PROTOCOL,
      chainId,
      chainSlug,
      walletAddress,
      sessionId,
      tokenIn,
      tokenOut,
      failureCode,
      failureReason,
    },
  });
  const revealSuffix = revealOnEligibleFailure(err, sessionId, tokenInputsValidated);
  return {
    success: false,
    output: `${toolId} failed: ${failureReason}.${revealSuffix}`,
    data: { _executionId: executionId },
  };
}

/**
 * Finalize every planned event from `fromIndex` onward that was NEVER signed
 * (C17 / Codex final-review finding 3) — an early return after an
 * ambiguous/reverted broadcast, or a post-intent failure, must not leave
 * downstream rows permanently `pending` with no `submit_attempted_at` (the
 * repair sweep's candidate query excludes exactly those rows forever).
 * Best-effort: a throw here is logged, never propagated — the caller has
 * already decided its own return value and must not flip to a misleading
 * result just because this bookkeeping call failed.
 *
 * `reason` must be the bare descriptive tail, WITHOUT a "not attempted:"
 * prefix — `abortPlannedEvents` itself owns adding that prefix exactly once
 * (Codex final-review round 2, finding 9 / C36; see
 * `agent-activity.ts`'s `abortPlannedEvents` doc comment).
 */
async function abortRemainingPlans(executionId: number, fromIndex: number, reason: string): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("kyberswap.swap.execute.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: kyberFailureMessage("kyberswap.swap.execute", err),
    });
  }
}

// ── Handler map ──────────────────────────────────────────────────

export const SWAP_HANDLERS: Record<string, ProtocolHandler> = {
  // ── Chains ───────────────────────────────────────────────────────
  "kyberswap.chains": async () => ok(getKyberChains()),
  // C23 (Codex final-review finding 8): intersect the provider's live list
  // with OUR registry so a chain we no longer execute (Scroll/zkSync) — or a
  // brand-new provider chain we haven't onboarded — is never re-advertised as
  // Vex-supported.
  "kyberswap.chains.supported": async () => {
    const supported = await getKyberCommonClient().getSupportedChains();
    const localChainIds = new Set<number>(getKyberChains().map((c) => c.chainId));
    return ok(supported.filter((c) => localChainIds.has(c.chainId)));
  },

  // ── Tokens ───────────────────────────────────────────────────────
  "kyberswap.tokens.check": async (p) => {
    const chain = str(p, "chain"), address = str(p, "address");
    if (!chain || !address) return fail("Missing required: chain, address");
    const { chainId } = resolveChainWithId(chain);
    const info = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, address);
    return ok({ chain, chainId, address, ...info });
  },

  // ── Swap quote (read-only) ────────────────────────────────────────
  "kyberswap.swap.quote": async (p, context) => {
    const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
    if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

    // Rejected HERE, not only at the execute: this quote seeds the prequote
    // whose persisted price floor the execute is held to, so a slippage the
    // execute would refuse must never produce a quote (or a floor) at all.
    const quoteSlippage = resolveKyberSlippageBps("kyberswap.swap.quote", p);
    if (!quoteSlippage.ok) return fail(quoteSlippage.reason);

    let slug: KyberChainSlug;
    let chainId: number;
    try {
      slug = resolveChainSlug(chain);
      requireFeature(slug, "aggregator");
      chainId = slugToChainId(slug);
    } catch (err) {
      const revealSuffix = revealOnEligibleFailure(err, context.sessionId, false);
      return fail(`kyberswap.swap.quote failed: ${kyberFailureMessage("kyberswap.swap.quote", err)}.${revealSuffix}`);
    }

    let tokenIn: ResolvedKyberTokenMetadata;
    let tokenOut: ResolvedKyberTokenMetadata;
    try {
      // Strict: address-only (+ native sentinel/keyword) — symbols are NOT
      // resolved via Kyber's DEX search here. A symbol like "USDC" can match the
      // wrong contract (e.g. axlUSDC) and seed a prequote for the wrong token, so
      // the quote resolution is symmetric with execute (resolveTokenMetadataStrict)
      // and EVM symbols must be resolved with token_find first.
      tokenIn = await resolveTokenMetadataStrict(tokenInRaw, chainId);
      tokenOut = await resolveTokenMetadataStrict(tokenOutRaw, chainId);
    } catch (err) {
      return fail(`kyberswap.swap.quote failed: ${kyberFailureMessage("kyberswap.swap.quote", err)}`);
    }
    const amountIn = parseUnits(amountInRaw, tokenIn.decimals).toString();

    let response: KyberGetRouteResponse;
    let safetyIn: QuoteSafetyLeg;
    let safetyOut: QuoteSafetyLeg;
    try {
      [response, safetyIn, safetyOut] = await Promise.all([
        getKyberAggregatorClient().getRoute(slug, {
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn,
          ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS,
        }),
        resolveQuoteSafetyLeg(chainId, tokenIn),
        resolveQuoteSafetyLeg(chainId, tokenOut),
      ]);
    } catch (err) {
      const revealSuffix = revealOnEligibleFailure(err, context.sessionId, true);
      return fail(`kyberswap.swap.quote failed: ${kyberFailureMessage("kyberswap.swap.quote", err)}.${revealSuffix}`);
    }
    const safety: QuoteSafety = { tokenIn: safetyIn, tokenOut: safetyOut };
    const route = formatRouteSummary(response.data.routeSummary);

    // Output-polish (plan §4.2): compact human summary FIRST, machine fields
    // after — as one JSON key ordering, not a free-text prefix, so `output`
    // stays parseable (every tool in this codebase returns JSON via `ok()`,
    // and downstream tests/consumers rely on `JSON.parse(result.output)`).
    const summary =
      `Quote: ${amountInRaw} ${tokenIn.symbol} → ~${route.amountOut} ${tokenOut.symbol} `
      + `(~$${route.amountOutUsd} est.) on ${slug}. Gas ~$${route.gasUsd} est.`
      // On an L2 the L1 data fee can rival or exceed execution gas — quoting
      // only `gasUsd` understated the real cost of the trade.
      + (route.l1FeeUsd !== null ? ` L1 data fee ~$${route.l1FeeUsd} est.` : "")
      + (route.priceImpact !== null ? ` Price impact ${(route.priceImpact * 100).toFixed(2)}%.` : "");

    return ok({
      summary,
      chain: slug, chainId,
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      routeSummary: route,
      routerAddress: response.data.routerAddress,
      safety,
    });
  },

  // ── Swap execute (mutating, staged broadcast) ─────────────────────
  "kyberswap.swap.execute": async (p, context): Promise<ToolResult> => {
    const toolId = "kyberswap.swap.execute";

    // Defensive guard against the spine-inherited `previewSupport:true`
    // matrix row (this manifest declares no `dryRun` param) — a caller that
    // still passes `dryRun` must NEVER reach a real broadcast just because
    // the runtime treated the call as a preview.
    if (p.dryRun === true) {
      return fail(`${toolId} does not support dryRun preview — call kyberswap.swap.quote instead.`);
    }

    const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
    if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

    // The prequote gate (executeProtocolTool) already blocks this tool
    // without a session — sessionId is guaranteed present here.
    const sessionId = context.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);

    // C22 (Codex final-review finding 7): resolve the signer's ADDRESS ONLY
    // (never decrypts) BEFORE token resolution, so a token-resolution failure
    // — or anything after it — records the REAL wallet_address, never an
    // empty string. The full (decrypting) signing wallet is resolved later,
    // only once we know the call may actually broadcast.
    let walletAddress: Address;
    try {
      walletAddress = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    let slug: KyberChainSlug;
    let chainId: number;
    try {
      slug = resolveChainSlug(chain);
      requireFeature(slug, "aggregator");
      chainId = slugToChainId(slug);
    } catch (err) {
      const revealSuffix = revealOnEligibleFailure(err, sessionId, false);
      return fail(`${toolId} failed: ${kyberFailureMessage(toolId, err)}.${revealSuffix}`);
    }

    let tokenIn: ResolvedKyberTokenMetadata;
    let tokenOut: ResolvedKyberTokenMetadata;
    try {
      tokenIn = await resolveTokenMetadataStrict(tokenInRaw, chainId);
      tokenOut = await resolveTokenMetadataStrict(tokenOutRaw, chainId);
    } catch (err) {
      // The REAL wallet_address (resolved above) is already known even
      // though the tokens never resolved.
      return failPreBroadcast(toolId, p, sessionId, walletAddress, chainId, slug, undefined, undefined, err, false);
    }

    // Full signing wallet (decrypts) — resolved only now that the call may
    // actually need to sign. Re-validates the SAME session/policy scope the
    // address-only resolution above already checked.
    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

    const { publicClient, walletClient } = getKyberEvmClients(slug, signer.privateKey);

    // Token safety gate — the ONLY hard block here is a CONFIRMED honeypot
    // (owner doctrine). FoT/high-tax is warn-only. A THROW from the check
    // itself means the safety check is UNAVAILABLE (fail-soft — proceed).
    for (const leg of [tokenIn, tokenOut]) {
      if (leg.isNative) continue;
      try {
        const check = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, leg.address);
        if (check.isHoneypot) {
          return failPreBroadcast(
            toolId, p, sessionId, walletAddress, chainId, slug,
            legInput(tokenIn), legInput(tokenOut),
            new Error(`Token ${leg.symbol} (${leg.address}) flagged as honeypot. Aborting swap.`),
            true,
          );
        }
        if (check.isFOT && check.tax > 0) logger.warn("kyberswap.swap.fot_warning", { token: leg.symbol, address: leg.address, tax: check.tax });
      } catch (err) {
        logger.warn("kyberswap.swap.safety_check_failed", { address: leg.address, reason: classifySafetyCheckFailure(err) });
      }
    }

    const amountIn = parseUnits(amountInRaw, tokenIn.decimals);
    const resolvedSlippage = resolveKyberSlippageBps(toolId, p);
    if (!resolvedSlippage.ok) {
      return failPreBroadcast(
        toolId, p, sessionId, walletAddress, chainId, slug,
        legInput(tokenIn), legInput(tokenOut),
        new VexError(ErrorCodes.KYBER_MALFORMED_PARAMS, resolvedSlippage.reason),
        true,
      );
    }
    const slippage = resolvedSlippage.bps;

    // The floor Vex computed and persisted when the user was shown the quote.
    // Read BEFORE the route call so a trade with no approved floor is refused
    // without touching the provider at all.
    const approvedFloor = await requireApprovedMinOut(toolId, sessionId, p, context);
    if (!approvedFloor.ok) {
      return failPreBroadcast(
        toolId, p, sessionId, walletAddress, chainId, slug,
        legInput(tokenIn), legInput(tokenOut),
        new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, `${toolId} refused: ${approvedFloor.reason}`),
        true,
      );
    }

    let routerAddress: Address;
    let routeSummaryRaw: KyberGetRouteResponse["data"]["routeSummary"];
    try {
      const routeResp = await getKyberAggregatorClient().getRoute(slug, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountIn.toString(),
        ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS,
      });
      verifyRouterAddress(routeResp.data.routerAddress, META_AGGREGATION_ROUTER_V2);
      routerAddress = routeResp.data.routerAddress;
      routeSummaryRaw = routeResp.data.routeSummary;
    } catch (err) {
      return failPreBroadcast(toolId, p, sessionId, walletAddress, chainId, slug, legInput(tokenIn), legInput(tokenOut), err, true);
    }

    // ── Phase A (pre-intent): balance/allowance-read/build + plan
    // construction + the atomic intent creation. ANY failure in this phase
    // uses `failPreBroadcast` — nothing has been signed yet, so a fresh
    // pre-broadcast-failure row is correct (C18: failPreBroadcast is
    // pre-intent ONLY).
    let executionId: number;
    let events: readonly AgentActivityEvent[];
    let plans: SwapEventPlan[];
    let buildResp: KyberBuildRouteResponse;
    try {
      if (!tokenIn.isNative) {
        await ensureErc20Balance(publicClient, {
          token: tokenIn.address,
          owner: walletAddress,
          required: amountIn,
          decimals: tokenIn.decimals,
          label: tokenIn.symbol,
        });
      }

      let allowancePlan: { needsReset: boolean; needsApprove: boolean } = { needsReset: false, needsApprove: false };
      if (!tokenIn.isNative) {
        allowancePlan = await planKyberAllowance(publicClient, tokenIn.address, walletAddress, routerAddress, amountIn);
      }

      buildResp = await getKyberAggregatorClient().buildRoute(slug, {
        routeSummary: routeSummaryRaw,
        sender: walletAddress,
        recipient: walletAddress,
        slippageTolerance: slippage,
      });
      verifyRouterAddress(buildResp.data.routerAddress, META_AGGREGATION_ROUTER_V2);

      // ── Pre-sign calldata assertion (the ONE gate on the opaque blob) ──
      // KyberSwap embeds the price protection inside calldata WE did not
      // build, so it is decoded and held to the floor Vex approved at quote
      // time AND to the floor this fresh route implies — plus the fee line,
      // the flags, the target, the spender and the native value. Runs BEFORE
      // the intent is created, so a refusal is a clean pre-broadcast failure
      // with nothing signed and nothing broadcast.
      const verdict = verifyBuiltKyberSwap(
        {
          calldata: buildResp.data.data as Hex,
          routerAddress: buildResp.data.routerAddress,
          transactionValue: buildResp.data.transactionValue,
        },
        {
          expectedRouter: META_AGGREGATION_ROUTER_V2,
          recipient: walletAddress,
          srcToken: getAddress(tokenIn.address),
          dstToken: getAddress(tokenOut.address),
          amountIn,
          srcIsNative: tokenIn.isNative,
          approvedMinOutRaw: approvedFloor.approvedMinOutRaw,
          freshMinOutRaw: computeApprovedMinOut(routeSummaryRaw.amountOut, slippage),
          floorAllowanceRaw: KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
        },
      );
      if (!verdict.ok) {
        throw new VexError(
          verdict.kind === "price_floor"
            ? ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED
            : ErrorCodes.KYBER_UNSAFE_BUILD,
          // Kept SHORT on purpose: `summarizeProtocolError` joins message +
          // hint and caps the pair at 200 chars, so a verbose reason silently
          // truncates away the actionable tail — the one part of a refusal the
          // agent must always receive.
          `Refused before signing: ${verdict.reason}.`,
          verdict.kind === "price_floor"
            ? "Nothing was signed. Get a fresh kyberswap.swap.quote."
            : "Nothing was signed. Re-quote; do not retry this build.",
        );
      }

      // C21 (Codex final-review finding 6): the native-in "requested" leg
      // recorded on the swap event is the SIGNED transaction's own declared
      // value (`transactionValue`), never a locally re-derived `amountIn` —
      // this is also what the settlement decoder treats as the EXECUTED
      // truth for a native leg (Kyber is exact-input, so the two coincide by
      // construction, but the build response is the authoritative source).
      const tokenInAmountRaw = tokenIn.isNative ? buildResp.data.transactionValue : amountIn.toString();
      const tokenInAmountHuman = tokenIn.isNative
        ? formatUnits(BigInt(buildResp.data.transactionValue), tokenIn.decimals)
        : amountInRaw;

      // The durable cost breakdown (migration 050). Derived here — AFTER the
      // calldata guard above accepted the build — so "25 bps of the input, on
      // the source token" is a proven property of the payload about to be
      // signed rather than an assumption.
      const swapCosts = estimateKyberSwapCostsUsd({
        gasUsd: buildResp.data.gasUsd,
        l1FeeUsd: routeSummaryRaw.l1FeeUsd,
        amountInUsd: buildResp.data.amountInUsd,
      });
      // The same fee as a FACT rather than a USD estimate (migration 050
      // Part 2). `amountIn` is the very bigint the guard just pinned to
      // `desc.amount`, and the guard also pinned the rate, the source-side
      // charge and the no-partial-fill flag — so this is the router's own
      // arithmetic over proven inputs, not a re-derivation of a provider hint.
      // It is recorded even when `usdVexFeeEst` is undefined, which is what
      // makes an absent USD read as "price unknown" instead of "no fee".
      const vexFeeRaw = computeKyberVexFeeRaw(amountIn);

      // ── Build the events plan BEFORE anything is signed (plan §11.1 step 1) ──
      const builtPlans: SwapEventPlan[] = [];
      if (allowancePlan.needsReset) {
        builtPlans.push({
          eventRole: "allowance_reset",
          txParams: { to: tokenIn.address, data: buildApproveCalldata(routerAddress, 0n) },
          event: {
            eventRole: "allowance_reset", kind: "swap", protocol: PROTOCOL,
            chainId, chainSlug: slug, walletAddress, sessionId,
            tokenIn: { tokenAddress: tokenIn.address, tokenSymbol: tokenIn.symbol, tokenDecimals: tokenIn.decimals, amountHuman: "0", amountRaw: "0" },
          },
        });
      }
      if (allowancePlan.needsApprove) {
        builtPlans.push({
          eventRole: "allowance",
          txParams: { to: tokenIn.address, data: buildApproveCalldata(routerAddress, amountIn) },
          event: {
            eventRole: "allowance", kind: "swap", protocol: PROTOCOL,
            chainId, chainSlug: slug, walletAddress, sessionId,
            tokenIn: { tokenAddress: tokenIn.address, tokenSymbol: tokenIn.symbol, tokenDecimals: tokenIn.decimals, amountHuman: formatUnits(amountIn, tokenIn.decimals), amountRaw: amountIn.toString() },
          },
        });
      }
      builtPlans.push({
        eventRole: "swap",
        txParams: {
          to: getAddress(buildResp.data.routerAddress),
          data: buildResp.data.data as Hex,
          value: BigInt(buildResp.data.transactionValue),
        },
        event: {
          eventRole: "swap", kind: "swap", protocol: PROTOCOL,
          chainId, chainSlug: slug, walletAddress, sessionId,
          tokenIn: { tokenAddress: tokenIn.address, tokenSymbol: tokenIn.symbol, tokenDecimals: tokenIn.decimals, amountHuman: tokenInAmountHuman, amountRaw: tokenInAmountRaw },
          tokenOut: { tokenAddress: tokenOut.address, tokenSymbol: tokenOut.symbol, tokenDecimals: tokenOut.decimals, amountHuman: formatUnits(BigInt(buildResp.data.amountOut), tokenOut.decimals), amountRaw: buildResp.data.amountOut },
          usdInEst: buildResp.data.amountInUsd,
          usdOutEst: buildResp.data.amountOutUsd,
          // `usd_fee_est` is FROZEN for the migration-050 dual-write window:
          // it keeps receiving `gasUsd` alone, byte-identical to its
          // pre-050 behavior, so old readers are unaffected. The honest gas —
          // L2 execution PLUS the L1 data fee, which on an OP-stack chain can
          // rival or exceed it — goes to `usd_network_gas_est`, so the two
          // legitimately differ on those chains. A later contract migration
          // drops `usd_fee_est`.
          usdFeeEst: buildResp.data.gasUsd,
          usdNetworkGasEst: swapCosts.usdNetworkGasEst,
          // Vex's own 25 bps, recorded for the first time. It rides the SWAP
          // leg deliberately: this row's status is what says whether the fee
          // was actually collected, so summing confirmed rows is honest revenue.
          usdVexFeeEst: swapCosts.usdVexFeeEst,
          // Charged on the SOURCE token and taken OUT of the input, so this is
          // a component of `tokenIn.amountRaw` above — never an extra debit.
          vexFee: {
            tokenAddress: tokenIn.address,
            tokenSymbol: tokenIn.symbol,
            tokenDecimals: tokenIn.decimals,
            amountRaw: vexFeeRaw.toString(),
            amountHuman: formatUnits(vexFeeRaw, tokenIn.decimals),
          },
          usdSource: "kyberswap_quote",
          routeProvenance: { routeID: routeSummaryRaw.routeID, checksum: routeSummaryRaw.checksum },
        },
      });
      plans = builtPlans;

      const created = await createAgentActivityIntent({
        toolId, namespace: PROTOCOL, intentParams: p,
        events: builtPlans.map((plan, i) => ({ ...plan.event, eventIndex: i })),
      });
      executionId = created.executionId;
      events = created.events;
    } catch (err) {
      return failPreBroadcast(toolId, p, sessionId, walletAddress, chainId, slug, legInput(tokenIn), legInput(tokenOut), err, true);
    }

    // ── Phase B (post-intent): staged broadcast loop. The intent + event
    // rows ALREADY EXIST at this point — C18 (Codex final-review finding 3):
    // a failure from here on must NEVER create a second execution. It aborts
    // the remaining never-signed rows instead and returns with the SAME
    // `_executionId`.
    let currentIndex = 0;
    // Read-after-write anchor for the NEXT leg: an allowance this loop just
    // confirmed is state the swap leg's pre-sign estimate depends on, and the
    // estimating node does not always have it yet (see
    // `dependent-leg-gas-estimate.ts`).
    let priorLeg: ConfirmedPriorLeg | undefined;
    try {
      for (let i = 0; i < plans.length; i++) {
        currentIndex = i;
        const plan = plans[i]!;
        const eventRow = events[i]!;
        const outcome: StagedBroadcastOutcome = await signStageBroadcast(
          publicClient, walletClient, plan.txParams,
          {
            onHashStaged: async (handles) => {
              const res = await markActivityBroadcast(eventRow.id, handles);
              if (!res.applied) {
                // C14 (Codex final-review finding 1): a CAS miss means this
                // row is no longer in the state we expect — refuse to
                // broadcast an UNTRACKED transaction. Throwing here aborts
                // `signStageBroadcast` BEFORE `sendRawTransaction` runs.
                throw new Error(`agent_activity: markActivityBroadcast CAS miss for event ${eventRow.id} — refusing to broadcast untracked`);
              }
            },
            onAccepted: async () => {
              const res = await markBroadcastAccepted(eventRow.id);
              if (!res.applied) logger.warn("kyberswap.swap.execute.broadcast_accept_miss", { id: eventRow.id });
            },
          },
          priorLeg,
        );

        if (outcome.kind === "ambiguous") {
          logger.info("kyberswap.swap.execute.ambiguous", { id: eventRow.id, stage: outcome.stage, txHash: outcome.txHash });
          await abortRemainingPlans(executionId, i + 1, `earlier ${plan.eventRole} ambiguous`);
          return {
            success: false,
            output: `${toolId}: broadcast of the ${plan.eventRole} transaction (${outcome.txHash}) could not be confirmed yet — it may still settle on-chain. Do not retry; this attempt is recorded as pending and will resolve automatically.`,
            data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
          };
        }

        if (outcome.kind === "reverted") {
          await failActivityEvent(eventRow.id, {
            failureCode: "mined_revert",
            failureReason: `${plan.eventRole} transaction ${outcome.txHash} reverted on-chain.`,
          });
          await abortRemainingPlans(executionId, i + 1, `earlier ${plan.eventRole} reverted`);
          // REVISION 1 R1: reveal ONLY for the swap leg (never allowance/allowance_reset).
          const revealSuffix = revealOnSwapMinedRevert(plan.eventRole, sessionId);
          return {
            success: false,
            output: `${toolId}: the ${plan.eventRole} transaction (${outcome.txHash}) reverted on-chain. No further steps were attempted.${revealSuffix}`,
            data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted" },
          };
        }

        // confirmed on-chain — from here on, a DB hiccup while RECORDING the
        // outcome must never be mistaken for the swap itself failing (funds
        // already moved). `confirmActivityEvent` throws only forwarded via
        // this bounded try/catch — logged, not propagated to the outer
        // post-intent failure handler.
        priorLeg = priorLegAnchorFrom(outcome.receipt.blockNumber);
        if (plan.eventRole !== "swap") {
          try {
            await confirmActivityEvent(eventRow.id, {});
          } catch (err) {
            logger.warn("kyberswap.swap.execute.confirm_failed", { id: eventRow.id, role: plan.eventRole, error: kyberFailureMessage(toolId, err) });
          }
          continue;
        }

        // Auto-pin (fail-soft) — Codex final-review round 4, finding 3: runs
        // IMMEDIATELY after on-chain confirmation, BEFORE decoding, so a
        // confirmed-but-undecodable settlement can never skip it (the acquired
        // ERC-20 must join tracked_tokens or balance scans miss it forever).
        // Token-in (spent) is deliberately NOT pinned. Never fails the swap.
        if (!tokenOut.isNative && getLocalChain(chainId)) {
          try {
            await pinTrackedToken({ walletAddress, chainId, tokenAddress: tokenOut.address, source: "swap" });
          } catch (err) {
            logger.warn("kyberswap.swap.execute.auto_pin_failed", { chain: slug, error: err instanceof Error ? err.name : "unknown" });
          }
        }

        // Bounded (Codex final-review round 2, finding 4 / C32): the receipt
        // is ALREADY confirmed on-chain at this point, so a throw from the
        // decoder itself must never escape to the outer post-intent catch —
        // that branch returns a generic result WITHOUT `outcome.txHash`
        // (§swap.ts post-intent catch below), which would silently lose the
        // known hash for a swap that genuinely succeeded. `swap-settlement.ts`
        // already guards its own malformed-log parsing (C32), so this catch
        // is defense-in-depth for any other unexpected decode failure; either
        // way, a caught throw here is treated exactly like a `null` decode —
        // it falls through to the SAME "confirmed_pending_amounts" branch,
        // which already preserves the tx hash.
        let decoded: ReturnType<typeof decodeKyberSwapSettlement>;
        try {
          decoded = decodeKyberSwapSettlement({
            logs: outcome.receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })),
            walletAddress,
            tokenIn: { isNative: tokenIn.isNative, address: tokenIn.address },
            tokenOut: { isNative: tokenOut.isNative, address: tokenOut.address },
            // C21: the SIGNED transaction's own declared value — never a
            // locally re-derived amount.
            nativeAmountInRaw: tokenIn.isNative ? buildResp.data.transactionValue : undefined,
            // Defensive: a lookup failure here must DECLINE the decode (→ the
            // "confirmed_pending_amounts" branch below), never throw — the swap
            // already broadcast and confirmed on-chain by this point, so an
            // uncaught throw would wrongly route to the post-intent failure
            // handler while this real row sits pending forever.
            wrappedNativeAddress: tokenOut.isNative ? tryGetWrappedNativeAddress(slug) : undefined,
            // C21: bind the WETH Withdrawal event to the VERIFIED router this
            // specific transaction used (never an unbound sum).
            wrappedNativeWithdrawalSource: tokenOut.isNative ? buildResp.data.routerAddress : undefined,
          });
        } catch (err) {
          logger.warn("kyberswap.swap.execute.settlement_decode_threw", {
            id: eventRow.id,
            txHash: outcome.txHash,
            error: kyberFailureMessage(toolId, err),
          });
          decoded = null;
        }

        if (!decoded) {
          logger.warn("kyberswap.swap.execute.settlement_undecodable", { id: eventRow.id, txHash: outcome.txHash });
          return {
            success: true,
            output: `${toolId}: swap confirmed on-chain (tx ${outcome.txHash}) but the executed amounts could not be decoded yet — check the transaction hash for the exact amounts. The record will finalize automatically.`,
            data: { _executionId: executionId, txHash: outcome.txHash, status: "confirmed_pending_amounts" },
          };
        }

        // C33 (Codex final-review round 2, finding 5): a failed WRITE here
        // must never be reported to the agent as an ordinary "confirmed"
        // swap — the chain-side settlement is real, but Vex's own record of
        // it did not persist. Tracked so the returned `status` can say so
        // (mirrors Uniswap's `confirmed_unrecorded` distinction).
        let confirmWriteFailed = false;
        try {
          const confirmResult = await confirmActivityEvent(eventRow.id, {
            executedAmountInHuman: formatUnits(BigInt(decoded.amountInRaw), tokenIn.decimals),
            executedAmountInRaw: decoded.amountInRaw,
            executedAmountOutHuman: formatUnits(BigInt(decoded.amountOutRaw), tokenOut.decimals),
            executedAmountOutRaw: decoded.amountOutRaw,
          });
          // C41 (Codex final-review round 3, finding 6): `.applied` was
          // previously ignored — a CAS miss (the row was no longer `pending`
          // when the UPDATE ran) still fell through as an ordinary
          // "confirmed" result. Recorded confirmation now requires EITHER a
          // fresh CAS-applied write, OR the row already being `confirmed`
          // with the SAME executed amounts we just tried to write (a benign
          // race — e.g. a concurrent repair-sweep pass already recorded this
          // exact outcome). Any other terminal state, or a confirmed row
          // with DIFFERENT amounts (a genuine conflict), is never reported
          // as recorded.
          if (!confirmResult.applied) {
            const alreadyMatches =
              confirmResult.row.status === "confirmed"
              && confirmResult.row.executedAmountInRaw === decoded.amountInRaw
              && confirmResult.row.executedAmountOutRaw === decoded.amountOutRaw;
            if (!alreadyMatches) {
              confirmWriteFailed = true;
              logger.warn("kyberswap.swap.execute.confirm_cas_miss", {
                id: eventRow.id,
                rowStatus: confirmResult.row.status,
              });
            }
          }
        } catch (err) {
          confirmWriteFailed = true;
          logger.warn("kyberswap.swap.execute.confirm_failed", { id: eventRow.id, error: kyberFailureMessage(toolId, err) });
        }

        // C34 (Codex final-review round 2, finding 6): the SUCCESS message's
        // input amount must be the DECODED executed amount, not the
        // requested `amountIn` echoed back — the whole point of net-delta
        // decoding is that the executed amount can differ from the request
        // (fee-on-transfer legs, dust, partial fills upstream); reporting the
        // request would contradict the persisted truth.
        const amountInHuman = formatUnits(BigInt(decoded.amountInRaw), tokenIn.decimals);
        const amountOutHuman = formatUnits(BigInt(decoded.amountOutRaw), tokenOut.decimals);
        // Output-polish (plan §4.2): compact human summary FIRST, machine
        // fields after — one JSON key ordering (see the quote handler's same
        // convention note).
        const summary =
          `Swapped ${amountInHuman} ${tokenIn.symbol} → ${amountOutHuman} ${tokenOut.symbol} on ${slug}. `
          + `Tx: ${outcome.txHash}` + (buildResp.data.amountInUsd ? ` (~$${buildResp.data.amountInUsd} in / ~$${buildResp.data.amountOutUsd} out, estimated).` : ".");

        // The build response's own cost disclosure was validated and then
        // dropped: `additionalCostUsd` is a real charge on this settlement
        // (gaslessness/positive-slippage handling), and the provider's
        // message explains it. Both are provider-authored, so the prose goes
        // through `sanitizeProviderNote` (control chars only — never
        // truncated) before it reaches model context.
        const additionalCostMessage = sanitizeProviderNote(buildResp.data.additionalCostMessage);
        const successData = {
          summary,
          chain: slug, chainId,
          txHash: outcome.txHash,
          tokenIn: tokenIn.symbol,
          tokenOut: tokenOut.symbol,
          amountIn: amountInHuman,
          amountOut: amountOutHuman,
          ...(buildResp.data.additionalCostUsd
            ? { additionalCostUsd: buildResp.data.additionalCostUsd }
            : {}),
          ...(additionalCostMessage ? { additionalCostMessage } : {}),
          // C33: a failed confirm-write means Vex's own record of the
          // (real, on-chain) settlement did not persist — never claim
          // ordinary "confirmed".
          status: confirmWriteFailed ? "confirmed_unrecorded" : "confirmed",
          _executionId: executionId,
          _explorerRefs: [{ chain: slug, txRef: outcome.txHash }],
        };
        return { success: true, output: JSON.stringify(successData), data: successData };
      }

      // Unreachable — `plans` always has at least the swap entry, and the loop
      // above returns on every branch. Kept for exhaustiveness/type-safety.
      throw new Error("kyberswap.swap.execute: staged broadcast loop exited without a result");
    } catch (err) {
      // C18: the intent already exists — never call failPreBroadcast (that
      // would create a SECOND execution). Abort every planned row from the
      // CURRENT index onward (it never got a hash persisted either, whether
      // this is a CAS-miss throw or any other unexpected failure) and return
      // with the SAME `_executionId`.
      const safeMessage = kyberFailureMessage(toolId, err);
      await abortRemainingPlans(executionId, currentIndex, safeMessage);
      logger.warn("kyberswap.swap.execute.post_intent_failure", { executionId, index: currentIndex, error: safeMessage });
      // A leg refused because its estimate never succeeded after an allowance
      // this same execute confirmed is NOT the same event as an internal
      // interruption of unknown scope: nothing was signed for it, the planned
      // rows are finalized "not attempted", and re-running is safe. Saying
      // otherwise is what made a transient RPC lag permanent for an agent
      // (live 2026-07-24/25 — `dependent-leg-gas-estimate.ts`).
      if (err instanceof DependentLegGasEstimateError) {
        const refusedRole = plans[currentIndex]?.eventRole ?? "swap";
        return {
          success: false,
          output: `${toolId}: the ${refusedRole} step could not be gas-estimated, so it was refused before signing. ${dependentLegEstimateGuidance(err)} Recorded as execution ${executionId}; the node reported: ${safeMessage}`,
          data: { _executionId: executionId, status: "not_attempted", retryable: true },
        };
      }
      return {
        success: false,
        output: `${toolId}: an internal error interrupted the swap after it was already recorded — ${safeMessage}. Check the record (execution ${executionId}) before taking any further action.`,
        data: { _executionId: executionId, status: "pending" },
      };
    }
  },
};

function legInput(token: ResolvedKyberTokenMetadata): AgentActivityLegInput {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
  };
}
