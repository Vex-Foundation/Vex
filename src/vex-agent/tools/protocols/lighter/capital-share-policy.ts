/**
 * The agent's Lighter capital share, ENFORCED.
 *
 * `src/tools/lighter/capital-share.ts` owns the arithmetic and knows nothing
 * about wallets, databases or providers. This module owns everything the
 * arithmetic cannot decide for itself:
 *
 * - **Whose ceiling applies.** The share is stored per `(environment, wallet)`,
 *   and the wallet that matters is the one that OWNS THE TRADED ACCOUNT, not the
 *   wallet the session happens to have selected. `handlers/read.ts` resolves a
 *   preview's `accountIndex` separately from the session wallet, so a user with
 *   two wallets and two different shares must not have one wallet's ceiling
 *   applied to the other's account. The owning wallet is read from the live
 *   account's `l1_address` and lower-cased before the row is looked up, because
 *   the provider returns a CHECKSUMMED address (measured live 2026-09-10 on RHC
 *   account 24226: `0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA`) while the
 *   `lighter_trading_limits` primary key stores it lower-case.
 * - **Admission, not merely a check.** Two Vex sessions preparing at the same
 *   moment would both read the same remaining budget and both pass a loose
 *   check, committing twice the share. So the decision and the commitment are
 *   ONE transaction under an account-scoped advisory lock, owned by
 *   `db/repos/lighter-capital-commitments.ts`. This module never compares a
 *   budget it read earlier against a requirement it computed later and calls
 *   that enforcement.
 * - **Settlement, then retirement.** A commitment that outlives its intent would
 *   shrink the user's budget forever, but one retired the instant its order
 *   fills reopens the stale-snapshot gap: another session that read the account
 *   BEFORE the fill would then see the capital in neither the provider's numbers
 *   nor the ledger. So a TERMINAL outcome only STAMPS the settlement
 *   ({@link markLighterOrderCapitalCommitmentSettled}) and the row keeps
 *   counting until the observation lag has run from that stamp. `open` and
 *   `partially_filled` stamp nothing at all: that order can still consume what
 *   it reserved. Immediate retirement
 *   ({@link retireLighterOrderCapitalCommitment}) belongs only to PROVEN
 *   NON-SUBMISSION, where nothing on the account can be covering the
 *   commitment.
 *
 * WHAT THE CEILING COVERS, honestly stated (plan section 10): everything VEX
 * prepares on this account, from any Vex session and any Vex-managed key. It
 * therefore covers the user's own trade ticket too, because the ticket drafts a
 * chat message the agent turns into an ordinary order and is indistinguishable
 * at this seam; threading a trusted origin flag would change the provenance
 * contract. Keys the user drives OUTSIDE Vex are their own and are not policed
 * (local-first decree).
 *
 * FAIL DIRECTION. Under a configured share, a number this module cannot bound is
 * a REFUSAL, never an assumed zero: a zero here silently widens the user's
 * ceiling. With no share configured nothing is computed and nothing is refused.
 */

import {
  assessLighterOrderCapitalShare,
  computeLighterCapitalBudget,
  computeLighterOrderRequiredCapital,
  describeLighterCapitalShareBreach,
  formatCapitalUnits,
  LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE,
  resolveLighterCapitalRiskPriceInteger,
  resolveLighterInitialMarginFraction,
  type LighterCapitalBudget,
  type LighterCapitalShareAssessment,
  type LighterCapitalShareOutcome,
  type LighterOrderRequiredCapital,
} from "@tools/lighter/capital-share.js";
import { marginModeFromWire } from "@tools/lighter/margin-fraction.js";
import {
  decimalToLighterInteger,
  lighterOrderPriceRole,
  type LighterOrderType,
} from "@tools/lighter/order-preview.js";
import type { LighterIntegratorFees } from "@tools/lighter/fee-policy.js";
import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import type {
  LighterAccount,
  LighterAccountPosition,
  LighterAccountResponse,
  LighterEnvironment,
  LighterMarketDetail,
} from "@tools/lighter/types.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";
import { readLighterTradingLimits } from "@vex-agent/db/repos/lighter-trading-limits.js";
import {
  admitLighterCapitalCommitment,
  listLiveLighterCapitalCommitments,
  markLighterCapitalCommitmentSettled,
  retireLighterCapitalCommitment,
} from "@vex-agent/db/repos/lighter-capital-commitments.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import logger from "@utils/logger.js";

/**
 * The provider reads the ceiling needs: this account's resting orders and its
 * exchange fee tier.
 *
 * `getAccountLimits` is OPTIONAL because the fee-client boundary the order paths
 * already pass (`LighterOrderFeeClient`) declares it optional; an absent method
 * is treated exactly like an unreadable tier - a refusal under a configured
 * share, never a defaulted zero.
 */
export type LighterCapitalShareEvidenceClient =
  Pick<LighterClient, "getAccountActiveOrders">
  & Partial<Pick<LighterClient, "getAccountLimits">>;

/** The evidence client plus the reads an admission path performs for itself. */
export type LighterCapitalShareAdmissionClient =
  Pick<LighterClient, "getAccount" | "getMarketDetails" | "getAccountActiveOrders">
  & Partial<Pick<LighterClient, "getAccountLimits">>;

