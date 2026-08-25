import { formatLighterIntegerAmount } from "@tools/lighter/order-preview.js";
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
    || intent.baseAmountInteger !== preview.baseAmountInteger
    || intent.priceInteger !== preview.priceInteger
    || intent.side !== preview.side
    || intent.marketIndex !== preview.marketIndex
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
  const notionalDisplay = formatLighterIntegerAmount(
    parseWireInteger(intent.baseAmountInteger, "baseAmountInteger")
      * parseWireInteger(intent.priceInteger, "priceInteger"),
    stored.quoteDecimals,
  );
  const orderExpiryIso = new Date(intent.orderExpiryMs).toISOString();
  if (!Number.isFinite(Date.parse(orderExpiryIso))) {
    throw disclosureUnavailable("The prepared Lighter order expiry is invalid.");
  }

  const priceLabel = intent.orderType === "market" ? "worst acceptable price" : "limit price";
  const environmentLabel = ENVIRONMENT_LABELS[intent.environment];
  const productLabel = stored.marketType === "spot" ? "spot" : "perpetual";
  const orderSummary =
    `${intent.side === "buy" ? "Buy" : "Sell"} ${baseAmountDisplay} ${stored.symbol} `
    + `at ${priceLabel} ${priceDisplay} (est. notional ${notionalDisplay}) `
    + `on the ${productLabel} market on ${environmentLabel} (${intent.environment}); ${intent.timeInForce}`
    + `${intent.reduceOnly ? "; reduce-only" : ""}; expires ${orderExpiryIso}. `
    + `${intent.timeInForce === "immediate-or-cancel" ? "Any unfilled remainder is canceled immediately. " : ""}`
    + "API acceptance is not final execution.";

  return {
    marketSymbol: stored.symbol,
    marketType: stored.marketType,
    baseAmountDisplay,
    priceDisplay,
    notionalDisplay,
    orderExpiryIso,
    orderSummary,
  };
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
