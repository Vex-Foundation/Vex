/**
 * `vexCloud.account`: the signed-in account as public facts, or a clean
 * signed-out state.
 *
 * A 401 from the backend means the stored session is gone (expired, revoked
 * by an unlink, or the account removed). The stored bearer is then REMOVED
 * from the vault before answering `signed_out / session_expired`, so the app
 * is never half signed in: the engine stops using the dead bearer (the
 * provider cache is reset with it) and the next read does not repeat the
 * failing call.
 */

import type {
  VexCloudAccount,
  VexCloudAccountResult,
  VexCloudAmount,
} from "@shared/schemas/vex-cloud.js";
import type { VexError } from "@shared/ipc/result.js";
import type { Result } from "@shared/ipc/result.js";
import { parseRateX18, weiToMicroUsdFloor } from "@shared/vex-cloud-money.js";
import type { VexCloudAccountResponse, VexCloudApi } from "./api-client.js";
import { depositPinVerdict } from "./funding/deposit-pin.js";
import {
  CANCELLED_DETAIL,
  INVALID_RESPONSE_DETAIL,
  refused,
  UNAVAILABLE_DETAIL,
  type VexCloudOutcome,
} from "./outcome.js";

function amount(value: { readonly wei: string; readonly usd_micro_estimate: string | null }): VexCloudAmount {
  return { wei: value.wei, decimals: 18, symbol: "VEX", usdMicroEstimate: value.usd_micro_estimate };
}

/**
 * `withdrawable_wei` with the backend's own USD estimate method: none is
 * sent for it, so the USD figure is derived at the account's rate, rounded
 * down. Absent from an older backend: `null`, shown as "Not available".
 */
function withdrawableOf(response: VexCloudAccountResponse): VexCloudAmount | null {
  if (response.withdrawable_wei === undefined) return null;
  const rateX18 = response.rate.available ? parseRateX18(response.rate.vex_wei_per_micro_usd) : null;
  return {
    wei: response.withdrawable_wei,
    decimals: 18,
    symbol: "VEX",
    usdMicroEstimate: rateX18 === null ? null : weiToMicroUsdFloor(BigInt(response.withdrawable_wei), rateX18).toString(),
  };
}

/** Backend account response -> the renderer DTO. Pure. */
export function toVexCloudAccount(response: VexCloudAccountResponse, readAt: Date): VexCloudAccount {
  return {
    accountId: response.account_id,
    paused: response.status.paused,
    wallets: response.wallets.map((wallet) => ({ address: wallet.address, linkedAt: wallet.linked_at })),
    balances: {
      available: amount(response.balances.available),
      provisional: amount(response.balances.provisional),
      reserved: amount(response.balances.reserved),
      pendingWithdrawal: amount(response.balances.pending_withdrawal),
      claimable: amount(response.balances.claimable),
      cashbackPending: response.balances.cashback_pending === undefined ? null : amount(response.balances.cashback_pending),
    },
    withdrawable: withdrawableOf(response),
    depositAddress: response.deposit_address,
    limits: {
      minDepositMicroUsd: response.limits.min_deposit_micro_usd,
      minWithdrawMicroUsd: response.limits.min_withdraw_micro_usd,
      provisionalCapMicroUsd: response.limits.provisional_cap_micro_usd,
      withdrawDailyLimitMicroUsd: response.limits.withdraw_daily_limit_micro_usd ?? null,
      withdrawDailyRemainingWei: response.limits.withdraw_daily_remaining_wei ?? null,
    },
    rate: response.rate.available
      ? {
          available: true,
          source: response.rate.source,
          observedAt: response.rate.observed_at,
          ageSeconds: response.rate.age_seconds,
          vexWeiPerMicroUsd: response.rate.vex_wei_per_micro_usd,
          validUntil: response.rate.valid_until,
        }
      : { available: false, reason: response.rate.reason },
    readAt: readAt.toISOString(),
  };
}

export interface ReadAccountDeps {
  readonly api: Pick<VexCloudApi, "readAccount">;
  readonly readSession: () => Promise<Result<string | null>>;
  readonly clearSession: () => Promise<Result<void>>;
  /** In-app EVM wallet addresses, checksummed, inventory order. */
  readonly localWallets: () => readonly string[];
  /** The deposit address pinned in this build (`resolveVexCloudDepositAddress`), or `null`. */
  readonly pinnedDepositAddress: () => string | null;
  readonly now: () => Date;
}

export async function readVexCloudAccount(
  deps: ReadAccountDeps,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudAccountResult>> {
  const localWallets = deps.localWallets();
  const stored = await deps.readSession();
  if (!stored.ok) return refused("vault", stored.error.message, stored.error as VexError);
  if (stored.data === null) {
    return { ok: true, value: { state: "signed_out", reason: "not_signed_in", localWallets } };
  }
  const read = await deps.api.readAccount(stored.data, signal);
  if (read.ok) {
    return {
      ok: true,
      value: {
        state: "signed_in",
        account: toVexCloudAccount(read.value, deps.now()),
        localWallets,
        depositPin: depositPinVerdict(deps.pinnedDepositAddress(), read.value.deposit_address),
      },
    };
  }
  switch (read.failure.kind) {
    case "unauthorized": {
      const cleared = await deps.clearSession();
      if (!cleared.ok) return refused("vault", cleared.error.message, cleared.error as VexError);
      return { ok: true, value: { state: "signed_out", reason: "session_expired", localWallets } };
    }
    case "cancelled":
      return refused("cancelled", CANCELLED_DETAIL);
    case "unavailable":
      return refused("unavailable", UNAVAILABLE_DETAIL);
    case "rejected":
    case "invalid_response":
      return refused("invalid_response", INVALID_RESPONSE_DETAIL);
  }
}
