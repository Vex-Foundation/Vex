/**
 * `uniswap.swap.quote` — read-only. Keyless on-chain quoting plus the embedded
 * SAFETY block the prequote extractor re-validates.
 */

import { getAddress, parseUnits, formatUnits, type Address } from "viem";

import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { checkRouteFactories, probeFotSignal } from "@tools/uniswap/safety.js";
import { readUniswapAllowance } from "@tools/uniswap/erc20.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, ok } from "../../../handler-helpers.js";
import { resolveUniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import { checkForbiddenFeeParams } from "./forbidden-params.js";
import { QUOTE_TOOL_ID } from "./protocol-id.js";
import { requireDeployment, routerFor } from "./deployment.js";
import { resolveUniswapToken } from "./token-resolution.js";
import { resolveUniswapSlippageBps } from "./slippage.js";
import { computeQuote } from "./route-quote.js";
import { checkOutputLiquidity, type UniswapSafetyBlock } from "./quote-safety.js";
import { buildUniswapQuoteSnapshot } from "./execution-binding.js";
import { canonicalWrapPairRefusal } from "../../../wrap-pair-refusal.js";
import { PREQUOTE_MAX_AGE_MS } from "../../../prequote/registry.js";
import {
  classifyMeasuredImpact,
  isExecutable,
  type QuoteEligibility,
} from "../../../quote-authority/eligibility.js";
import type { SpendabilityPreview } from "../../../quote-authority/spendability-contract.js";
import { buildBoundDebitPlan, type BoundDebitPlan } from "../../../quote-authority/debit-plan.js";
import {
  estimateUniswapPlanGas,
  planUniswapDebitLegs,
  priceUniswapNativeDebit,
  resolveUniswapLegFeeCap,
  type UniswapSpendabilityClient,
} from "./native-debit-plan.js";
import {
  judgeUniswapSpendability,
  observeUniswapSwapSpendability,
  uniswapSpendabilityNote,
} from "./quote-spendability.js";

/**
 * What this venue's impact measurement concluded. `null` is the STRUCTURAL
 * case, not a failure: `computeV2DirectPriceImpact` only prices a DIRECT V2
 * pair, so a V3 route, a multi-hop route, or a pair whose reserves could not be
 * read has no reference to size the trade against and never had one.
 */
type ImpactVerdict = QuoteEligibility | null;

/**
 * The agent-facing consequence, in the same breath as the route. The
 * unmeasured case says so OUT LOUD: a silent absence reads as "impact was
 * fine", which is exactly the reading a 15% ceiling exists to prevent.
 */
function impactNoteFor(verdict: ImpactVerdict): string {
  if (verdict === null) {
    return "Price impact was NOT measurable for this route: this venue derives impact only from a direct V2 pair's reserves,"
      + " and this route is not one. The quote is still executable; size the trade against a market read before committing to it.";
  }
  switch (verdict.kind) {
    case "executable":
      return verdict.adverse
        ? `This quote gives up ${(verdict.priceImpactFraction * 100).toFixed(2)}% of the input's reference value; it is still executable.`
        : `Measured price impact ${(verdict.priceImpactFraction * 100).toFixed(2)}%.`;
    case "excessive_impact":
      return `This route gives up ${(verdict.priceImpactFraction * 100).toFixed(2)}% of the input's reference value, at or above the ${(verdict.ceilingFraction * 100).toFixed(0)}% ceiling.`
        + " This quote does NOT authorize an execute. Trade a smaller size or use a deeper pair.";
    // The SPENDABILITY members are decided by `evaluateSpendability`, not by
    // this venue's impact measurement, so they are never described as an impact
    // outcome: each gets its own sentence from the one owner of that wording.
    // Before WP2-U they fell into the `default` arm below and were reported as
    // an unusable impact number, which is a different fact about a different
    // problem.
    case "insufficient_balance":
    case "balance_unavailable":
    case "gas_reserve_insufficient":
      return uniswapSpendabilityNote(verdict);
    default:
      return "This venue's price-impact measurement did not produce a usable number, so the size of this trade cannot be checked"
        + " against a reference price. This quote does NOT authorize an execute. Request a fresh quote.";
  }
}

/**
 * The route verdict handed to the spendability evaluator when this venue could
 * not measure impact at all.
 *
 * It states the ROUTE is fine, which is exactly what the structural
 * non-measurability means here, and nothing else: the answer's own
 * `eligibility` block is built separately and keeps `impactMeasured: false`, so
 * this stand-in fraction is never rendered and never read as a measurement.
 */
const UNMEASURED_ROUTE_EXECUTABLE = {
  kind: "executable",
  priceImpactFraction: 0,
  adverse: false,
} as const satisfies QuoteEligibility;

/** A spendability probe that threw. Unknown fails closed (contract C2.3). */
const SPENDABILITY_PROBE_FAILED = "uniswap_spendability_probe_failed";

export async function uniswapSwapQuote(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  // Rejected HERE as well as on the execute, so a quote can never appear to
  // authorize a fee override the execute would refuse.
  const forbidden = checkForbiddenFeeParams(p);
  if (forbidden) return { success: false, output: forbidden };

  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return { success: false, output: "Missing required: chain, tokenIn, tokenOut, amountIn" };

  // Pure param policy first — cheapest check, and it must not depend on a chain
  // or a network round trip to tell the caller their tolerance is out of range.
  const slippage = resolveUniswapSlippageBps(QUOTE_TOOL_ID, p);
  if (!slippage.ok) return { success: false, output: slippage.reason };
  const slippageBps = slippage.bps;

  const deployment = requireDeployment(chain);
  const tokenIn = await resolveUniswapToken(deployment, tokenInRaw);
  const tokenOut = await resolveUniswapToken(deployment, tokenOutRaw);
  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase() && tokenIn.isNative === tokenOut.isNative) {
    return { success: false, output: "tokenIn and tokenOut resolve to the same token." };
  }
  // A native leg resolves to the deployment's wrapped-native address with
  // `isNative: true`, so this pair passes the same-token check above and would
  // otherwise reach the router, which treats both legs as one asset and finds
  // no route. Refused by name, with the tool that CAN build the conversion.
  const wrapPair = canonicalWrapPairRefusal(deployment.chainId, tokenIn, tokenOut, "uniswap__swap_quote");
  if (wrapPair) return { success: false, output: wrapPair };
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals);

  // The SAME fee resolution the execute runs, in the SAME position (before the
  // quote): the route must be priced for the amount the router actually
  // receives, or the quote would advertise an output the execute cannot deliver.
  const feeCharge = await resolveUniswapFeeCharge({ chainId: deployment.chainId, tokenIn, amountInRaw: amountIn });
  const quoted = await computeQuote(deployment, tokenIn, tokenOut, feeCharge.swapAmountRaw, slippageBps);

  // Safety signals (LOCKED #5): factory allowlist + min-liquidity + FoT — never gate here.
  const client = getUniswapPublicClient(deployment);
  const [factory, liquidity, fotSuspected] = await Promise.all([
    checkRouteFactories(client, deployment, quoted.route),
    checkOutputLiquidity(deployment, tokenOut),
    tokenOut.isNative ? Promise.resolve(false) : probeFotSignal(client, deployment, tokenOut.address),
  ]);
  const safety: UniswapSafetyBlock = { factory, liquidity, fot: { suspected: fotSuspected } };

  // What this quote AUTHORIZES, sealed here and nowhere else: the router input
  // after the fee, the fee disposition as disclosed, and the floor the execute
  // must write into its calldata. It rides the private `quoteAuthority` channel
  // to the prequote recorder - never `data`, which is model-visible context.
  // WHERE THIS VENUE MEASURES IMPACT, THE SHARED CEILING APPLIES. The
  // thresholds are not restated here: `classifyMeasuredImpact` owns them for
  // both venues, so the 15% refusal the agent's task shape promises is one
  // constant, not a per-venue habit. An unmeasured route stays executable and
  // says so - honest, never silent.
  const impact: ImpactVerdict = quoted.priceImpact === undefined
    ? null
    : classifyMeasuredImpact(quoted.priceImpact);

  // SPENDABILITY, and only for a route that is otherwise executable (the order
  // `spendability.ts` states): an agent told the wallet is short before it is
  // told the route is excessive-impact would go and fund a trade that re-funding
  // cannot make safe.
  const spendability = await measureSpendability({
    routeEligibility: impact ?? UNMEASURED_ROUTE_EXECUTABLE,
    context,
    client,
    deployment,
    router: routerFor(deployment, quoted.route),
    tokenIn,
    tokenOut,
    quoted,
    charge: feeCharge,
    principalRaw: amountIn,
  });
  const eligibility = spendability.eligibility;
  const executable = isExecutable(eligibility);

  // NO PLAN, NO SNAPSHOT. A quote that could not measure the transactions it
  // would send can state a route and a price, but it cannot authorize an
  // execute: the binding the execute is held to would be missing. MetaMask does
  // the same with `batchTransactions: []` beside a kept quote
  // (`transaction-pay-controller/src/utils/quotes.ts:762-775`). The only way to
  // reach this arm with an executable verdict is a session with no selected
  // wallet, for which the recorder writes no claimable row either.
  const snapshot = spendability.debitPlan === undefined ? null : buildUniswapQuoteSnapshot({
    chainId: deployment.chainId,
    tokenIn,
    tokenOut,
    charge: feeCharge,
    quoted,
    debitPlan: spendability.debitPlan,
    // Display/audit copy of the row's own TTL. `swap_prequotes.expires_at`,
    // written by the recorder, is the AUTHORITY the claim reads; these two
    // differ by the recorder's own latency and nothing decides on this one.
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  });

  const answer = ok({
    chain: deployment.key,
    chainId: deployment.chainId,
    tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals, isNative: tokenIn.isNative },
    tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals, isNative: tokenOut.isNative },
    route: { version: quoted.route.version, path: quoted.route.path, fees: quoted.route.fees ?? null },
    // What the user is debited in total, and what the route was priced for —
    // they differ by the Vex fee, and stating only one of them is how an agent
    // ends up reporting a number the wallet never saw.
    amountIn: amountInRaw,
    amountInRaw: amountIn.toString(),
    swapAmountRaw: feeCharge.swapAmountRaw.toString(),
    swapAmount: formatUnits(feeCharge.swapAmountRaw, tokenIn.decimals),
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
    vexFee: feeCharge.disclosure,
    // The agent sees WHY, in the same object as the route. `impactMeasured`
    // distinguishes "measured and fine" from "never measured" - a bare
    // `executable: true` cannot carry that difference.
    // The agent sees the FINAL verdict - route AND wallet - in the same object
    // as the route, plus how each half was decided. `impactMeasured`
    // distinguishes "measured and fine" from "never measured"; `balanceChecked`
    // does the same for the wallet, because a quote that could not read a
    // balance must never look like one that read it and was satisfied.
    eligibility: {
      kind: eligibility.kind,
      executable,
      impactMeasured: impact !== null,
      balanceChecked: spendability.checked,
      ...(executable && impact !== null && impact.kind === "executable"
        ? { adverse: impact.adverse }
        : {}),
    },
    impactNote: impactNoteFor(impact),
    // What the WALLET half concluded, in its own sentence. Never folded into
    // `impactNote`: they answer two different questions and an agent that reads
    // one as the other funds the wrong problem.
    eligibilityNote: spendability.note,
  });

  return {
    ...answer,
    quoteAuthority: {
      // An ineligible verdict rides the SAME private channel Kyber's does, with
      // NO snapshot: the recorder writes a superseding non-`executable` row, so
      // an older priced quote for this identity stops being claimable at the
      // same instant and this one never becomes claimable at all. The identity
      // comes from the answer's own `data` through the venue extractor - the one
      // owner of what a uniswap quote's identity is.
      eligibilityKind: eligibility.kind,
      routeSnapshot: executable && snapshot !== null ? { ...snapshot } : null,
      // Quote-time facts only, and only for a quote that authorizes something:
      // the recorder validates this and persists it in the row's bounded
      // `safety_detail`, from which the approval card restores it. The card line
      // says in words that the authoritative read happens before signing.
      ...(spendability.preview === undefined ? {} : { spendability: spendability.preview }),
    },
  };
}