/** The share that governs one traded account, resolved from live evidence. */
export interface LighterCapitalSharePolicy {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  /** Lower-cased `l1_address` of the account's owning wallet. */
  readonly walletAddress: string;
  readonly agentCapitalSharePercent: number | null;
  readonly account: LighterAccount;
}

/**
 * Resolve the policy for the account an order will actually trade on.
 *
 * @param account the COMPLETE account read (`activeOnly: false`). A read that
 *   hid inactive markets would hide the very position rows whose margin the
 *   ceiling counts.
 */
export async function resolveLighterCapitalSharePolicy(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly account: LighterAccount;
}): Promise<LighterCapitalSharePolicy> {
  const rawAddress = input.account.l1_address;
  if (typeof rawAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(rawAddress.trim())) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_RESPONSE,
      `Lighter account ${input.accountIndex} reported no owning L1 address, so the user's capital share for it cannot be identified. Nothing was prepared.`,
    );
  }
  const walletAddress = rawAddress.trim().toLowerCase();
  const limits = await readLighterTradingLimits(input.environment, walletAddress);
  return {
    environment: input.environment,
    accountIndex: input.accountIndex,
    walletAddress,
    agentCapitalSharePercent: limits?.agentCapitalSharePercent ?? null,
    account: input.account,
  };
}

/** What one order would commit, and what the account has left. */
export interface LighterCapitalShareEvaluation {
  readonly policy: LighterCapitalSharePolicy;
  readonly budget: LighterCapitalBudget | null;
  readonly required: LighterOrderRequiredCapital | null;
  readonly providerCommittedUnits: string;
  readonly outcome: LighterCapitalShareOutcome;
}

export interface LighterCapitalShareOrderFacts {
  readonly market: LighterMarketDetail;
  readonly baseAmountInteger: string;
  readonly approvedPriceInteger: string;
  readonly approvedPriceRole: "limit_price" | "worst_acceptable_price" | "trigger_execution_bound";
  readonly side: "buy" | "sell";
  readonly reduceOnly: boolean;
  readonly vexIntegratorTakerFeeTicks: number | null;
}

/**
 * Compute the whole picture without touching the ledger.
 *
 * Used by the preview advisory (which must never veto) and by the admission
 * paths (which hand the numbers to the ledger). `includeLiveCommitments` is the
 * difference: an advisory adds Vex's own live commitments so the number the
 * agent reads is honest, while an admission passes only the PROVIDER's
 * commitments and lets the ledger sum Vex's own inside the locked transaction.
 */
