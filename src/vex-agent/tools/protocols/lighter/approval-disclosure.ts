import {
  formatLighterIntegerAmount,
  isProtectiveOrderType,
} from "@tools/lighter/order-preview.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import { ErrorCodes, VexError } from "../../../../errors.js";

/**
 * Human-readable approval-card fields for a prepared Lighter order create.
 *
 * Every display value is recomputed here from the exact integer amounts the
 * signer will receive, using the market decimals persisted with the preview —
 * never taken from model text — so the human-readable disclosure can never
 * diverge from the signed order.
 */
export interface LighterOrderApprovalDisclosure {
  readonly marketSymbol: string;
  readonly marketType: "perp" | "spot";
  readonly baseAmountDisplay: string;
  readonly priceDisplay: string;
  readonly triggerPriceDisplay: string | null;
  readonly notionalDisplay: string;
  readonly orderExpiryIso: string;
  readonly orderSummary: string;
}

const ENVIRONMENT_LABELS = {
  core: "Lighter Core",
  rhc: "Robinhood Chain Lighter",
} as const;

export function buildLighterOrderApprovalDisclosure(
  intent: LighterOrderExecutionIntentRow,
  preview: LighterOrderPreviewRow,
): LighterOrderApprovalDisclosure {
  if (
    intent.previewId !== preview.previewId
    || intent.matchHash !== preview.matchHash
    || intent.environment !== preview.environment
    || intent.accountIndex !== preview.accountIndex
    || intent.apiKeyIndex !== preview.apiKeyIndex
    || intent.baseAmountInteger !== preview.baseAmountInteger
    || intent.priceInteger !== preview.priceInteger
    || intent.side !== preview.side
    || intent.marketIndex !== preview.marketIndex
    || intent.orderType !== preview.orderType
    || intent.timeInForce !== preview.timeInForce
    || intent.reduceOnly !== preview.reduceOnly
    || intent.triggerPriceInteger !== preview.triggerPriceInteger
    || intent.orderExpiryMs !== preview.orderExpiryMs
    || intent.clientOrderIndexPolicy !== preview.clientOrderIndexPolicy
    || intent.providerVersion !== preview.providerVersion
  ) {
    throw disclosureUnavailable(
      "The persisted Lighter preview no longer matches the prepared execution intent.",
    );
  }

  const stored = readStoredDisplayContext(preview.previewJson);
  const baseAmountDisplay = formatLighterIntegerAmount(
    parseWireInteger(intent.baseAmountInteger, "baseAmountInteger"),
    stored.baseDecimals,
  );
  const priceDisplay = formatLighterIntegerAmount(
    parseWireInteger(intent.priceInteger, "priceInteger"),
    stored.priceDecimals,
  );
  const triggerPriceDisplay = intent.triggerPriceInteger === null
    ? null
    : formatLighterIntegerAmount(
        parseWireInteger(intent.triggerPriceInteger, "triggerPriceInteger"),
        stored.priceDecimals,
      );
  const notionalDisplay = formatLighterIntegerAmount(
    parseWireInteger(intent.baseAmountInteger, "baseAmountInteger")
      * parseWireInteger(intent.priceInteger, "priceInteger"),
    stored.quoteDecimals,
  );
  const orderExpiryIso = new Date(intent.orderExpiryMs).toISOString();
  if (!Number.isFinite(Date.parse(orderExpiryIso))) {
    throw disclosureUnavailable("The prepared Lighter order expiry is invalid.");
  }

  const protective = isProtectiveOrderType(intent.orderType);
  const triggerLimit = intent.orderType === "stop-loss-limit"
    || intent.orderType === "take-profit-limit";
  const priceLabel = intent.orderType === "market"
    ? "worst acceptable price"
    : protective && !triggerLimit
      ? "hard execution bound"
      : "limit price";
  const environmentLabel = ENVIRONMENT_LABELS[intent.environment];
  const productLabel = stored.marketType === "spot" ? "spot" : "perpetual";
  const expiryDisclosure = signedExpiryDisclosure({
    orderExpiryIso,
    timeInForce: intent.timeInForce,
    protective,
  });
  const orderSummary =
    `${intent.side === "buy" ? "Buy" : "Sell"} ${baseAmountDisplay} ${stored.symbol} `
    + `at ${priceLabel} ${priceDisplay} (est. notional ${notionalDisplay}) `
    + (protective ? `after ${intent.orderType} trigger ${triggerPriceDisplay}; ` : "")
    + `on the ${productLabel} market on ${environmentLabel} (${intent.environment}); ${timeInForceLabel(intent.timeInForce)}`
    + `${intent.reduceOnly ? "; reduce-only" : ""}; ${expiryDisclosure} `
    + timeInForceDisclosure(intent.timeInForce, triggerLimit)
    + "API acceptance is not final execution.";

  return {
    marketSymbol: stored.symbol,
    marketType: stored.marketType,
    baseAmountDisplay,
    priceDisplay,
    triggerPriceDisplay,
    notionalDisplay,
    orderExpiryIso,
    orderSummary,
  };
}

