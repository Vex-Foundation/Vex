/**
 * Uniswap swap handlers — quote (read) + the unified `execute` (staged
 * multi-broadcast, plan §4.2/§11.1/§11.2).
 *
 * Keyless on-chain quoting (QuoterV2 + V2 getAmountsOut, best route) and
 * broadcast (V2 Router02 / V3 SwapRouter02) via the uniswap substrate under
 * `@tools/uniswap`. The quote embeds a structural SAFETY block (factory
 * allowlist + DexScreener min-liquidity + FoT signal) that the prequote
 * extractor re-validates into the pass/fail/unknown doctrine.
 *
 * Tokens are ADDRESS-ONLY (or native ETH) — Uniswap has no symbol search, so a
 * bare symbol is rejected (resolve it with a discovery tool first). This mirrors
 * kyberswap's strict resolution and keeps the quote symmetric with the execute
 * (so the prequote match-hash collides).
 *
 * `uniswap.swap.execute` follows the durable staged-broadcast contract
 * (`db/repos/agent-activity.ts`): metadata reads → `createAgentActivityIntent`
 * (one `agent_activity` event PER PLANNED BROADCAST — `allowance_reset`/
 * `allowance` only when the current allowance is short, `swap` always) BEFORE
 * anything is signed → per-broadcast sign → `markActivityBroadcast` → send →
 * `markBroadcastAccepted` → confirm/fail from the receipt. A mined revert
 * (definitively known) fails the row and every not-yet-attempted downstream
 * event; an AMBIGUOUS confirmation (receipt lookup itself failed) stops the
 * whole sequence WITHOUT failing anything further — ambiguity never
 * terminalizes (plan §11.1). A settlement decoder is registered so the repair
 * sweep can confirm a `pending` row later using the SAME Transfer-delta logic.
 */