export async function evaluateLighterOrderCapitalShare(input: {
  readonly policy: LighterCapitalSharePolicy;
  readonly order: LighterCapitalShareOrderFacts;
  readonly client: LighterCapitalShareEvidenceClient;
  readonly auth: LighterPrivilegedAccountAuth | null;
  readonly includeLiveCommitments: boolean;
}): Promise<LighterCapitalShareEvaluation> {
  const { policy, order } = input;
  const base = {
    agentCapitalSharePercent: policy.agentCapitalSharePercent,
    walletAddress: policy.walletAddress,
    accountIndex: policy.accountIndex,
    marketType: order.market.market_type,
    side: order.side,
    reduceOnly: order.reduceOnly,
  } as const;

  // Exemptions and the spot rule are decided BEFORE any provider read: a
  // reduce-only order, an unset share, or a spot trade must not pay for calls
  // whose answer cannot change the verdict. The `budget: null` arm of the
  // assessment is unreachable here because every one of those decisions is made
  // ahead of it.
  if (
    policy.agentCapitalSharePercent === null
    || order.reduceOnly
    || order.market.market_type === "spot"
  ) {
    return {
      policy,
      budget: null,
      required: null,
      providerCommittedUnits: "0",
      outcome: assessLighterOrderCapitalShare({
        ...base,
        budget: null,
        required: null,
        initialMarginFractionSource: "market_default",
      }),
    };
  }

  const positionRow = findPositionRow(policy.account, order.market.market_id);
  const imf = resolveLighterInitialMarginFraction({ positionRow, market: order.market });

  const risk = resolveLighterCapitalRiskPriceInteger({
    side: order.side,
    approvedPriceInteger: order.approvedPriceInteger,
    approvedPriceRole: order.approvedPriceRole,
    priceDecimals: order.market.supported_price_decimals,
    markPrice: order.market.mark_price,
  });
  if (!risk.ok) {
    return {
      policy,
      budget: null,
      required: null,
      providerCommittedUnits: "0",
      outcome: assessLighterOrderCapitalShare({
        ...base,
        budget: null,
        required: null,
        initialMarginFractionSource: imf.source,
        unbounded: risk.reason,
      }),
    };
  }

  // Both provider legs of the ceiling are read BEFORE the numbers they feed,
  // and each is a REFUSAL when unreadable rather than a defaulted zero.
  const resting = await readRestingOrderReservedMarginUnits({
    policy,
    client: input.client,
    auth: input.auth,
  });
  if (!resting.ok) {
    return {
      policy,
      budget: null,
      required: null,
      providerCommittedUnits: "0",
      outcome: assessLighterOrderCapitalShare({
        ...base,
        budget: null,
        required: null,
        initialMarginFractionSource: imf.source,
        unbounded: resting.reason,
      }),
    };
  }

  // The account's own exchange fee tier: see
  // {@link readLighterAccountExchangeTakerFeeTicks} for why it is read here and
  // not derived from `market.taker_fee`.
  let exchangeAccountTakerFeeTicks: number;
  try {
    exchangeAccountTakerFeeTicks = await readLighterAccountExchangeTakerFeeTicks({
      policy,
      client: input.client,
      auth: input.auth,
    });
  } catch (error) {
    return {
      policy,
      budget: null,
      required: null,
      providerCommittedUnits: "0",
      outcome: assessLighterOrderCapitalShare({
        ...base,
        budget: null,
        required: null,
        initialMarginFractionSource: imf.source,
        unbounded: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  const required = computeLighterOrderRequiredCapital({
    baseAmountInteger: order.baseAmountInteger,
    riskPriceInteger: risk.priceInteger,
    riskPriceBasis: risk.basis,
    sizeDecimals: order.market.supported_size_decimals,
    priceDecimals: order.market.supported_price_decimals,
    quoteDecimals: order.market.supported_quote_decimals,
    initialMarginFraction: imf.initialMarginFraction,
    exchangeTakerFeePercent: order.market.taker_fee,
    exchangeAccountTakerFeeTicks,
    vexIntegratorTakerFeeTicks: order.vexIntegratorTakerFeeTicks,
  });

  const liveCommitments = input.includeLiveCommitments
    ? (await listLiveLighterCapitalCommitments(policy.environment, policy.accountIndex))
        .map((row) => row.requiredUnits)
    : [];

  // The PROVIDER's own commitments, which the ledger is told about because it
  // cannot see them: its own live rows are the only thing it sums itself.
  const providerOnly = computeLighterCapitalBudget({
    agentCapitalSharePercent: policy.agentCapitalSharePercent as number,
    collateral: readRequiredAccountString(policy.account, "collateral"),
    crossInitialMarginRequirement: readRequiredAccountString(
      policy.account,
      "cross_initial_margin_requirement",
    ),
    isolatedAllocatedMargins: isolatedAllocatedMargins(policy.account),
    restingOrderReservedMarginUnits: resting.units,
    vexLiveIntentUnits: [],
  });
  const budget = liveCommitments.length === 0
    ? providerOnly
    : computeLighterCapitalBudget({
        agentCapitalSharePercent: policy.agentCapitalSharePercent as number,
        collateral: readRequiredAccountString(policy.account, "collateral"),
        crossInitialMarginRequirement: readRequiredAccountString(
          policy.account,
          "cross_initial_margin_requirement",
        ),
        isolatedAllocatedMargins: isolatedAllocatedMargins(policy.account),
        restingOrderReservedMarginUnits: resting.units,
        vexLiveIntentUnits: liveCommitments,
      });

  return {
    policy,
    budget,
    required,
    providerCommittedUnits: providerOnly.committedUnits,
    outcome: assessLighterOrderCapitalShare({
      ...base,
      budget,
      required,
      initialMarginFractionSource: imf.source,
    }),
  };
}

/** The block a preview carries beside `minimumChecks`. Advisory: it never vetoes. */
export type LighterCapitalShareAdvisory =
  | { readonly status: "not_applicable"; readonly reason: string }
  | { readonly status: "would_refuse"; readonly reason: string; readonly howToChange: string }
  | { readonly status: "within_share"; readonly assessment: LighterCapitalShareAssessment }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * ADVISORY ONLY, on the {@link https://github.com/deepseek-ai repeat-tool-reminder}
 * pattern: observe and enrich, never veto. The preview is a read; the ceiling is
 * enforced at prepare, where the intent row and its commitment are created
 * together. A preview that threw would deny the user the very numbers that
 * explain the later refusal.
 */
export async function buildLighterCapitalShareAdvisory(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly account: LighterAccount;
  readonly order: LighterCapitalShareOrderFacts;
  readonly client: LighterCapitalShareEvidenceClient;
  readonly auth: LighterPrivilegedAccountAuth | null;
}): Promise<LighterCapitalShareAdvisory> {
  try {
    const policy = await resolveLighterCapitalSharePolicy(input);
    if (policy.agentCapitalSharePercent === null) {
      return {
        status: "not_applicable",
        reason: `No agent capital share is set for this wallet, so no Vex ceiling applies. The user sets one in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}.`,
      };
    }
    const evaluation = await evaluateLighterOrderCapitalShare({
      policy,
      order: input.order,
      client: input.client,
      auth: input.auth,
      includeLiveCommitments: true,
    });
    const { outcome } = evaluation;
    if (!outcome.applies) {
      return { status: "not_applicable", reason: describeExemption(outcome.exemption) };
    }
    if ("refusal" in outcome) {
      return {
        status: "would_refuse",
        reason: outcome.refusal,
        howToChange: LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE,
      };
    }
    return outcome.assessment.passes
      ? { status: "within_share", assessment: outcome.assessment }
      : {
          status: "would_refuse",
          reason: describeLighterCapitalShareBreach(outcome.assessment),
          howToChange: LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE,
        };
  } catch (error) {
    logger.warn("lighter.capital_share.advisory_unavailable", {
      error: error instanceof Error ? error.message : String(error),
      accountIndex: input.accountIndex,
      environment: input.environment,
    });
    return {
      status: "unavailable",
      reason:
        "The agent's capital share for this account could not be read for this preview. It is still enforced when the order is prepared.",
    };
  }
}

/**
 * The preview's adapter: turn the requested order into {@link
 * LighterCapitalShareOrderFacts} and resolve the advisory.
 *
 * It lives here rather than in `handlers/read.ts` because the handler is 1564
 * lines and the mapping is policy, not routing. `null` means the preview carries
 * no block at all - a market whose margin metadata is absent, or a read that
 * failed - and the ceiling is still enforced at prepare.
 */
export async function resolveLighterPreviewCapitalShareAdvisory(input: {
  readonly client: LighterCapitalShareEvidenceClient;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly account: LighterAccountResponse;
  readonly market: LighterMarketDetail;
  readonly baseAmount: string;
  readonly price: string;
  readonly side: "buy" | "sell";
  readonly orderType: LighterOrderType;
  readonly reduceOnly: boolean;
  readonly integratorFees: LighterIntegratorFees | null;
}): Promise<LighterCapitalShareAdvisory | null> {
  const account = input.account.accounts.find(
    (row) => (row.index ?? row.account_index) === input.accountIndex,
  );
  if (account === undefined) return null;
  let baseAmountInteger: string;
  let approvedPriceInteger: string;
  try {
    baseAmountInteger = decimalToLighterInteger(
      input.baseAmount,
      input.market.supported_size_decimals,
      "baseAmount",
    ).toString();
    approvedPriceInteger = decimalToLighterInteger(
      input.price,
      input.market.supported_price_decimals,
      "price",
    ).toString();
  } catch {
    // The preview builder refuses these itself, with a better message. The
    // advisory simply has nothing to say about an order that will not exist.
    return null;
  }
  const auth = await resolveLighterReadOnlyAccountAuth(input.environment, input.accountIndex);
  return buildLighterCapitalShareAdvisory({
    environment: input.environment,
    accountIndex: input.accountIndex,
    account,
    client: input.client,
    auth,
    order: {
      market: input.market,
      baseAmountInteger,
      approvedPriceInteger,
      approvedPriceRole: lighterOrderPriceRole(input.orderType),
      side: input.side,
      reduceOnly: input.reduceOnly,
      vexIntegratorTakerFeeTicks: input.integratorFees?.integratorTakerFee ?? null,
    },
  });
}

/**
 * ENFORCE at prepare: admit the commitment atomically, or refuse with both
 * numbers.
 *
 * Called AFTER credential readiness and BEFORE the intent row exists, with the
 * intent id already chosen. The ledger inserts the commitment inside the same
 * locked transaction that decides it fits, so two concurrent prepares serialize
 * and only the fitting total proceeds.
 */
export async function admitLighterOrderCapitalCommitment(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly account: LighterAccount;
  readonly intentId: string;
  readonly kind: "create" | "modify";
  readonly order: LighterCapitalShareOrderFacts;
  readonly client: LighterCapitalShareEvidenceClient;
  readonly auth: LighterPrivilegedAccountAuth | null;
  /** On revalidation, the intent's own commitment must not count against itself. */
  readonly excludeIntentId?: string;
  /** MODIFY only: the requirement already committed, so only the increase is admitted. */
  readonly alreadyCommittedUnits?: string;
}): Promise<LighterCapitalShareOutcome> {
  const policy = await resolveLighterCapitalSharePolicy(input);
  if (policy.agentCapitalSharePercent === null) {
    return { applies: false, exemption: "no_share_configured" };
  }
  const evaluation = await evaluateLighterOrderCapitalShare({
    policy,
    order: input.order,
    client: input.client,
    auth: input.auth,
    includeLiveCommitments: false,
  });
  const { outcome } = evaluation;
  if (!outcome.applies) return outcome;
  if ("refusal" in outcome) {
    throw new VexError(ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED, outcome.refusal);
  }
  if (evaluation.budget === null || evaluation.required === null) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      "The live Lighter numbers this capital share depends on were not available, so nothing was prepared.",
    );
  }

  // MODIFY admits only the DELTA. A decrease is admitted as zero: it frees
  // budget rather than consuming it, and the existing commitment is replaced by
  // the caller's own retire/admit pair.
  const requiredUnits = input.alreadyCommittedUnits === undefined
    ? evaluation.required.requiredUnits
    : positiveDelta(evaluation.required.requiredUnits, input.alreadyCommittedUnits);

  const admission = await admitLighterCapitalCommitment({
    environment: policy.environment,
    accountIndex: policy.accountIndex,
    intentId: input.intentId,
    kind: input.kind,
    requiredUnits,
    budgetUnits: evaluation.budget.budgetUnits,
    providerCommittedUnits: evaluation.providerCommittedUnits,
    ...(input.excludeIntentId === undefined ? {} : { excludeIntentId: input.excludeIntentId }),
  });
  if (admission.admitted) return outcome;

  throw new VexError(
    ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
    `Refusing this Lighter order: it would commit ${formatCapitalUnits(requiredUnits)} of margin and fees, which exceeds the `
    + `${formatCapitalUnits(admission.remainingUnits)} still available under the agent's ${policy.agentCapitalSharePercent}% capital share `
    + `for account ${policy.accountIndex} (share budget ${formatCapitalUnits(evaluation.budget.budgetUnits)}, Vex orders already `
    + `holding ${formatCapitalUnits(admission.liveCommittedUnits)}). The order is NOT resized. `
    + `Raise the share in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}, or ask for a smaller order.`,
  );
}

/**
 * The create path's adapter: admit an approved preview's commitment.
 *
 * It takes the DURABLE preview row rather than the model's parameters, so the
 * numbers admitted are the numbers the user will see on the approval card. It
 * re-reads the account (`activeOnly: false`) and the market itself: the preview
 * may be up to two minutes old, and admitting against a stale collateral figure
 * would let a withdrawal in between widen the ceiling.
 *
 * @param excludeIntentId set at execute-time revalidation so the intent's own
 *   commitment does not count against itself.
 */
export async function admitLighterOrderCapitalCommitmentForPreview(input: {
  readonly intentId: string;
  readonly preview: Pick<
    LighterOrderPreviewRow,
    "environment" | "accountIndex" | "marketIndex" | "side" | "baseAmountInteger"
    | "priceInteger" | "orderType" | "reduceOnly" | "integratorFees"
  >;
  readonly client?: LighterCapitalShareAdmissionClient;
  readonly excludeIntentId?: string;
}): Promise<LighterCapitalShareOutcome> {
  const client = input.client ?? getLighterClient();
  const { environment, accountIndex, marketIndex } = input.preview;

  // ORDER MATTERS. The account read comes first because the OWNING WALLET must
  // come from the provider's `l1_address` and never from a local guess; the
  // market read comes only after a share is known to exist. On the default
  // install, where the user has set no share, preparation therefore costs one
  // account read and no market read, and derives nothing about the approval
  // card from live data.
  const accountResponse = await client.getAccount(environment, {
    by: "index",
    value: accountIndex,
    activeOnly: false,
  });
  const account = accountResponse.accounts.find(
    (row) => (row.index ?? row.account_index) === accountIndex,
  );
  if (account === undefined) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      `Lighter did not return account ${accountIndex}, so the agent's capital share for it could not be checked. Nothing was prepared.`,
    );
  }
  const earlyPolicy = await resolveLighterCapitalSharePolicy({
    environment,
    accountIndex,
    account,
  });
  if (earlyPolicy.agentCapitalSharePercent === null) {
    return { applies: false, exemption: "no_share_configured" };
  }

  const marketDetails = await client.getMarketDetails(environment, {
    marketId: marketIndex,
    filter: "all",
  });
  const market = [...marketDetails.order_book_details, ...marketDetails.spot_order_book_details]
    .find((detail) => detail.market_id === marketIndex);
  if (market === undefined) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      `Lighter did not return market ${marketIndex}, so the capital this order would commit could not be computed. Nothing was prepared.`,
    );
  }
  const auth = await resolveLighterReadOnlyAccountAuth(environment, accountIndex);
  return admitLighterOrderCapitalCommitment({
    environment,
    accountIndex,
    account,
    intentId: input.intentId,
    kind: "create",
    client,
    auth,
    ...(input.excludeIntentId === undefined ? {} : { excludeIntentId: input.excludeIntentId }),
    order: {
      market,
      baseAmountInteger: input.preview.baseAmountInteger,
      approvedPriceInteger: input.preview.priceInteger,
      approvedPriceRole: lighterOrderPriceRole(input.preview.orderType),
      side: input.preview.side,
      reduceOnly: input.preview.reduceOnly,
      vexIntegratorTakerFeeTicks: input.preview.integratorFees?.integratorTakerFee ?? null,
    },
  });
}