function signedExpiryDisclosure(input: {
  readonly orderExpiryIso: string;
  readonly timeInForce: LighterOrderExecutionIntentRow["timeInForce"];
  readonly protective: boolean;
}): string {
  if (input.timeInForce === "immediate-or-cancel" && !input.protective) {
    return `stored, unsent expiry reference ${input.orderExpiryIso}; this timestamp is not the approval deadline and is not signed as an order expiry—Lighter receives a nil (0) OrderExpiry for this immediate-only order.`;
  }
  if (input.protective) {
    return `signed trigger-order expiry ${input.orderExpiryIso}.`;
  }
  return `signed order expiry ${input.orderExpiryIso}.`;
}

function timeInForceLabel(
  timeInForce: LighterOrderExecutionIntentRow["timeInForce"],
): string {
  if (timeInForce === "good-till-time") return "Keep open";
  if (timeInForce === "post-only") return "Maker only";
  return "Immediate only";
}

function timeInForceDisclosure(
  timeInForce: LighterOrderExecutionIntentRow["timeInForce"],
  triggerLimit: boolean,
): string {
  if (timeInForce === "immediate-or-cancel") {
    return "Any unfilled remainder is canceled immediately. ";
  }
  if (timeInForce === "post-only") {
    return "This maker-only order is not allowed to take liquidity. ";
  }
  return triggerLimit
    ? "After the trigger, the limit order may remain open until filled or expired and may never fill. "
    : "Any unfilled amount may remain open until filled or expired. ";
}

function readStoredDisplayContext(previewJson: Record<string, unknown>): {
  readonly symbol: string;
  readonly marketType: "perp" | "spot";
  readonly baseDecimals: number;
  readonly priceDecimals: number;
  readonly quoteDecimals: number;
} {
  const symbol = previewJson.symbol;
  const marketType = previewJson.marketType;
  const baseDecimals = readRecord(previewJson.baseAmount)?.decimals;
  const priceDecimals = readRecord(previewJson.price)?.decimals;
  const quoteDecimals = readRecord(previewJson.quoteNotional)?.decimals;
  if (
    typeof symbol !== "string"
    || symbol.trim().length === 0
    || (marketType !== "perp" && marketType !== "spot")
    || !isDecimalsValue(baseDecimals)
    || !isDecimalsValue(priceDecimals)
    || !isDecimalsValue(quoteDecimals)
  ) {
    throw disclosureUnavailable(
      "The persisted Lighter preview is missing the market type, symbol, or decimal precision needed for the approval disclosure.",
    );
  }
  return {
    symbol: symbol.trim(),
    marketType,
    baseDecimals,
    priceDecimals,
    quoteDecimals,
  };
}

function parseWireInteger(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw disclosureUnavailable(`The prepared Lighter ${field} is not a positive integer string.`);
  }
  return BigInt(value);
}

function isDecimalsValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 18;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function disclosureUnavailable(reason: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter order approval disclosure refused: ${reason} No approval card was created and no order was signed or submitted.`,
    "Run a fresh Lighter order preview and prepare the order again.",
  );
}
