import { ErrorCodes, VexError } from "../../../../errors.js";
import type { LighterClient, LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type { LighterAccountResponse, LighterEnvironment, LighterMarket } from "@tools/lighter/types.js";
import {
  getLighterFeePolicy, getLighterIntegratorFees, assertLighterFeePolicyLive,
  assertLighterFeeAllowance, lighterIntegratorFeesEqual, type LighterIntegratorFees,
} from "@tools/lighter/fee-policy.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";

export type LighterOrderFeeClient = Partial<Pick<LighterClient, "getAccount" | "getSystemConfig" | "getAccountLimits">>;

export interface ResolveLighterOrderFeesInput {
  readonly client: LighterOrderFeeClient;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly market: Pick<LighterMarket, "market_type">;
  readonly account?: LighterAccountResponse;
  readonly reduceOnly: boolean;
  readonly side: "buy" | "sell";
  readonly auth?: LighterPrivilegedAccountAuth | null;
  readonly nowMs?: number;
  readonly allowUnattributedExit?: boolean;
}

/** Called only for orders whose inventory or reduce-only amount is also proven. */
export async function resolveLighterOrderFees(input: ResolveLighterOrderFeesInput): Promise<LighterIntegratorFees | null> {
  const policy = getLighterFeePolicy(input.environment);
  if (policy === null) return null;
  const reducing = input.allowUnattributedExit !== false && (input.market.market_type === "perp" ? input.reduceOnly : input.side === "sell");
  try {
    if (!input.client.getAccount || !input.client.getSystemConfig || !input.client.getAccountLimits) throw new Error("Live fee checks are unavailable.");
    const auth = input.auth ?? await resolveLighterReadOnlyAccountAuth(input.environment, input.accountIndex);
    if (auth === null) throw new Error("Unlock the local vault to check the account's fee authorization.");
    const [systemConfig, collector, trader, accountLimits] = await Promise.all([
      input.client.getSystemConfig(input.environment, { fresh: true }),
      input.client.getAccount(input.environment, { by: "index", value: policy.collectorAccountIndex }, { fresh: true }),
      input.client.getAccount(input.environment, { by: "index", value: input.accountIndex }, { fresh: true }),
      input.client.getAccountLimits(input.environment, { accountIndex: input.accountIndex }, auth),
    ]);
    const collectors = collector.accounts.filter((row) => (row.index ?? row.account_index) === policy.collectorAccountIndex);
    const traders = trader.accounts.filter((row) => (row.index ?? row.account_index) === input.accountIndex);
    if (collector.code !== 200 || trader.code !== 200 || collector.accounts.length !== 1
      || trader.accounts.length !== 1 || collectors.length !== 1 || traders.length !== 1) {
      throw new Error("The exact collector or trading account could not be verified.");
    }
    assertLighterFeePolicyLive(policy, { systemConfig, collectorAccount: collectors[0]! });
    assertLighterFeeAllowance(policy, { account: traders[0]!, accountLimits, ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }) });
    return getLighterIntegratorFees(policy, input.market.market_type);
  } catch (error) {
    // Existing funds remain accessible through ordinary explicit trade approval.
    // Never silently remove fees from an already approved fee-bearing order.
    if (reducing) return null;
    throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Lighter fee setup is required before this trade. ${error instanceof Error ? error.message : "Live fee authorization could not be verified."}`,
      "Continue with lighter.fees.approve.prepare for this environment, then prepare the requested trade again after the user approves its fee card.");
  }
}

export async function revalidateLighterOrderFees(input: ResolveLighterOrderFeesInput & {
  readonly integratorFees?: LighterIntegratorFees | null;
}): Promise<void> {
  const current = await resolveLighterOrderFees(input);
  if (!lighterIntegratorFeesEqual(current, input.integratorFees)) {
    throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST,
      "The Lighter fee policy or authorization changed after this preview. Prepare a fresh order and approval with the current fee terms.");
  }
}

/** Current account-tier fee used only as a conservative spot input bound. */
export async function readLighterOrderAccountFeeTicks(
  client: LighterOrderFeeClient,
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<number | undefined> {
  if (getLighterFeePolicy(environment) === null) return undefined;
  const auth = await resolveLighterReadOnlyAccountAuth(environment, accountIndex);
  if (!client.getAccountLimits || auth === null) {
    throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, "The current Lighter account fee could not be checked before this spot buy. Unlock VEX and refresh the preview.");
  }
  const limits = await client.getAccountLimits(environment, { accountIndex }, auth);
  const ticks = limits.current_taker_fee_tick;
  if (limits.code !== 200 || !Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) {
    throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, "The current Lighter account taker fee is invalid.");
  }
  return ticks;
}