/**
 * The execute path's re-admission: the same decision, taken again at the commit
 * point.
 *
 * The approval may be minutes old. Between approval and signing the user can
 * withdraw collateral, lower the share in Settings, or open a position on
 * another market, and every one of those shrinks what remains. The intent's own
 * commitment is EXCLUDED so it is not counted twice against itself; what it must
 * still fit inside is the budget as it stands now.
 *
 * Throws `LIGHTER_CAPITAL_SHARE_EXCEEDED` before any key is loaded or anything
 * is signed.
 */
export async function readmitLighterOrderCapitalCommitmentAtExecute(input: {
  readonly intentId: string;
  readonly preview: Pick<
    LighterOrderPreviewRow,
    "environment" | "accountIndex" | "marketIndex" | "side" | "baseAmountInteger"
    | "priceInteger" | "orderType" | "reduceOnly" | "integratorFees"
  >;
  readonly client?: LighterCapitalShareAdmissionClient;
}): Promise<LighterCapitalShareOutcome> {
  return admitLighterOrderCapitalCommitmentForPreview({
    intentId: input.intentId,
    preview: input.preview,
    ...(input.client === undefined ? {} : { client: input.client }),
    excludeIntentId: input.intentId,
  });
}

/**
 * MODIFY: admit only the INCREASE in required margin.
 *
 * A modification is not a new order. Its open amount is already committed, so
 * admitting the whole new requirement would double count it and refuse a
 * modification that in fact frees capital. What must fit the remaining budget is
 * the DELTA: a size or price increase is admitted for the difference, and a
 * decrease is admitted as zero and always passes.
 *
 * The amounts compared are OPEN amounts (requested total minus already filled),
 * because filled base is no longer margin this order reserves.
 */
