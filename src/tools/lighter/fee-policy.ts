import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";
import type { LighterAccount, LighterAccountLimitsResponse, LighterSystemConfigResponse } from "./types.js";

export const LIGHTER_FEE_TICK = 1_000_000;
export const LIGHTER_PERPS_FEE = 1000;
export const LIGHTER_SPOT_FEE = 2500;
export const LIGHTER_FEE_AUTHORIZATION_DURATION_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface LighterIntegratorFees {
  readonly integratorAccountIndex: number;
  readonly integratorMakerFee: number;
  readonly integratorTakerFee: number;
}

export interface LighterFeePolicy {
  readonly environment: LighterEnvironment;
  readonly collectorAccountIndex: number;
  readonly collectorL1Address: string;
  readonly perpsMakerFee: typeof LIGHTER_PERPS_FEE;
  readonly perpsTakerFee: typeof LIGHTER_PERPS_FEE;
  readonly spotMakerFee: typeof LIGHTER_SPOT_FEE;
  readonly spotTakerFee: typeof LIGHTER_SPOT_FEE;
}

interface CollectorConfiguration {
  readonly enabled: boolean;
  readonly accountIndex: number | null;
  readonly l1Address: string | null;
}

// Only public, release-controlled collector identities belong here. Enable a
// deployment after its collector ownership and live collection are verified.
const COLLECTORS: Readonly<Record<LighterEnvironment, CollectorConfiguration>> = Object.freeze({
  core: Object.freeze({
    enabled: false,
    accountIndex: 743799,
    l1Address: "0x10Ce97Cf3142BE2a1a28aC83A55b21fDCE493C03",
  }),
  rhc: Object.freeze({
    enabled: false,
    accountIndex: 22869,
    l1Address: "0x10Ce97Cf3142BE2a1a28aC83A55b21fDCE493C03",
  }),
});

export function getLighterFeePolicy(environment: LighterEnvironment): LighterFeePolicy | null {
  return resolveLighterFeePolicy(environment, COLLECTORS[environment]);
}

export function resolveLighterFeePolicy(environment: LighterEnvironment, config: CollectorConfiguration): LighterFeePolicy | null {
  if (!config?.enabled) return null;
  if (!Number.isSafeInteger(config.accountIndex) || config.accountIndex === null || config.accountIndex < 1
    || config.accountIndex > 2 ** 48 - 2 || !/^0x[0-9a-fA-F]{40}$/.test(config.l1Address ?? "")
    || /^0x0{40}$/i.test(config.l1Address ?? "")) {
    throw invalid("VEX's Lighter fee collector is not configured correctly.");
  }
  return Object.freeze({ environment, collectorAccountIndex: config.accountIndex, collectorL1Address: config.l1Address!.toLowerCase(),
    perpsMakerFee: LIGHTER_PERPS_FEE, perpsTakerFee: LIGHTER_PERPS_FEE,
    spotMakerFee: LIGHTER_SPOT_FEE, spotTakerFee: LIGHTER_SPOT_FEE });
}

export function getLighterIntegratorFees(policy: LighterFeePolicy, marketType: "perp" | "spot"): LighterIntegratorFees {
  if (marketType !== "perp" && marketType !== "spot") throw invalid("Unknown Lighter market type for fees.");
  return Object.freeze({ integratorAccountIndex: policy.collectorAccountIndex,
    integratorMakerFee: marketType === "spot" ? policy.spotMakerFee : policy.perpsMakerFee,
    integratorTakerFee: marketType === "spot" ? policy.spotTakerFee : policy.perpsTakerFee });
}

export function assertLighterIntegratorFees(fees: LighterIntegratorFees): void {
  if (!Number.isSafeInteger(fees.integratorAccountIndex) || fees.integratorAccountIndex < 1 || fees.integratorAccountIndex > 2 ** 48 - 2
    || !Number.isInteger(fees.integratorMakerFee) || fees.integratorMakerFee < 0 || fees.integratorMakerFee > LIGHTER_FEE_TICK
    || !Number.isInteger(fees.integratorTakerFee) || fees.integratorTakerFee < 0 || fees.integratorTakerFee > LIGHTER_FEE_TICK) {
    throw invalid("Invalid Lighter integrator fee attributes.");
  }
}

export function lighterIntegratorFeesEqual(a: LighterIntegratorFees | null | undefined, b: LighterIntegratorFees | null | undefined): boolean {
  return a == null || b == null ? a == null && b == null
    : a.integratorAccountIndex === b.integratorAccountIndex && a.integratorMakerFee === b.integratorMakerFee && a.integratorTakerFee === b.integratorTakerFee;
}

export function assertLighterFeePolicyLive(policy: LighterFeePolicy, input: { systemConfig: LighterSystemConfigResponse; collectorAccount: LighterAccount }): void {
  const { systemConfig: config, collectorAccount: collector } = input;
  if (config.code !== 200) throw invalid("Cannot verify Lighter fee limits.");
  if ((collector.index ?? collector.account_index) !== policy.collectorAccountIndex || collector.l1_address?.toLowerCase() !== policy.collectorL1Address.toLowerCase()) {
    throw invalid("The Lighter collector account does not belong to VEX's configured wallet.");
  }
  for (const [rate, cap] of [[policy.perpsMakerFee, config.max_integrator_perps_maker_fee], [policy.perpsTakerFee, config.max_integrator_perps_taker_fee],
    [policy.spotMakerFee, config.max_integrator_spot_maker_fee], [policy.spotTakerFee, config.max_integrator_spot_taker_fee]]) {
    if (!Number.isSafeInteger(cap) || cap! < rate!) throw invalid("VEX's Lighter fee exceeds the current provider limit.");
  }
}

export function assertLighterFeeAllowance(policy: LighterFeePolicy, input: { account: LighterAccount; accountLimits: LighterAccountLimitsResponse; nowMs?: number }): void {
  if (input.accountLimits.code !== 200) throw invalid("Cannot verify Lighter account fee eligibility.");
  const tier = input.accountLimits.user_tier.toLowerCase();
  if (tier !== "plus" && tier !== "premium") throw invalid("Lighter trading fees require a Plus or Premium account. Complete fee setup in VEX.");
  const matching = input.account.approved_integrators?.filter((entry) => entry.account_index === policy.collectorAccountIndex);
  const allowance = matching?.length === 1 ? matching[0] : undefined;
  if (!allowance || allowance.approval_expiry <= (input.nowMs ?? Date.now())
    || allowance.max_perps_maker_fee < policy.perpsMakerFee || allowance.max_perps_taker_fee < policy.perpsTakerFee
    || allowance.max_spot_maker_fee < policy.spotMakerFee || allowance.max_spot_taker_fee < policy.spotTakerFee) {
    throw invalid("Approve VEX's Lighter trading fees before preparing this trade.");
  }
}

function invalid(message: string): VexError { return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, message); }