import { parseUnits, formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";

import { resolveUniswapDeployment } from "@tools/uniswap/chains.js";
import { getUniswapPublicClient, getUniswapEvmClients } from "@tools/uniswap/evm-client.js";
import { readUniswapErc20Metadata, validateUniswapSpender, readUniswapAllowance } from "@tools/uniswap/erc20.js";
import { quoteBestRoute, applySlippage } from "@tools/uniswap/quote.js";
import {
  buildSwapTx,
  buildApproveTx,
  signUniswapTransaction,
  broadcastUniswapTransaction,
  NATIVE_TOKEN_ADDRESS,
  type BuiltSwapTx,
  type SignedUniswapTransaction,
} from "@tools/uniswap/execute.js";
import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { checkRouteFactories, probeFotSignal, UNISWAP_MIN_LIQUIDITY_USD } from "@tools/uniswap/safety.js";
import {
  decodeUniswapExecutedLegs,
  type UniswapDecodableReceipt,
} from "@tools/uniswap/receipt-decoder.js";
import {
  classifyUniswapRevertError,
  classifyPreBroadcastFailure,
  type UniswapRevertFailureCode,
} from "@tools/uniswap/revert-mapping.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken, UniswapRoute } from "@tools/uniswap/types.js";
import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import { waitForSuccessfulReceipt } from "@tools/evm-chains/receipt-guard.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  abortPlannedEvents,
  type CreatePendingActivityEventInput,
  type AgentActivityEvent,
  type AgentActivityFailureCode,
} from "@vex-agent/db/repos/agent-activity.js";
import { registerSettlementDecoder, type SettlementDecoderInput, type DecodedSettlement } from "@vex-agent/sync/settlement-decoders.js";
import { clearUniswapPairReveal } from "@vex-agent/tools/registry/uniswap-reveal.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import {
  MINED_REVERT_SWAP_LEG_REASON,
  minedRevertApprovalLegReason,
} from "@vex-agent/tools/protocols/runtime/mined-revert-reason.js";
import { checkSlippageBps, effectiveMaxSlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";
import {
  classifyDependentLegPoolStateRevert,
  dependentLegPoolStateRefusalGuidance,
  preSignRefusalGuidance,
} from "@tools/evm-chains/pre-sign-revert-refusal.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

const DEFAULT_SLIPPAGE_BPS = 50;
const DEFAULT_DEADLINE_SECONDS = 600; // ~10 min

/** Native symbol per chain (display only — the routed address is always WETH). */
const NATIVE_SYMBOL: Record<number, string> = { 137: "POL", 56: "BNB" };

function nativeSymbolFor(chainId: number): string {
  return NATIVE_SYMBOL[chainId] ?? "ETH";
}

function isNativeInput(input: string): boolean {
  const lower = input.toLowerCase();
  return lower === "native" || lower === "eth" || lower === NATIVE_TOKEN_ADDRESS.toLowerCase();
}

/**
 * Resolve a token leg. Native ("eth"/"native"/sentinel) routes as WETH; a hex
 * address reads metadata on-chain; a bare symbol is rejected (address-only).
 */
async function resolveUniswapToken(
  deployment: UniswapDeployment,
  input: string,
): Promise<UniswapToken> {
  if (isNativeInput(input)) {
    return { address: getAddress(deployment.weth), symbol: nativeSymbolFor(deployment.chainId), decimals: 18, isNative: true };
  }
  if (!isAddress(input)) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Token "${input}" is not a valid address. Uniswap has no symbol search — pass the exact contract address (resolve it with a discovery tool first) or native ETH.`,
    );
  }
  const client = getUniswapPublicClient(deployment);
  const meta = await readUniswapErc20Metadata(client, getAddress(input));
  return { address: meta.address, symbol: meta.symbol, decimals: meta.decimals, isNative: false };
}

/** Resolve the chain param to a deployment, or throw a clean error. */
function requireDeployment(chain: string): UniswapDeployment {
  const deployment = resolveUniswapDeployment(chain);
  if (!deployment) {
    throw new VexError(
      ErrorCodes.KYBER_UNSUPPORTED_CHAIN,
      `Uniswap has no verified deployment for chain "${chain}".`,
      "Uniswap is a hidden fallback venue, available after an eligible KyberSwap route-not-found failure, or the Kyber swap transaction reverting on-chain.",
    );
  }
  return deployment;
}

// ── Safety block (embedded in the quote result; re-validated by the extractor) ──

type UniswapSafetyBlock = {
  factory: { checked: true; allowlisted: boolean } | { checkFailed: true };
  liquidity:
    | { checked: true; usd: number | null; aboveThreshold: boolean }
    | { checkFailed: true; reason: string };
  fot: { suspected: boolean };
};

async function checkOutputLiquidity(
  deployment: UniswapDeployment,
  tokenOut: UniswapToken,
): Promise<UniswapSafetyBlock["liquidity"]> {
  // Native output → WETH: liquidity is not a scam signal for the native wrapper.
  if (tokenOut.isNative) return { checked: true, usd: null, aboveThreshold: true };
  try {
    const pairs = await getDexScreenerClient().getTokens(deployment.key, tokenOut.address);
    let bestUsd: number | null = null;
    for (const pair of pairs) {
      if (pair.baseToken?.address?.toLowerCase() !== tokenOut.address.toLowerCase()) continue;
      const usd = pair.liquidity?.usd ?? null;
      if (usd !== null && (bestUsd === null || usd > bestUsd)) bestUsd = usd;
    }
    return { checked: true, usd: bestUsd, aboveThreshold: bestUsd !== null && bestUsd >= UNISWAP_MIN_LIQUIDITY_USD };
  } catch {
    return { checkFailed: true, reason: "unavailable" };
  }
}

interface QuotedRoute {
  route: UniswapRoute;
  amountOut: bigint;
  minAmountOut: bigint;
  priceImpact?: number;
  slippageBps: number;
}

async function computeQuote(
  deployment: UniswapDeployment,
  tokenIn: UniswapToken,
  tokenOut: UniswapToken,
  amountIn: bigint,
  slippageBps: number,
): Promise<QuotedRoute> {
  const client = getUniswapPublicClient(deployment);
  const best = await quoteBestRoute(client, { deployment, tokenIn, tokenOut, amountIn });
  if (!best) {
    throw new VexError(
      ErrorCodes.KYBER_ROUTE_NOT_FOUND,
      `No Uniswap route found for ${tokenIn.symbol} → ${tokenOut.symbol} on ${deployment.name}.`,
      "The pair may have no liquidity on this chain.",
    );
  }
  return {
    route: best.route,
    amountOut: best.route.amountOut,
    minAmountOut: applySlippage(best.route.amountOut, slippageBps),
    ...(best.priceImpact !== undefined ? { priceImpact: best.priceImpact } : {}),
    slippageBps,
  };
}

/**
 * Resolve the slippage this call applies, or Vex's rejection reason.
 *
 * The manifest `unit: "bps"` gate (`runtime/bps-param.ts`) proves the value is a
 * whole, non-negative number of basis points but deliberately applies no
 * maximum; the maximum is product policy with one owner
 * (`slippage-policy.ts`). No `venueMaxBps` is passed — Uniswap publishes no
 * venue maximum below Vex's ceiling (`applySlippage` is pure arithmetic over
 * `[0, 10000]`), so the ceiling binds on its own.
 *
 * REJECTED, never clamped. `applySlippage` used to fold an out-of-range value
 * to 10,000 bps, which silently authorised a total-loss tolerance instead of
 * surfacing the caller's mistake — the same failure class as silently dropping
 * a caller-supplied fee parameter. Resolved identically for the quote and the
 * execute so the pair cannot disagree about what was authorised.
 */
function resolveUniswapSlippageBps(
  handlerToolId: string,
  p: Record<string, unknown>,
): { readonly ok: true; readonly bps: number } | { readonly ok: false; readonly reason: string } {
  const bps = num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;
  const violation = checkSlippageBps(`Parameter "slippageBps" for ${handlerToolId}`, bps);
  return violation ? { ok: false, reason: violation } : { ok: true, bps };
}

function routerFor(deployment: UniswapDeployment, route: UniswapRoute): Address {
  const router = route.version === "v2" ? deployment.v2?.router02 : deployment.v3?.swapRouter02;
  if (!router) throw new VexError(ErrorCodes.SWAP_FAILED, `No ${route.version} router on ${deployment.name}.`);
  return getAddress(router);
}

// ── Quote handler (read-only) ────────────────────────────────────────────────

async function uniswapSwapQuote(p: Record<string, unknown>): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return { success: false, output: "Missing required: chain, tokenIn, tokenOut, amountIn" };

  // Pure param policy first — cheapest check, and it must not depend on a chain
  // or a network round trip to tell the caller their tolerance is out of range.
  const slippage = resolveUniswapSlippageBps("uniswap.swap.quote", p);
  if (!slippage.ok) return { success: false, output: slippage.reason };
  const slippageBps = slippage.bps;

  const deployment = requireDeployment(chain);
  const tokenIn = await resolveUniswapToken(deployment, tokenInRaw);
  const tokenOut = await resolveUniswapToken(deployment, tokenOutRaw);
  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase() && tokenIn.isNative === tokenOut.isNative) {
    return { success: false, output: "tokenIn and tokenOut resolve to the same token." };
  }
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals);

  const quoted = await computeQuote(deployment, tokenIn, tokenOut, amountIn, slippageBps);

  // Safety signals (LOCKED #5): factory allowlist + min-liquidity + FoT — never gate here.
  const client = getUniswapPublicClient(deployment);
  const [factory, liquidity, fotSuspected] = await Promise.all([
    checkRouteFactories(client, deployment, quoted.route),
    checkOutputLiquidity(deployment, tokenOut),
    tokenOut.isNative ? Promise.resolve(false) : probeFotSignal(client, deployment, tokenOut.address),
  ]);
  const safety: UniswapSafetyBlock = { factory, liquidity, fot: { suspected: fotSuspected } };

  return ok({
    chain: deployment.key,
    chainId: deployment.chainId,
    tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals, isNative: tokenIn.isNative },
    tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals, isNative: tokenOut.isNative },
    route: { version: quoted.route.version, path: quoted.route.path, fees: quoted.route.fees ?? null },
    amountIn: amountInRaw,
    amountInRaw: amountIn.toString(),
    amountOut: formatUnits(quoted.amountOut, tokenOut.decimals),
    amountOutRaw: quoted.amountOut.toString(),
    minAmountOut: formatUnits(quoted.minAmountOut, tokenOut.decimals),
    minAmountOutRaw: quoted.minAmountOut.toString(),
    slippageBps,
    priceImpact: quoted.priceImpact ?? null,
    gasEstimate: quoted.route.gasEstimate?.toString() ?? null,
    router: routerFor(deployment, quoted.route),
    spender: tokenIn.isNative ? null : routerFor(deployment, quoted.route),
    safety,
  });
}

// ── Execute (staged multi-broadcast) ─────────────────────────────────────────

const toolId = "uniswap.swap.execute";

type PlannedEvent = Omit<CreatePendingActivityEventInput, "protocolExecutionId">;

/** A revert-mapping-shaped classification, widened to the full closed enum for repo assignment. */
interface Classification {
  readonly failureCode: AgentActivityFailureCode;
  readonly failureReason: string;
}

/**
 * A refusal that never reached the network. Its code is narrowed to the shared
 * router-revert subset (`classifyUniswapRevertError`'s own return type), which
 * is what makes it a TYPE error — not a review question — to route a
 * broadcast-only code such as `mined_revert` into the "nothing was signed"
 * message.
 */
interface PreBroadcastClassification extends Classification {
  readonly failureCode: UniswapRevertFailureCode;
}

/**
 * Every caught error's text that reaches a ToolResult `output` string or a
 * log MUST go through this function, never `err.message` directly (C37,
 * Codex final-review round 3 finding 1 — supersedes FIX3's local HTML-strip
 * supplement). `summarizeProtocolError` (`runtime/errors.ts`) is the SOLE,
 * CENTRALIZED scrub boundary across every venue now — Bearer-before-header
 * ordering, HTML-document removal, and balanced/nested body removal all live
 * there (W-SPINE, same C37 contract) — so this handler is a thin delegate and
 * adds NOTHING of its own on top: a venue-local compensating wrapper was
 * exactly the shape of the problem Codex flagged, not a fix for it.
 */
function uniswapFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

function legFor(token: UniswapToken): NonNullable<PlannedEvent["tokenIn"]> {
  return token.isNative
    ? { tokenSymbol: token.symbol, tokenDecimals: token.decimals }
    : { tokenAddress: token.address, tokenSymbol: token.symbol, tokenDecimals: token.decimals };
}

/** A route/validation failure before anything could be signed — hashless `definitively_failed` row. NEVER called once the intent already exists (C18) — see `abortRemainingPlans` for that path. */
async function failPreBroadcast(
  p: Record<string, unknown>,
  event: {
    chainId: number;
    chainSlug: string;
    walletAddress: string;
    sessionId: string;
    tokenIn?: UniswapToken;
    tokenOut?: UniswapToken;
  },
  err: unknown,
): Promise<ToolResult> {
  const failureCode = classifyPreBroadcastFailure(err).failureCode;
  const failureReason = uniswapFailureMessage(err);
  const { executionId } = await createAgentActivityPreBroadcastFailure({
    toolId,
    namespace: "uniswap",
    intentParams: p,
    event: {
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: "uniswap",
      chainId: event.chainId,
      chainSlug: event.chainSlug,
      walletAddress: event.walletAddress,
      sessionId: event.sessionId,
      ...(event.tokenIn ? { tokenIn: legFor(event.tokenIn) } : {}),
      ...(event.tokenOut ? { tokenOut: legFor(event.tokenOut) } : {}),
      failureCode,
      failureReason,
    },
  });
  return { success: false, output: `${toolId} failed: ${failureReason}.`, data: { _executionId: executionId } };
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
 */
async function abortRemainingPlans(executionId: number, fromIndex: number, reason: string): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("uniswap.swap.execute.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: uniswapFailureMessage(err),
    });
  }
}

/**
 * One stage of the staged broadcast: sign → persist hash → broadcast → mark
 * accepted → wait for the receipt. `settledAtBlock` on a confirmed stage is
 * the receipt block the caller threads into the NEXT stage as its
 * read-after-write anchor (`dependent-leg-gas-estimate.ts`).
 */
type StageOutcome =
  | { readonly kind: "confirmed"; readonly receipt: UniswapDecodableReceipt; readonly txHash: Hex; readonly settledAtBlock: bigint }
  // `stage` is load-bearing, not bookkeeping: BOTH a sign-time refusal
  // (nothing ever reached the network) and a MINED revert (bytes broadcast,
  // gas burned) arrive as `failed`, and they must never be described to the
  // agent in the same words. Discriminated here rather than inferred from
  // `failureCode` so a future code cannot silently join the wrong half.
  | { readonly kind: "failed"; readonly stage: "pre_broadcast"; readonly classification: PreBroadcastClassification }
  | { readonly kind: "failed"; readonly stage: "mined_revert"; readonly classification: Classification }
  | { readonly kind: "ambiguous"; readonly txHash: Hex };

async function runStagedBroadcast(
  event: AgentActivityEvent,
  tx: BuiltSwapTx,
  clients: ReturnType<typeof getUniswapEvmClients>,
  what: string,
  priorLeg: ConfirmedPriorLeg | undefined,
): Promise<StageOutcome> {
  let signed: SignedUniswapTransaction;
  try {
    signed = await signUniswapTransaction(clients.publicClient, clients.walletClient, tx, priorLeg);
  } catch (err) {
    // A leg whose estimate never succeeded after an approval THIS execute
    // confirmed is not a classifiable revert — the whole point of
    // `DependentLegGasEstimateError` is that we could not obtain an answer we
    // trust. Classifying it (the allowance revert string maps straight to
    // `allowance_or_balance`) would assert exactly the conclusion we cannot
    // support, so it goes to the outer C18 handler, which finalizes the
    // never-signed rows as "not attempted" and says so honestly.
    if (err instanceof DependentLegGasEstimateError) throw err;
    // Sign-time only (prepare/estimate/local signing) — no `sendRawTransaction`
    // call has happened yet, so nothing was ever submitted to the network.
    // Unlike a broadcast failure (C15), a sign-time failure is UNAMBIGUOUSLY
    // pre-wire — safe to definitively fail.
    const raw = classifyUniswapRevertError(err);
    // C37 (Codex final-review round 3, finding 1): `raw.failureReason` can be
    // a DECODED on-chain revert string (`extractDecodedRevertReason`) —
    // content a malformed/non-standard contract or a compromised RPC
    // controls, never text Vex authored. It must cross the SAME scrub
    // boundary as any other provider-controlled text before it reaches the
    // DB row (`failActivityEvent`, below) or the ToolResult output (the
    // "failed" branch in the main loop reads this same object's
    // `failureReason`).
    const classification: PreBroadcastClassification = { failureCode: raw.failureCode, failureReason: uniswapFailureMessage(raw.failureReason) };
    await failActivityEvent(event.id, classification);
    return { kind: "failed", stage: "pre_broadcast", classification };
  }

  // C14 (Codex final-review round 1, finding 1): a CAS miss here means the
  // hash could not be durably staged — THROW so this function NEVER reaches
  // the broadcast call with an untracked signed payload. The caller's outer
  // catch (C18) finalizes what it can and reports failure without creating a
  // second execution.
  const staged = await markActivityBroadcast(event.id, {
    txHash: signed.txHash,
    fromAddress: signed.fromAddress,
    nonce: signed.nonce,
  });
  if (!staged.applied) {
    throw new Error(
      `agent_activity: markActivityBroadcast CAS miss for event ${event.id} — refusing to broadcast an untracked transaction`,
    );
  }

  let broadcastHash: Hex;
  try {
    broadcastHash = await broadcastUniswapTransaction(clients.publicClient, signed.serializedTransaction);
  } catch {
    // C29 (Codex final-review round 2, finding 1 — supersedes FIX2's C15
    // implementation): NOTHING `sendRawTransaction` throws here is provably
    // pre-wire. viem mints its RPC-error classes (e.g.
    // `InvalidParamsRpcError`/`InvalidInputRpcError`) from the NODE's own
    // JSON-RPC response, meaning the request already reached the server —
    // `-32000` in particular can mean "already known" (the transaction may
    // already be in the mempool from THIS call). There is no independently
    // branded local error in this flow (a single network round-trip with no
    // local pre-validation ahead of it), so every rejection here is
    // unconditionally ambiguous — the row stays `pending` forever for the
    // repair sweep, never definitively failed. See
    // `@tools/uniswap/revert-mapping.js`'s file-header comment for the full
    // viem `buildRequest.ts` evidence trail.
    return { kind: "ambiguous", txHash: signed.txHash };
  }

  // C39 (Codex final-review round 3, finding 3): `signed.txHash` is derived
  // LOCALLY (`keccak256` of the exact signed bytes we submitted) — it is
  // authoritative end-to-end. `broadcastHash` is only what the NODE echoed
  // back; a faulty/misconfigured/malicious RPC could echo a different hash
  // and, if trusted, would redirect our receipt wait/output to an unrelated
  // transaction while the ALREADY-PERSISTED `agent_activity` row (staged
  // above with `signed.txHash`) silently disagrees. Never swap to the RPC's
  // value — log a mismatch and keep going with the locally-derived hash.
  if (broadcastHash.toLowerCase() !== signed.txHash.toLowerCase()) {
    logger.warn("uniswap.swap.execute.broadcast_hash_mismatch", {
      id: event.id,
      signedTxHash: signed.txHash,
      rpcEchoedHash: broadcastHash,
    });
  }

  // C16 (Codex final-review round 1, finding 2): best-effort bookkeeping — a
  // throw here must NOT be read as a broadcast failure (the transaction IS
  // already in flight), so we keep going to the receipt wait regardless.
  try {
    await markBroadcastAccepted(event.id);
  } catch (err) {
    logger.warn("uniswap.swap.execute.mark_accepted_failed", {
      id: event.id,
      error: uniswapFailureMessage(err),
    });
  }

  try {
    const receipt = await waitForSuccessfulReceipt(clients.publicClient, signed.txHash, {
      code: ErrorCodes.SWAP_FAILED,
      what,
      hint: "Check the transaction hash before retrying — do not resubmit automatically.",
    });
    // `TransactionReceipt.logs` is structurally compatible with
    // `UniswapDecodableReceipt.logs` (`Address`/`Hex` are `string` subtypes) —
    // no cast needed.
    return { kind: "confirmed", receipt, txHash: signed.txHash, settledAtBlock: receipt.blockNumber };
  } catch (err) {
    if (err instanceof VexError && err.code === ErrorCodes.SWAP_FAILED) {
      // A DEFINITIVE mined revert (waitForSuccessfulReceipt's status!=='success' branch).
      // Per-role: this reason is persisted AND read back verbatim in the
      // "failed" branch's output, so it must carry the remedy that is true for
      // THIS leg — the swap's price guard does not exist on an approve.
      // Owner: `runtime/mined-revert-reason.ts`.
      const classification: Classification = {
        failureCode: "mined_revert",
        failureReason: event.eventRole === "swap"
          ? MINED_REVERT_SWAP_LEG_REASON
          : minedRevertApprovalLegReason(event.eventRole),
      };
      await failActivityEvent(event.id, classification);
      return { kind: "failed", stage: "mined_revert", classification };
    }
    // CONFIRMATION_UNKNOWN (or anything unexpected) — the receipt lookup itself
    // failed. Ambiguous NEVER terminalizes: leave the row pending for the
    // repair sweep, which retries the SAME lookup later.
    return { kind: "ambiguous", txHash: signed.txHash };
  }
}

interface TxBuildContext {
  readonly deployment: UniswapDeployment;
  readonly router: Address;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  readonly amountIn: bigint;
  readonly quoted: QuotedRoute;
  readonly recipient: Address;
}

function buildTxForEvent(event: AgentActivityEvent, ctx: TxBuildContext): BuiltSwapTx {
  if (event.eventRole === "allowance_reset") return buildApproveTx(ctx.tokenIn.address, ctx.router, 0n);
  if (event.eventRole === "allowance") return buildApproveTx(ctx.tokenIn.address, ctx.router, ctx.amountIn);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS);
  return buildSwapTx({
    deployment: ctx.deployment,
    route: ctx.quoted.route,
    amountIn: ctx.amountIn,
    minAmountOut: ctx.quoted.minAmountOut,
    recipient: ctx.recipient,
    deadline,
    tokenInIsNative: ctx.tokenIn.isNative,
    tokenOutIsNative: ctx.tokenOut.isNative,
  });
}

function describeEventRole(role: AgentActivityEvent["eventRole"]): string {
  if (role === "allowance_reset") return "Allowance-reset transaction";
  if (role === "allowance") return "Approval transaction";
  return "Swap transaction";
}

async function executeUniswapSwap(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  // C24 (Codex final-review round 1, finding 8): the manifest declares no
  // `dryRun` param (five-field contract is final) — a caller that still
  // passes it must NEVER reach a real broadcast just because the runtime's
  // spine-inherited `previewSupport:true` matrix row treated the call as a
  // preview (`RESERVED_RUNTIME_PARAM_KEYS` always accepts `dryRun` regardless
  // of manifest declaration, so the boundary check alone is not sufficient).
  if (p.dryRun === true) {
    return fail(`${toolId} does not support dryRun preview — call uniswap.swap.quote instead.`);
  }

  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  // Vex's slippage ceiling — pure, and BEFORE the session/chain/wallet steps so
  // an out-of-range tolerance never reaches a durable row or a signing key.
  const slippage = resolveUniswapSlippageBps(toolId, p);
  if (!slippage.ok) return fail(slippage.reason);
  const slippageBps = slippage.bps;

  // The reveal gate + prequote gate (executeProtocolTool) already block this
  // tool without a session — sessionId is guaranteed present here.
  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${toolId} requires an active session.`);

  // Step 1 — resolve the chain. No wallet/chain known yet on failure, so no
  // durable row is written (same treatment as a param-validation failure).
  const deployment = requireDeployment(chain);

  // Step 2 (C22-equivalent for Uniswap) — address-only wallet resolution
  // (NEVER decrypts) so a failure from here on CAN be durably recorded with
  // a real walletAddress. The signing key itself is resolved later.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let tokenIn: UniswapToken;
  let tokenOut: UniswapToken;
  let amountIn: bigint;
  let quoted: QuotedRoute;
  try {
    tokenIn = await resolveUniswapToken(deployment, tokenInRaw);
    tokenOut = await resolveUniswapToken(deployment, tokenOutRaw);
    amountIn = parseUnits(amountInRaw, tokenIn.decimals);
    quoted = await computeQuote(deployment, tokenIn, tokenOut, amountIn, slippageBps);
  } catch (err) {
    return failPreBroadcast(p, { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress, sessionId }, err);
  }

  // Per-session signing wallet — resolved only now that dryRun is rejected
  // and the quote succeeded, so a rejected/failed call never decrypts a key.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const clients = getUniswapEvmClients(deployment, signer.privateKey as Hex);
  const router = routerFor(deployment, quoted.route);

  let currentAllowance = 0n;
  try {
    if (!tokenIn.isNative) {
      await ensureErc20Balance(clients.publicClient, {
        token: tokenIn.address,
        owner: getAddress(signer.address),
        required: amountIn,
        decimals: tokenIn.decimals,
        label: tokenIn.symbol,
      });
      validateUniswapSpender(router);
      currentAllowance = await readUniswapAllowance(clients.publicClient, tokenIn.address, getAddress(signer.address), router);
    }
  } catch (err) {
    return failPreBroadcast(
      p,
      { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress: signer.address, sessionId, tokenIn, tokenOut },
      err,
    );
  }

  // Events plan (plan §11.1 — one row per planned broadcast, created BEFORE
  // anything is signed): allowance_reset/allowance only when the current
  // allowance is short (USDT-style reset-before-non-zero-approve), swap always.
  const needsAllowance = !tokenIn.isNative && currentAllowance < amountIn;
  const needsReset = needsAllowance && currentAllowance > 0n;
  const events: PlannedEvent[] = [];
  let eventIndex = 0;
  if (needsReset) {
    events.push({
      eventIndex: eventIndex++, eventRole: "allowance_reset", kind: "swap", protocol: "uniswap",
      chainId: deployment.chainId, chainSlug: deployment.key, walletAddress: signer.address, sessionId,
      tokenIn: legFor(tokenIn),
    });
  }
  if (needsAllowance) {
    events.push({
      eventIndex: eventIndex++, eventRole: "allowance", kind: "swap", protocol: "uniswap",
      chainId: deployment.chainId, chainSlug: deployment.key, walletAddress: signer.address, sessionId,
      tokenIn: { ...legFor(tokenIn), amountHuman: formatUnits(amountIn, tokenIn.decimals), amountRaw: amountIn.toString() },
    });
  }
  events.push({
    eventIndex, eventRole: "swap", kind: "swap", protocol: "uniswap",
    chainId: deployment.chainId, chainSlug: deployment.key, walletAddress: signer.address, sessionId,
    tokenIn: { ...legFor(tokenIn), amountHuman: amountInRaw, amountRaw: amountIn.toString() },
    tokenOut: { ...legFor(tokenOut), amountHuman: formatUnits(quoted.amountOut, tokenOut.decimals), amountRaw: quoted.amountOut.toString() },
    routeProvenance: { version: quoted.route.version, path: quoted.route.path, fees: quoted.route.fees ?? null },
  });

  const { executionId, events: createdEvents } = await createAgentActivityIntent({
    toolId, namespace: "uniswap", intentParams: p, events,
  });

  // C18 (Codex final-review round 1, finding 3): once the intent exists, ANY
  // unexpected failure below (including C14's CAS-miss throw) must finalize
  // what it can and return the SAME `_executionId` — NEVER call
  // `failPreBroadcast`/create a second `protocol_executions` row.
  // Read-after-write anchor for the NEXT event: an allowance this loop just
  // confirmed is state the swap leg's pre-sign estimate depends on, and the
  // estimating node does not always have it yet (`dependent-leg-gas-estimate.ts`).
  let priorLeg: ConfirmedPriorLeg | undefined;
  let refusedRole: AgentActivityEvent["eventRole"] = "swap";
  try {
    for (let i = 0; i < createdEvents.length; i++) {
      const event = createdEvents[i]!;
      refusedRole = event.eventRole;
      const tx = buildTxForEvent(event, { deployment, router, tokenIn, tokenOut, amountIn, quoted, recipient: getAddress(signer.address) });
      const outcome = await runStagedBroadcast(event, tx, clients, describeEventRole(event.eventRole), priorLeg);

      if (outcome.kind === "ambiguous") {
        // C17: the events STRICTLY AFTER this one were NEVER signed — finalize
        // them (this event itself stays pending; ambiguity never terminalizes).
        const next = createdEvents[i + 1];
        if (next) {
          await abortRemainingPlans(executionId, next.eventIndex, `earlier ${event.eventRole} ambiguous`);
        }
        logger.info("uniswap.swap.execute.ambiguous", { id: event.id, txHash: outcome.txHash });
        return {
          success: false,
          output: `${toolId}: broadcast of the ${event.eventRole} transaction (${outcome.txHash}) could not be confirmed yet — it may still settle on-chain. Do not retry; this attempt is recorded as pending and will resolve automatically.`,
          data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
        };
      }

      if (outcome.kind === "failed") {
        const next = createdEvents[i + 1];
        if (next) {
          await abortRemainingPlans(
            executionId, next.eventIndex,
            `earlier ${event.eventRole} reverted (${outcome.classification.failureCode})`,
          );
        }
        // A sign-time refusal never reached the network — no bytes, no gas, no
        // possible duplicate. Calling it a transaction that "failed" made the
        // agent read a routine, recoverable slippage refusal as a lost trade,
        // with no remedy named (`evm-chains/pre-sign-revert-refusal.ts` carries
        // the incident). The MINED revert below keeps its own wording.
        if (outcome.stage === "pre_broadcast") {
          return {
            success: false,
            output: `${toolId}: the ${event.eventRole} step was refused before signing. ${preSignRefusalGuidance({
              // Already through this venue's single scrub boundary (C37).
              revertReason: outcome.classification.failureReason,
              failureCode: outcome.classification.failureCode,
              slippage: { appliedBps: slippageBps, maxBps: effectiveMaxSlippageBps() },
            })} Recorded as execution ${executionId}.`,
            data: {
              _executionId: executionId, status: "not_attempted", retryable: true,
              failureCode: outcome.classification.failureCode,
            },
          };
        }
        // Only `stage: "mined_revert"` reaches here (the pre-sign stage returned
        // above), so the reason is one of `mined-revert-reason.ts`'s
        // self-terminating sentences — no sentence period is added after it.
        return {
          success: false,
          output: `${toolId}: the ${event.eventRole} transaction failed (${outcome.classification.failureCode}): ${outcome.classification.failureReason} No further steps were attempted.`,
          data: { _executionId: executionId, status: "failed" },
        };
      }

      // confirmed on-chain
      priorLeg = priorLegAnchorFrom(outcome.settledAtBlock);
      if (event.eventRole !== "swap") {
        try {
          await confirmActivityEvent(event.id, {});
        } catch (err) {
          // C16: bookkeeping-only — never propagated (the approval already succeeded).
          logger.warn("uniswap.swap.execute.confirm_failed", {
            id: event.id, role: event.eventRole,
            error: uniswapFailureMessage(err),
          });
        }
        continue;
      }

      // Cleared ONLY on a successful broadcast — never on a quote, never on a
      // failed execute (plan §11.2). The swap DID confirm on-chain at this
      // point regardless of whether we can decode its executed amounts below.
      clearUniswapPairReveal(sessionId);

      // Auto-pin (fail-soft) — Codex final-review round 4, finding 3: runs
      // IMMEDIATELY after on-chain confirmation, BEFORE decoding, so a
      // confirmed-but-undecodable settlement can never skip it. The spent
      // token-in is never pinned. Never allowed to fail the swap result.
      if (getLocalChain(deployment.chainId) && !tokenOut.isNative) {
        try {
          await pinTrackedToken({
            walletAddress: signer.address, chainId: deployment.chainId,
            tokenAddress: tokenOut.address, source: "swap",
          });
        } catch (err) {
          logger.warn("uniswap.swap.execute.auto_pin_failed", {
            chain: deployment.key, error: err instanceof Error ? err.name : "unknown",
          });
        }
      }

      // C38 (Codex final-review round 3, finding 2): the swap ALREADY
      // confirmed on-chain at this point — a throw from the decoder itself
      // must NEVER escape to the generic outer post-intent catch (C18), which
      // returns a result WITHOUT `outcome.txHash` and would silently lose the
      // known hash for a swap that genuinely succeeded. Treat a throw exactly
      // like a fully-undecoded receipt (falls through to the SAME
      // `confirmed_pending_amounts` branch below, which already preserves the
      // tx hash) — mirrors Kyber's identical defensive catch around its own
      // settlement decoder.
      let decoded: ReturnType<typeof decodeUniswapExecutedLegs>;
      try {
        decoded = decodeUniswapExecutedLegs({
          receipt: outcome.receipt,
          chainId: deployment.chainId,
          walletAddress: signer.address,
          tokenInAddress: tokenIn.isNative ? null : tokenIn.address,
          tokenOutAddress: tokenOut.isNative ? null : tokenOut.address,
        });
      } catch (err) {
        logger.warn("uniswap.swap.execute.settlement_decode_threw", {
          id: event.id, txHash: outcome.txHash, error: uniswapFailureMessage(err),
        });
        decoded = {};
      }

      if (decoded.executedAmountInRaw === undefined || decoded.executedAmountOutRaw === undefined) {
        logger.warn("uniswap.swap.execute.settlement_undecodable", { id: event.id, txHash: outcome.txHash });
        return {
          success: true,
          output: `${toolId}: swap confirmed on-chain (tx ${outcome.txHash}) but the executed amounts could not be decoded yet — check the transaction hash for the exact amounts. The record will finalize automatically.`,
          data: { txHash: outcome.txHash, _executionId: executionId, status: "confirmed_pending_amounts" },
        };
      }

      // C34 (Codex final-review round 2, finding 6): the DECODED net
      // settlement amount, never the request echo (`amountInRaw`, the raw
      // requested-string param) — a fee-on-transfer token or partial fill can
      // make the executed input differ from what was requested, and the
      // success message must never contradict the persisted `agent_activity`
      // truth.
      const amountInHuman = formatUnits(decoded.executedAmountInRaw, tokenIn.decimals);
      const amountOutHuman = formatUnits(decoded.executedAmountOutRaw, tokenOut.decimals);
      // C16: the swap already confirmed on-chain — a DB write hiccup recording
      // that MUST NEVER read as the swap itself failing. `status` distinguishes
      // "confirmed" (our own record matches) from "confirmed_unrecorded"
      // (on-chain truth is settled; only our bookkeeping write failed) so a
      // caller can tell the two apart without this ever becoming a failure.
      let status: "confirmed" | "confirmed_unrecorded" = "confirmed";
      try {
        const confirmResult = await confirmActivityEvent(event.id, {
          executedAmountInHuman: amountInHuman,
          executedAmountInRaw: decoded.executedAmountInRaw.toString(),
          executedAmountOutHuman: amountOutHuman,
          executedAmountOutRaw: decoded.executedAmountOutRaw.toString(),
        });
        // C41 (Codex final-review round 3, finding 6): a CAS MISS (the row
        // was no longer `pending`) is not automatically a success just
        // because nothing threw — a conflicting terminal row (e.g. a
        // concurrent repair-sweep write) must NOT be reported as an ordinary
        // confirmed swap. The one exception is a genuine idempotent retry:
        // the row is already `confirmed` with the SAME executed amounts this
        // call just computed — real recorded confirmation, not a conflict.
        if (!confirmResult.applied) {
          const alreadyRecorded = confirmResult.row.status === "confirmed"
            && confirmResult.row.executedAmountInRaw === decoded.executedAmountInRaw.toString()
            && confirmResult.row.executedAmountOutRaw === decoded.executedAmountOutRaw.toString();
          if (!alreadyRecorded) {
            status = "confirmed_unrecorded";
            logger.warn("uniswap.swap.execute.confirm_cas_miss", {
              id: event.id, rowStatus: confirmResult.row.status,
            });
          }
        }
      } catch (err) {
        status = "confirmed_unrecorded";
        logger.warn("uniswap.swap.execute.confirm_failed", {
          id: event.id, error: uniswapFailureMessage(err),
        });
      }

      logger.info("uniswap.swap.executed", { chain: deployment.key, version: quoted.route.version });

      return {
        success: true,
        output: JSON.stringify({
          txHash: outcome.txHash, chain: deployment.key,
          tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol,
          amountIn: amountInHuman, amountOut: amountOutHuman,
          route: { version: quoted.route.version, path: quoted.route.path },
        }, null, 2),
        data: { txHash: outcome.txHash, _executionId: executionId, status },
      };
    }

    // Unreachable — `createdEvents` always has at least the swap entry, and
    // the loop above returns on every branch. Kept for exhaustiveness.
    throw new Error("uniswap.swap.execute: staged broadcast loop exited without a result");
  } catch (err) {
    // C18: the intent already exists — finalize what's left, SAME
    // `_executionId`, never a second execution (never `failPreBroadcast` here).
    await abortRemainingPlans(executionId, 0, `execute aborted: ${uniswapFailureMessage(err)}`);
    logger.warn("uniswap.swap.execute.unexpected_error", {
      executionId, error: uniswapFailureMessage(err),
    });
    // A leg refused because its estimate never succeeded after an allowance
    // this same execute confirmed is not an unexpected internal failure:
    // nothing was signed for it, the never-signed rows are finalized "not
    // attempted" (the confirmed approval row is untouched — it has a hash),
    // and re-running is safe.
    if (err instanceof DependentLegGasEstimateError) {
      // ERC-20 input — the common shape, and the one the native-input fix did
      // not reach: with an approval leg in front, a genuine price-guard refusal
      // arrives ONLY here, and the RPC-lag wording named no parameter the agent
      // could change. A POOL-STATE reason that survived every retry is
      // admissible evidence (the narrowing and its two arguments live in
      // `pre-sign-revert-refusal.ts`); every other reason keeps the wording below.
      const poolState = classifyDependentLegPoolStateRevert(err);
      if (poolState) {
        return {
          success: false,
          output: `${toolId}: the ${refusedRole} step was refused before signing. ${dependentLegPoolStateRefusalGuidance({
            error: err,
            // Chain-controlled text through this venue's single scrub boundary (C37).
            revertReason: uniswapFailureMessage(poolState.revertReason),
            failureCode: poolState.failureCode,
            slippage: { appliedBps: slippageBps, maxBps: effectiveMaxSlippageBps() },
          })} Recorded as execution ${executionId}.`,
          data: {
            _executionId: executionId, status: "not_attempted", retryable: true,
            failureCode: poolState.failureCode,
          },
        };
      }
      return {
        success: false,
        output: `${toolId}: the ${refusedRole} step could not be gas-estimated, so it was refused before signing. ${dependentLegEstimateGuidance(err)} Recorded as execution ${executionId}; the node reported: ${uniswapFailureMessage(err)}`,
        data: { _executionId: executionId, status: "not_attempted", retryable: true },
      };
    }
    return {
      success: false,
      output: `${toolId} failed unexpectedly: ${uniswapFailureMessage(err)}`,
      data: { _executionId: executionId },
    };
  }
}