export async function admitLighterModifyCapitalCommitment(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly intentId: string;
  readonly side: "buy" | "sell";
  readonly reduceOnly: boolean;
  readonly filledBaseAmount: string;
  readonly currentBaseAmount: string;
  readonly currentPrice: string;
  readonly requestedBaseAmount: string;
  readonly requestedPrice: string;
  readonly sizeDecimals: number;
  readonly priceDecimals: number;
  readonly integratorFees: LighterIntegratorFees | null;
  readonly client?: LighterCapitalShareAdmissionClient;
  readonly excludeIntentId?: string;
}): Promise<LighterCapitalShareOutcome> {
  const client = input.client ?? getLighterClient();
  // Same ordering as the create path: the account first, because the owning
  // wallet must come from the provider's `l1_address`; the market only once a
  // share is known to exist, so an install with no share pays for no extra
  // market read.
  const accountResponse = await client.getAccount(input.environment, {
    by: "index",
    value: input.accountIndex,
    activeOnly: false,
  });
  const account = accountResponse.accounts.find(
    (row) => (row.index ?? row.account_index) === input.accountIndex,
  );
  if (account === undefined) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      "Lighter did not return the account this modification would trade on, so the agent's capital share could not be checked. Nothing was prepared.",
    );
  }

  const policy = await resolveLighterCapitalSharePolicy({
    environment: input.environment,
    accountIndex: input.accountIndex,
    account,
  });
  if (policy.agentCapitalSharePercent === null) {
    return { applies: false, exemption: "no_share_configured" };
  }

  const marketDetails = await client.getMarketDetails(input.environment, {
    marketId: input.marketIndex,
    filter: "all",
  });
  const market = [...marketDetails.order_book_details, ...marketDetails.spot_order_book_details]
    .find((detail) => detail.market_id === input.marketIndex);
  if (market === undefined) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      "Lighter did not return the market this modification would trade on, so the agent's capital share could not be checked. Nothing was prepared.",
    );
  }
  const auth = await resolveLighterReadOnlyAccountAuth(input.environment, input.accountIndex);

  const openBefore = openBaseInteger(
    input.currentBaseAmount, input.filledBaseAmount, input.sizeDecimals,
  );
  const openAfter = openBaseInteger(
    input.requestedBaseAmount, input.filledBaseAmount, input.sizeDecimals,
  );
  const facts = (baseAmountInteger: string, price: string): LighterCapitalShareOrderFacts => ({
    market,
    baseAmountInteger,
    approvedPriceInteger: decimalToLighterInteger(price, input.priceDecimals, "price").toString(),
    // A modify only ever targets an active LIMIT order (`order-lifecycle.ts`
    // refuses anything else), so its price is a resting limit price.
    approvedPriceRole: "limit_price",
    side: input.side,
    reduceOnly: input.reduceOnly,
    vexIntegratorTakerFeeTicks: input.integratorFees?.integratorTakerFee ?? null,
  });

  const before = await evaluateLighterOrderCapitalShare({
    policy,
    order: facts(openBefore, input.currentPrice),
    client,
    auth,
    includeLiveCommitments: false,
  });
  return admitLighterOrderCapitalCommitment({
    environment: input.environment,
    accountIndex: input.accountIndex,
    account,
    intentId: input.intentId,
    kind: "modify",
    client,
    auth,
    order: facts(openAfter, input.requestedPrice),
    ...(input.excludeIntentId === undefined ? {} : { excludeIntentId: input.excludeIntentId }),
    alreadyCommittedUnits: before.required?.requiredUnits ?? "0",
  });
}

