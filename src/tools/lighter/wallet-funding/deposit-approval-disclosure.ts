/**
 * Non-spoofable approval-card disclosure for a prepared Lighter deposit.
 *
 * Every display value is recomputed here from the persisted deposit intent —
 * amount from the stored base units, destination from the stored credit
 * address — never from model text, so the human-readable card can never diverge
 * from what the executor will sign. The scope note enforces the trade/withdraw
 * separation at the approval layer: a deposit approval authorizes only a deposit
 * into the user's own account.
 */

import { formatLighterIntegerAmount } from "@tools/lighter/order-preview.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import {
  LIGHTER_SETTLEMENT_ASSET,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "./constants.js";

const ENVIRONMENT_LABELS = {
  core: "Lighter Core",
  rhc: "Robinhood Chain Lighter",
} as const;

const CHAIN_LABELS: Record<number, string> = { 1: "Ethereum" };

const ROUTE_LABELS: Record<number, string> = { 0: "perps", 1: "spot" };

export interface LighterDepositApprovalDisclosure {
  readonly environmentLabel: string;
  readonly settlementAsset: string;
  readonly amountDisplay: string;
  readonly creditAddress: string;
  readonly depositContract: string;
  readonly chainLabel: string;
  readonly routeLabel: string;
  readonly createsAccountNote: string;
  readonly gasNote: string;
  readonly scopeNote: string;
  readonly summary: string;
}

export function buildLighterDepositApprovalDisclosure(
  intent: LighterOnboardingIntentRow,
): LighterDepositApprovalDisclosure {
  if (intent.capability !== "deposit") {
    throw disclosureUnavailable("This approval disclosure is only for Lighter deposit intents.");
  }
  if (
    intent.amountUnits === null
    || intent.depositTo === null
    || intent.depositContract === null
    || intent.assetIndex === null
    || intent.routeType === null
  ) {
    throw disclosureUnavailable("The Lighter deposit intent is missing required deposit fields.");
  }

  const settlementAsset = LIGHTER_SETTLEMENT_ASSET[intent.environment];
  const amount = formatLighterIntegerAmount(
    parseAmountUnits(intent.amountUnits),
    LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  );
  const amountDisplay = `${amount} ${settlementAsset}`;
  const environmentLabel = ENVIRONMENT_LABELS[intent.environment];
  const chainLabel = CHAIN_LABELS[intent.chainId] ?? `chain ${intent.chainId}`;
  const routeLabel = ROUTE_LABELS[intent.routeType] ?? `route ${intent.routeType}`;

  return {
    environmentLabel,
    settlementAsset,
    amountDisplay,
    creditAddress: intent.depositTo,
    depositContract: intent.depositContract,
    chainLabel,
    routeLabel,
    createsAccountNote:
      "If this is your wallet's first Lighter deposit, it creates a new Lighter account owned by this wallet.",
    gasNote: `Gas is paid in ETH from this wallet on ${chainLabel}.`,
    scopeNote:
      "This approval authorizes only a deposit into your own Lighter account. It does not place any trade or authorize any withdrawal.",
    summary:
      `Deposit ${amountDisplay} from ${intent.depositTo} into your ${environmentLabel} ${routeLabel} account on ${chainLabel}.`,
  };
}

function parseAmountUnits(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw disclosureUnavailable("Stored Lighter deposit amount is not a positive integer.");
  }
  return BigInt(value);
}

function disclosureUnavailable(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Prepare the Lighter deposit again from a fresh onboarding status.",
  );
}