// ── Settlement decoder registration (repair-sweep seam, FIX-SPINE C2) ───────

function isDecodableReceipt(value: unknown): value is UniswapDecodableReceipt {
  return typeof value === "object" && value !== null && Array.isArray((value as { logs?: unknown }).logs);
}

function decodeUniswapSettlement(input: SettlementDecoderInput): DecodedSettlement | null {
  if (!isDecodableReceipt(input.receipt)) return null;
  const decoded = decodeUniswapExecutedLegs({
    receipt: input.receipt,
    chainId: input.chainId,
    walletAddress: input.walletAddress,
    tokenInAddress: input.tokenInAddress,
    tokenOutAddress: input.tokenOutAddress,
  });
  if (decoded.executedAmountInRaw === undefined || decoded.executedAmountOutRaw === undefined) return null;
  // Repair-sweep confirms have no token decimals in this input shape — raw
  // amounts are the CHECK-enforced minimum; human amounts are left unset
  // rather than guessed.
  return {
    executedAmountInRaw: decoded.executedAmountInRaw.toString(),
    executedAmountOutRaw: decoded.executedAmountOutRaw.toString(),
  };
}

registerSettlementDecoder("uniswap", decodeUniswapSettlement);

// ── Handler map ──────────────────────────────────────────────────────────────

export const UNISWAP_SWAP_HANDLERS: Record<string, ProtocolHandler> = {
  "uniswap.swap.quote": (p) => uniswapSwapQuote(p),
  "uniswap.swap.execute": (p, ctx) => executeUniswapSwap(p, ctx),
};