function openBaseInteger(total: string, filled: string, sizeDecimals: number): string {
  const open = decimalToLighterInteger(total, sizeDecimals, "totalBaseAmount")
    - decimalToLighterInteger(filled, sizeDecimals, "filled base amount", { allowZero: true });
  return (open > 0n ? open : 0n).toString();
}

/**
 * Record that this intent SETTLED at the provider. The commitment stays live
 * and keeps counting until the observation lag has run from this moment.
 *
 * Call it ONLY from a terminal provider state (`filled`, `canceled`, `rejected`,
 * or a lifecycle `completed`). A resting or partially filled order can still
 * consume the capital it reserved, so it stamps nothing.
 *
 * Never throws into the outcome path that calls it: an order that really filled
 * must still be reported to the user even if the ledger could not be stamped. A
 * missed stamp only delays retirement - the admission sweep stamps the row
 * itself the next time it sees the terminal intent - and a row that keeps
 * counting only tightens the ceiling.
 */
export async function markLighterOrderCapitalCommitmentSettled(intentId: string): Promise<void> {
  try {
    await markLighterCapitalCommitmentSettled(intentId);
  } catch (error) {
    logger.warn("lighter.capital_share.settle_failed", {
      error: error instanceof Error ? error.message : String(error),
      intentId,
    });
  }
}