interface SpendabilityOutcome {
  readonly eligibility: QuoteEligibility;
  readonly preview: SpendabilityPreview | undefined;
  readonly note: string;
  /** Whether a wallet balance was actually read for this answer. */
  readonly checked: boolean;
  /**
   * The transactions this quote would send and the ceiling they are priced
   * under, when a wallet was resolved and the plan could be measured. It is what
   * the snapshot binds and what the execute is later held to.
   */
  readonly debitPlan: BoundDebitPlan | undefined;
}

/**
 * Read the wallet, price the whole plan, and judge - or say honestly that this
 * quote answered no wallet.
 *
 * NO WALLET SELECTED is not a refusal here. The prequote recorder skips the row
 * entirely when it cannot resolve a selected address
 * (`prequote/record/swap.ts`), so no claimable authority exists for such a
 * quote in the first place; refusing would replace a route the agent asked for
 * with a wallet error it did not. What the answer must NOT do is imply a
 * balance was checked, and `balanceChecked: false` plus its own sentence is
 * exactly that statement.
 *
 * A THROW from any probe is `balance_unavailable`, never a pass: an exception
 * crossing this boundary is precisely where "unavailable" gets caught somewhere
 * generic and rendered as "fine" (rule 04, contract C2.3).
 */
async function measureSpendability(input: {
  readonly routeEligibility: QuoteEligibility;
  readonly context: ProtocolExecutionContext;
  readonly client: ReturnType<typeof getUniswapPublicClient>;
  readonly deployment: ReturnType<typeof requireDeployment>;
  readonly router: Address;
  readonly tokenIn: Parameters<typeof planUniswapDebitLegs>[0]["tokenIn"];
  readonly tokenOut: Parameters<typeof planUniswapDebitLegs>[0]["tokenOut"];
  readonly quoted: Parameters<typeof planUniswapDebitLegs>[0]["quoted"];
  readonly charge: Parameters<typeof planUniswapDebitLegs>[0]["charge"];
  readonly principalRaw: bigint;
}): Promise<SpendabilityOutcome> {
  const { routeEligibility } = input;
  if (!isExecutable(routeEligibility)) {
    return {
      eligibility: routeEligibility,
      preview: undefined,
      checked: false,
      debitPlan: undefined,
      note: "The wallet's balance was not read: this route is not executable for a reason no balance would change.",
    };
  }

  let wallet: Address;
  try {
    wallet = getAddress(
      resolveSelectedAddress(input.context.walletResolution, input.context.walletPolicy, "eip155"),
    );
  } catch {
    return {
      eligibility: routeEligibility,
      preview: undefined,
      checked: false,
      debitPlan: undefined,
      note: "No EVM wallet is selected for this session, so nothing was read about balances and this quote states nothing about them."
        + " Select a wallet and quote again to have the input balance and the whole native debit checked.",
    };
  }

  const spendabilityClient: UniswapSpendabilityClient = input.client;
  try {
    const currentAllowance = input.tokenIn.isNative
      ? 0n
      : await readUniswapAllowance(input.client, input.tokenIn.address, wallet, input.router);
    const planned = planUniswapDebitLegs({
      deployment: input.deployment,
      router: input.router,
      recipient: wallet,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      quoted: input.quoted,
      charge: input.charge,
      currentAllowance,
    });
    const legs = await estimateUniswapPlanGas({
      client: spendabilityClient,
      wallet,
      legs: planned,
      quotedSwapGas: input.quoted.route.gasEstimate,
    });
    const feeCap = await resolveUniswapLegFeeCap(spendabilityClient);
    const nonce = await spendabilityClient.getTransactionCount({ address: wallet, blockTag: "pending" });
    const debit = await priceUniswapNativeDebit({
      client: spendabilityClient,
      chainId: input.deployment.chainId,
      wallet,
      legs,
      feeCap,
      nonce,
    });
    const observation = await observeUniswapSwapSpendability({
      client: spendabilityClient,
      chainId: input.deployment.chainId,
      wallet,
      tokenIn: input.tokenIn,
      // The FULL requested amount: the swap leg takes the router input and the
      // fee leg takes the remainder, both out of this one asset.
      sourceRequiredRaw: input.principalRaw,
      debit,
    });
    // The plan the SNAPSHOT binds, built from the very legs just priced: the
    // roles in broadcast order, each leg's PRICING BASIS, and the one ceiling
    // every leg was costed at. Gas UNITS are never bound quote-to-execute
    // (2.07x measured drift, WP2-K); the basis is, because a conservatively
    // priced leg is a materially different statement to the person signing.
    //
    // A leg with NO figure at all cannot reach here: `priceUniswapNativeDebit`
    // already refused the whole debit, `debit.ok` is false, and the plan is
    // omitted so the ineligible quote seals nothing it could later authorize.
    const boundLegs = legs.flatMap((leg) =>
      leg.gas === null ? [] : [{ role: leg.role, pricing: leg.gas.pricing }],
    );
    const debitPlan = debit.ok && boundLegs.length === legs.length
      ? buildBoundDebitPlan({ legs: boundLegs, feeCap })
      : undefined;
    const judged = judgeUniswapSpendability(observation, routeEligibility, debitPlan);
    return {
      eligibility: judged.eligibility,
      preview: judged.preview,
      checked: true,
      debitPlan,
      note: uniswapSpendabilityNote(
        judged.eligibility,
        debit.ok ? debit.conservativeRoles : [],
      ),
    };
  } catch (err) {
    logger.warn("uniswap.swap.quote.spendability_probe_failed", {
      chainId: input.deployment.chainId,
      error: err instanceof Error ? err.name : "unknown",
    });
    const eligibility: QuoteEligibility = {
      kind: "balance_unavailable",
      asset: {
        chainId: input.deployment.chainId,
        address: input.tokenIn.address,
        symbol: input.tokenIn.symbol,
      },
      cause: SPENDABILITY_PROBE_FAILED,
    };
    return {
      eligibility,
      preview: undefined,
      checked: true,
      debitPlan: undefined,
      note: uniswapSpendabilityNote(eligibility),
    };
  }
}
