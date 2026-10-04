import { ErrorCodes, VexError } from "../../../../errors.js";
import type { LighterClient, LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type {
  LighterAccountLimitsResponse, LighterAccountResponse, LighterEnvironment, LighterMarket, LighterSystemConfigResponse,
} from "@tools/lighter/types.js";
import {
  getLighterFeePolicy, getLighterIntegratorFees, assertLighterFeePolicyLive,
  assertLighterFeeAllowance, lighterIntegratorFeesEqual, type LighterIntegratorFees,
} from "@tools/lighter/fee-policy.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";
import { isLighterUnreachable } from "./before-send.js";

export type LighterOrderFeeClient = Partial<Pick<LighterClient, "getAccount" | "getSystemConfig" | "getAccountLimits">>;

/**
 * `LIGHTER_REVALIDATION_SINGLE_SNAPSHOT`: the reads one execute-time
 * revalidation has already started, handed to the fee checks so nothing is
 * read twice. Each read is AWAITED only where the check without a snapshot
 * would issue it, so its failure counts exactly where that read's failure
 * counts today.
 */
export interface LighterOrderFeeReadSnapshot {
  /** The execute-time `fresh` account read this revalidation already made. */
  readonly traderAccount: LighterAccountResponse;
  readonly systemConfig: () => Promise<LighterSystemConfigResponse>;
  readonly collectorAccount: () => Promise<LighterAccountResponse>;
  /** The one read-only auth this order resolves; null exactly when the resolver says so. */
  readonly resolveAuth: () => Promise<LighterPrivilegedAccountAuth | null>;
  /** Read with the auth above; called only once that auth is known to be non-null. */
  readonly accountLimits: () => Promise<LighterAccountLimitsResponse>;
}

export interface ResolveLighterOrderFeesInput {
  readonly client: LighterOrderFeeClient;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly market: Pick<LighterMarket, "market_type">;
  readonly account?: LighterAccountResponse;
  /** Fresh account response from the same preparation; never supplied on execution revalidation. */
  readonly freshAccount?: LighterAccountResponse;
  readonly reduceOnly: boolean;
  readonly side: "buy" | "sell";
  readonly auth?: LighterPrivilegedAccountAuth | null;
  readonly nowMs?: number;
  readonly allowUnattributedExit?: boolean;
  /** Absent reads everything here, as before; see {@link LighterOrderFeeReadSnapshot}. */
  readonly snapshot?: LighterOrderFeeReadSnapshot;
}

/** Called only for orders whose inventory or reduce-only amount is also proven. */
export async function resolveLighterOrderFees(input: ResolveLighterOrderFeesInput): Promise<LighterIntegratorFees | null> {
  const policy = getLighterFeePolicy(input.environment);
  if (policy === null) return null;
  const reducing = input.allowUnattributedExit !== false && (input.market.market_type === "perp" ? input.reduceOnly : input.side === "sell");
  try {
    if (!input.client.getAccount || !input.client.getSystemConfig || !input.client.getAccountLimits) throw new Error("Live fee checks are unavailable.");
    // A caller's own auth keeps every read here; the snapshot is only ever
    // paired with the auth it resolved itself.
    const snapshot = input.auth === undefined ? input.snapshot : undefined;
    const auth = input.auth ?? (snapshot === undefined
      ? await resolveLighterReadOnlyAccountAuth(input.environment, input.accountIndex)
      : await snapshot.resolveAuth());
    if (auth === null) throw new Error("Unlock the local vault to check the account's fee authorization.");
    const [systemConfig, collector, trader, accountLimits] = await Promise.all(snapshot === undefined
      ? [
        input.client.getSystemConfig(input.environment, { fresh: true }),
        input.client.getAccount(input.environment, { by: "index", value: policy.collectorAccountIndex }, { fresh: true }),
        input.freshAccount ?? input.client.getAccount(input.environment, { by: "index", value: input.accountIndex }, { fresh: true }),
        input.client.getAccountLimits(input.environment, { accountIndex: input.accountIndex }, auth),
      ] as const
      : [
        snapshot.systemConfig(),
        snapshot.collectorAccount(),
        input.freshAccount ?? snapshot.traderAccount,
        snapshot.accountLimits(),
      ] as const);
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
    // Not reaching Lighter says nothing about fee setup. Reporting it as missing
    // setup told a trader who was offline "Lighter fee setup is required ...
    // fetch failed" (2026-09-24), and would send the agent to a fee approval the
    // account already has.
    if (isLighterUnreachable(error)) throw error;
    throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Lighter fee setup is required before this trade. ${error instanceof Error ? error.message : "Live fee authorization could not be verified."}`,
      "Continue with lighter.fees.approve.prepare for this environment, then prepare the requested trade again after the user approves its fee card.");
  }
}

export async function revalidateLighterOrderFees(input: ResolveLighterOrderFeesInput & {
  readonly integratorFees?: LighterIntegratorFees | null;
}): Promise<void> {
  // Consent-time validation must never rely on a response captured for preview.
  const current = await resolveLighterOrderFees({ ...input, freshAccount: undefined });
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
  snapshot?: Pick<LighterOrderFeeReadSnapshot, "resolveAuth" | "accountLimits">,
): Promise<number | undefined> {
  if (getLighterFeePolicy(environment) === null) return undefined;
  const auth = snapshot === undefined
    ? await resolveLighterReadOnlyAccountAuth(environment, accountIndex)
    : await snapshot.resolveAuth();
  if (!client.getAccountLimits || auth === null) {
    throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, "The current Lighter account fee could not be checked before this spot buy. Unlock VEX and refresh the preview.");
  }
  const limits = snapshot === undefined
    ? await client.getAccountLimits(environment, { accountIndex }, auth)
    : await snapshot.accountLimits();
  const ticks = limits.current_taker_fee_tick;
  if (limits.code !== 200 || !Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) {
    throw new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, "The current Lighter account taker fee is invalid.");
  }
  return ticks;
}