/**
 * Retire a commitment whose intent PROVABLY never reached the provider.
 *
 * The settled path does NOT come here: it stamps
 * {@link markLighterOrderCapitalCommitmentSettled} and lets the observation lag
 * run. The ledger enforces that too - a stamped row is not retired before its
 * lag elapses, whatever reason a caller passes.
 *
 * Never throws into the outcome path that calls it: an order that really settled
 * must still be reported to the user even if the ledger row could not be
 * retired. A stranded row over-counts, which only tightens the ceiling, and the
 * repair sweeps retire it later.
 */
export async function retireLighterOrderCapitalCommitment(input: {
  readonly intentId: string;
  readonly reason: string;
}): Promise<void> {
  try {
    await retireLighterCapitalCommitment(input);
  } catch (error) {
    logger.warn("lighter.capital_share.retire_failed", {
      error: error instanceof Error ? error.message : String(error),
      intentId: input.intentId,
    });
  }
}

// ── evidence ─────────────────────────────────────────────────────────────────

/**
 * THIS ACCOUNT's exchange taker-fee tier, in hundredths of a basis point.
 *
 * SAME PROVIDER SOURCE AS THE PREVIEW's own taker-fee estimate:
 * `accountLimits.current_taker_fee_tick`, which `order-fees.ts`
 * (`readLighterOrderAccountFeeTicks`) reads for a spot buy's inventory proof.
 * The formula that turns ticks into money is not duplicated - it lives once in
 * `capital-share.ts`, which charges the LARGER of this tier and the market's
 * own percent, exactly as `order-preview.ts` does.
 *
 * WHY NOT CALL `readLighterOrderAccountFeeTicks` ITSELF: that helper returns
 * `undefined` when the environment carries no VEX fee policy, because its
 * question is "will Vex add its own fee to this spot buy". The exchange charges
 * its tier regardless of whether Vex charges anything, so the ceiling must read
 * it unconditionally.
 *
 * FAIL DIRECTION. Under a configured share an unreadable tier REFUSES. A
 * defaulted zero would understate every order's charge on precisely the
 * accounts whose tier is nonzero, which is the ceiling silently widening.
 */
async function readLighterAccountExchangeTakerFeeTicks(input: {
  readonly policy: LighterCapitalSharePolicy;
  readonly client: Partial<Pick<LighterClient, "getAccountLimits">>;
  readonly auth: LighterPrivilegedAccountAuth | null;
}): Promise<number> {
  if (input.auth === null || typeof input.client.getAccountLimits !== "function") {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      "Vex could not read this Lighter account's exchange fee tier, so the charge this order would incur cannot be "
      + `bounded and it is not admitted under the ${input.policy.agentCapitalSharePercent}% capital share. `
      + `Unlock VEX and try again, or clear the share in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}.`,
    );
  }
  let ticks: number;
  try {
    const limits = await input.client.getAccountLimits(
      input.policy.environment,
      { accountIndex: input.policy.accountIndex },
      input.auth,
    );
    if (limits.code !== 200) throw new Error(`accountLimits returned code ${String(limits.code)}`);
    ticks = limits.current_taker_fee_tick;
  } catch (error) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      `Vex could not read this Lighter account's exchange fee tier (${error instanceof Error ? error.message : String(error)}), `
      + `so the charge this order would incur cannot be bounded and it is not admitted under the `
      + `${input.policy.agentCapitalSharePercent}% capital share.`,
    );
  }
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      "Lighter reported an unusable exchange fee tier for this account, so the charge this order would incur cannot be "
      + "bounded. It is NOT assumed to be zero and the order was not admitted.",
    );
  }
  return ticks;
}

/**
 * Margin reserved by this account's resting orders: `remaining base x price x
 * imf / 10000` per order.
 *
 * When the account has NO resting orders the leg is provably zero and no
 * authenticated read is made. When it has some and they cannot be read, the
 * commitment cannot be bounded, so a configured share REFUSES rather than
 * assuming zero.
 *
 * Whether the provider's own `cross_initial_margin_requirement` ALREADY includes
 * resting orders is not documented and is measured by the live harness (plan
 * step e2). Until it is, this leg may double count, which tightens the ceiling
 * and is the safe direction.
 */
async function readRestingOrderReservedMarginUnits(input: {
  readonly policy: LighterCapitalSharePolicy;
  readonly client: LighterCapitalShareEvidenceClient;
  readonly auth: LighterPrivilegedAccountAuth | null;
}): Promise<{ readonly ok: true; readonly units: readonly string[] } | { readonly ok: false; readonly reason: string }> {
  const openCount = countOpenOrders(input.policy.account);
  if (openCount === 0) return { ok: true, units: [] };
  if (input.auth === null) {
    return {
      ok: false,
      reason:
        `This Lighter account has resting orders whose reserved margin Vex could not read, so the capital already committed `
        + `cannot be bounded. The order is not admitted under the ${input.policy.agentCapitalSharePercent}% capital share. `
        + `Cancel the resting orders, or clear the share in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}.`,
    };
  }
  try {
    const response = await input.client.getAccountActiveOrders(
      input.policy.environment,
      { accountIndex: input.policy.accountIndex },
      input.auth,
    );
    const units: string[] = [];
    for (const order of response.orders) {
      const market = order.market_index;
      const positionRow = findPositionRow(input.policy.account, market);
      const imf = positionRow === null ? null : safeInitialMarginFraction(positionRow);
      if (imf === null) {
        return {
          ok: false,
          reason:
            `A resting Lighter order on market ${market} has no readable initial margin fraction, so the capital it `
            + `reserves cannot be bounded. The new order is not admitted under the ${input.policy.agentCapitalSharePercent}% capital share.`,
        };
      }
      units.push(reservedMarginUnits(order.remaining_base_amount ?? order.initial_base_amount, order.price, imf));
    }
    return { ok: true, units };
  } catch (error) {
    return {
      ok: false,
      reason:
        `Vex could not read this Lighter account's resting orders (${error instanceof Error ? error.message : String(error)}), `
        + `so the capital already committed cannot be bounded and the order is not admitted under the `
        + `${input.policy.agentCapitalSharePercent}% capital share.`,
    };
  }
}

/**
 * Reserved margin for one resting order, in settlement units, rounded UP.
 *
 * The order's amounts are DECIMAL strings, so this multiplies at a fixed 6+6
 * scale and divides back down rather than going through the market's integer
 * scale, which this call site does not carry.
 */
function reservedMarginUnits(remainingBase: string, price: string, imf: number): string {
  const base = decimalToScaled(remainingBase, 6);
  const priceScaled = decimalToScaled(price, 6);
  const notional = ceilDivBig(base * priceScaled, 1_000_000n);
  return ceilDivBig(notional * BigInt(imf), 10_000n).toString();
}

function decimalToScaled(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (match === null) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_RESPONSE,
      `A Lighter resting order reported an unreadable amount ("${String(value)}"), so its reserved margin cannot be computed.`,
    );
  }
  const [, whole, fraction = ""] = match;
  // Rounds UP so a longer provider fraction never understates a commitment.
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const remainder = fraction.slice(decimals);
  const bump = /[1-9]/.test(remainder) ? 1n : 0n;
  return BigInt(`${whole}${kept}`) + bump;
}

function ceilDivBig(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function safeInitialMarginFraction(position: LighterAccountPosition): number | null {
  try {
    return resolveLighterInitialMarginFraction({
      positionRow: position,
      market: { default_initial_margin_fraction: undefined },
    }).initialMarginFraction;
  } catch {
    return null;
  }
}

function countOpenOrders(account: LighterAccount): number {
  const positions = Array.isArray(account.positions) ? account.positions : [];
  let total = 0;
  for (const position of positions) {
    if (typeof position.open_order_count === "number") total += position.open_order_count;
    if (typeof position.pending_order_count === "number") total += position.pending_order_count;
  }
  const declared = account.total_order_count;
  if (typeof declared === "number" && declared > total) total = declared;
  return total;
}

function findPositionRow(account: LighterAccount, marketId: number): LighterAccountPosition | null {
  const positions = Array.isArray(account.positions) ? account.positions : [];
  return positions.find((row) => row.market_id === marketId) ?? null;
}

/**
 * Every isolated position's `allocated_margin`, or a REFUSAL.
 *
 * A position row whose `margin_mode` the converter does not recognise is not a
 * row to skip: it may be an isolated position holding real margin, and skipping
 * it removes that margin from `committed` and WIDENS the ceiling by exactly the
 * amount nobody could classify. Financial uncertainty refuses admission (module
 * header, FAIL DIRECTION); the preview advisory turns the same refusal into an
 * "unavailable" block rather than a number the user would be misled by.
 */
function isolatedAllocatedMargins(account: LighterAccount): readonly string[] {
  const positions = Array.isArray(account.positions) ? account.positions : [];
  const isolated: string[] = [];
  for (const position of positions) {
    let mode: string;
    try {
      mode = marginModeFromWire(position.margin_mode);
    } catch {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_RESPONSE,
        `Lighter reported margin mode ${String(position.margin_mode)} on this account's market `
        + `${String(position.market_id)}, which Vex does not recognise. The margin that position holds therefore `
        + "cannot be counted, so the agent's capital share cannot be computed and nothing was prepared. "
        + "It is NOT skipped: skipping it would widen the ceiling by an unknown amount.",
      );
    }
    if (mode !== "isolated") continue;
    isolated.push(position.allocated_margin);
  }
  return isolated;
}

function readRequiredAccountString(account: LighterAccount, field: string): string {
  const value = account[field];
  if (typeof value !== "string") {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_RESPONSE,
      `Lighter did not report ${field} for this account, so the agent's capital share cannot be computed. Nothing was prepared.`,
    );
  }
  return value;
}

function positiveDelta(required: string, alreadyCommitted: string): string {
  const next = BigInt(required);
  const current = BigInt(alreadyCommitted);
  return next > current ? (next - current).toString() : "0";
}

function describeExemption(exemption: "no_share_configured" | "reduce_only" | "spot_sell"): string {
  switch (exemption) {
    case "no_share_configured":
      return `No agent capital share is set for this wallet, so no Vex ceiling applies. The user sets one in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}.`;
    case "reduce_only":
      return "This order is reduce-only and proven against the live position, so it reduces exposure and the capital share does not apply.";
    case "spot_sell":
      return "This spot sell reduces inventory, so the capital share does not apply.";
  }
}
