/**
 * THE ROBINHOOD CHAIN POINTS READ MODEL - one row per wallet that has a
 * Lighter account registered through the app, for the Settings "Lighter
 * Points" section.
 *
 * WHAT IT REFUSES TO GUESS, which is most of the design:
 *
 *  - A wallet whose authorization cannot be minted is LISTED with the reason
 *    (locked vault, no saved credential, signer refusal), never dropped and
 *    never shown as zero points. "No row on the board" and "we could not ask"
 *    are different sentences.
 *  - The board POSITION is the provider's `entry` field, measured live
 *    (2026-09-08, account 24226: all-time `entry` 22146, weekly `entry` 1,
 *    `entryId` 11 on both). `entryId` is a row identifier and is never shown as
 *    a rank.
 *  - The wallet's own row is found by an EXACT full-address match. The
 *    provider masks every other address (`0x9C****...`), and a prefix match
 *    against a mask would attribute a stranger's points to the user.
 *  - Four reads per wallet, each its own outcome: one failing read never hides
 *    the other three's values.
 *
 * BOUNDS. At most four sequential provider requests per wallet, a per-wallet
 * deadline composed with the caller's signal, and a bounded wallet list that
 * reports what it did not read. A caller abort propagates as an AbortError; a
 * deadline breach is reported per read as `provider_timeout`.
 */

import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type {
  LighterLeaderboardEntry,
  LighterLeaderboardResponse,
  LighterLivePointsTotalResponse,
  LighterReferralPointsResponse,
} from "@tools/lighter/types.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import { composeDeadline, isAbortError } from "../../../../utils/cancellation.js";
import {
  resolveLighterReadOnlyAccountAuthOutcome,
  type LighterReadOnlyAccountAuthOutcome,
  type LighterReadOnlyAccountAuthUnavailableReason,
} from "./read-account-auth.js";

/** Why one of the four provider reads has no value. */
export type LighterPointsReadUnavailableReason =
  | "provider_unavailable"
  | "provider_refused"
  | "provider_timeout";

export interface LighterPointsReadUnavailable {
  readonly kind: "unavailable";
  readonly reason: LighterPointsReadUnavailableReason;
  readonly detail: string;
}

/** A board position, the absence of a row on that board, or a failed read. */
export type LighterPointsRank =
  | { readonly kind: "rank"; readonly points: number; readonly position: number }
  | { readonly kind: "rank_unavailable" }
  | LighterPointsReadUnavailable;

export type LighterPointsValue<T> =
  | { readonly kind: "value"; readonly value: T }
  | LighterPointsReadUnavailable;

export interface LighterReferralSummary {
  readonly totalPoints: number;
  readonly lastWeekPoints: number;
  readonly rewardPoints: number;
  readonly lastWeekRewardPoints: number;
  /** The provider's own decimal string ("0.1000"), never re-formatted here. */
  readonly multiplier: string;
  readonly referralCount: number;
}

export interface LighterPointsWallet {
  readonly walletAddress: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number | null;
  readonly tradingKeyRegistered: boolean;
}

export type LighterPointsRow =
  | (LighterPointsWallet & {
      readonly kind: "credential_missing_here";
      readonly observedAt: string;
    })
  | {
      readonly kind: "points";
      readonly walletAddress: string;
      readonly environment: LighterEnvironment;
      readonly accountIndex: number;
      readonly allTime: LighterPointsRank;
      readonly weekly: LighterPointsRank;
      readonly livePoints: LighterPointsValue<number>;
      readonly referral: LighterPointsValue<LighterReferralSummary>;
      readonly observedAt: string;
    }
  | {
      readonly kind: "unavailable";
      readonly walletAddress: string;
      readonly environment: LighterEnvironment;
      readonly accountIndex: number;
      readonly reason: Exclude<LighterReadOnlyAccountAuthUnavailableReason, "no_credential">;
      readonly detail: string;
      readonly observedAt: string;
    };

export interface LighterPointsReport {
  readonly rows: readonly LighterPointsRow[];
  /** Wallets with a resolved account that exist beyond the bounded page. */
  readonly walletCount: number;
  readonly observedAt: string;
}

/** Defaults; the IPC handler may narrow them, never widen them past its own budget. */
const LIGHTER_POINTS_DEADLINE_MS_PER_WALLET = 20_000;
const LIGHTER_POINTS_MAX_WALLETS = 100;

/**
 * The three reads this model performs, and nothing else. Narrower than the
 * whole client so a test double is a real implementation of the contract
 * rather than a cast over an object with 30 missing methods.
 */
export type LighterPointsClient = Pick<
  LighterClient,
  "getLeaderboard" | "getLivePointsTotal" | "getReferralPoints"
>;

export interface LighterPointsDeps {
  readonly client: LighterPointsClient;
  readonly listWallets: (limit: number) => Promise<{
    readonly rows: readonly LighterPointsWallet[];
    readonly totalCount: number;
  }>;
  readonly resolveAuth: (
    environment: LighterEnvironment,
    accountIndex: number,
  ) => Promise<LighterReadOnlyAccountAuthOutcome>;
  readonly now: () => Date;
}

function defaultLighterPointsDeps(): LighterPointsDeps {
  return {
    client: getLighterClient(),
    listWallets: async (limit) => {
      const { listLighterOnboardingResolvedAccounts } = await import(
        "../../../db/repos/lighter-onboarding-workflows.js"
      );
      const listed = await listLighterOnboardingResolvedAccounts({ limit });
      return {
        rows: listed.rows.map((row) => ({
          walletAddress: row.walletAddress,
          environment: row.environment,
          accountIndex: row.accountIndex,
          apiKeyIndex: row.apiKeyIndex,
          tradingKeyRegistered: row.tradingKeyRegistered,
        })),
        totalCount: listed.totalCount,
      };
    },
    resolveAuth: resolveLighterReadOnlyAccountAuthOutcome,
    now: () => new Date(),
  };
}

export interface LighterPointsRequest {
  readonly signal: AbortSignal;
  readonly deadlineMsPerWallet?: number;
  readonly maxWallets?: number;
  readonly deps?: LighterPointsDeps;
}

/**
 * PURE: the wallet's own row on a board, or null.
 *
 * Exact, case-insensitive, full-address equality. Every foreign row arrives
 * masked (`0x9C****...`), so a prefix or `startsWith` comparison would match a
 * mask and report a stranger's points as the user's.
 */
export function findWalletEntry(
  entries: readonly LighterLeaderboardEntry[],
  walletAddress: string,
): LighterLeaderboardEntry | null {
  const wanted = walletAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wanted)) return null;
  for (const entry of entries) {
    if (entry.l1_address.trim().toLowerCase() === wanted) return entry;
  }
  return null;
}

/** PURE: one leaderboard response -> the wallet's rank on that board. */
export function projectLeaderboardRank(
  response: LighterLeaderboardResponse,
  walletAddress: string,
): LighterPointsRank {
  const entry = findWalletEntry(response.entries, walletAddress);
  if (entry === null) return { kind: "rank_unavailable" };
  return { kind: "rank", points: entry.points, position: entry.entry };
}

/** PURE: the referral response -> what the card shows. */
export function projectReferralSummary(
  response: LighterReferralPointsResponse,
): LighterReferralSummary {
  return {
    totalPoints: response.user_total_points,
    lastWeekPoints: response.user_last_week_points,
    rewardPoints: response.user_total_referral_reward_points,
    lastWeekRewardPoints: response.user_last_week_referral_reward_points,
    multiplier: response.reward_point_multiplier,
    referralCount: response.referrals.length,
  };
}

/** The four settled reads for one wallet, before projection. */
export interface LighterPointsReadSet {
  readonly allTime: LighterPointsValue<LighterLeaderboardResponse>;
  readonly weekly: LighterPointsValue<LighterLeaderboardResponse>;
  readonly livePoints: LighterPointsValue<LighterLivePointsTotalResponse>;
  readonly referral: LighterPointsValue<LighterReferralPointsResponse>;
}

/**
 * PURE: one wallet plus its four settled reads -> the row the view renders.
 * Each read keeps its own outcome, so a refused leaderboard never blanks the
 * live points beside it.
 */
export function projectPointsRow(
  wallet: LighterPointsWallet,
  reads: LighterPointsReadSet,
  observedAt: string,
): LighterPointsRow {
  return {
    kind: "points",
    walletAddress: wallet.walletAddress,
    environment: wallet.environment,
    accountIndex: wallet.accountIndex,
    allTime: reads.allTime.kind === "value"
      ? projectLeaderboardRank(reads.allTime.value, wallet.walletAddress)
      : reads.allTime,
    weekly: reads.weekly.kind === "value"
      ? projectLeaderboardRank(reads.weekly.value, wallet.walletAddress)
      : reads.weekly,
    livePoints: reads.livePoints.kind === "value"
      ? { kind: "value", value: reads.livePoints.value.total_live_points }
      : reads.livePoints,
    referral: reads.referral.kind === "value"
      ? { kind: "value", value: projectReferralSummary(reads.referral.value) }
      : reads.referral,
    observedAt,
  };
}

/**
 * PURE: a failed provider read -> its reason. A caller abort is NOT mapped
 * here; it is rethrown by the caller so cancellation stays cancellation.
 */
function classifyPointsReadFailure(error: unknown): LighterPointsReadUnavailable {
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      kind: "unavailable",
      reason: "provider_timeout",
      detail: "Lighter did not answer within the read deadline.",
    };
  }
  if (error instanceof VexError) {
    switch (error.code) {
      case ErrorCodes.LIGHTER_TIMEOUT:
        return {
          kind: "unavailable",
          reason: "provider_timeout",
          detail: "Lighter did not answer within the read deadline.",
        };
      case ErrorCodes.LIGHTER_INVALID_RESPONSE:
      case ErrorCodes.LIGHTER_INVALID_REQUEST:
      case ErrorCodes.LIGHTER_NOT_FOUND:
        return {
          kind: "unavailable",
          reason: "provider_refused",
          detail: error.message,
        };
      default:
        return {
          kind: "unavailable",
          reason: "provider_unavailable",
          detail: error.message,
        };
    }
  }
  return {
    kind: "unavailable",
    reason: "provider_unavailable",
    detail: "Lighter could not be reached for this read.",
  };
}

async function settle<T>(
  read: () => Promise<T>,
  callerSignal: AbortSignal,
): Promise<LighterPointsValue<T>> {
  try {
    return { kind: "value", value: await read() };
  } catch (error) {
    // A user cancel is not a provider outcome: it belongs to the caller, and
    // the IPC layer turns it into `internal.cancelled`.
    if (callerSignal.aborted && isAbortError(callerSignal.reason)) throw error;
    return classifyPointsReadFailure(error);
  }
}

/**
 * Read the campaign state for every wallet with a resolved Lighter account.
 *
 * Sequential by design: the wallets are few, the provider rate budget is
 * shared with trading, and a stable order is what the view renders.
 */
export async function readLighterPointsForWallets(
  request: LighterPointsRequest,
): Promise<LighterPointsReport> {
  const deps = request.deps ?? defaultLighterPointsDeps();
  const deadlineMs = request.deadlineMsPerWallet ?? LIGHTER_POINTS_DEADLINE_MS_PER_WALLET;
  const maxWallets = request.maxWallets ?? LIGHTER_POINTS_MAX_WALLETS;
  request.signal.throwIfAborted();

  const listed = await deps.listWallets(maxWallets);
  request.signal.throwIfAborted();
  const rows: LighterPointsRow[] = [];
  for (const wallet of listed.rows) {
    request.signal.throwIfAborted();
    const observedAt = deps.now().toISOString();
    const outcome = await deps.resolveAuth(wallet.environment, wallet.accountIndex);
    request.signal.throwIfAborted();
    if (outcome.kind === "unavailable") {
      // The privileged resolver checks vault lock before looking up this exact
      // environment/account scope. Only an unlocked, absent scope means missing here.
      if (outcome.reason === "no_credential") {
        rows.push({
          kind: "credential_missing_here",
          walletAddress: wallet.walletAddress,
          environment: wallet.environment,
          accountIndex: wallet.accountIndex,
          apiKeyIndex: wallet.apiKeyIndex,
          tradingKeyRegistered: wallet.tradingKeyRegistered,
          observedAt,
        });
        continue;
      }
      rows.push({
        kind: "unavailable",
        walletAddress: wallet.walletAddress,
        environment: wallet.environment,
        accountIndex: wallet.accountIndex,
        reason: outcome.reason,
        detail: outcome.detail,
        observedAt,
      });
      continue;
    }

    // One deadline for the whole wallet, composed with the caller's signal so
    // an abort and a timeout stay distinguishable (`composeDeadline`).
    const signal = composeDeadline(request.signal, deadlineMs) ?? request.signal;
    const auth = outcome.auth;
    const reads: LighterPointsReadSet = {
      allTime: await settle(
        () => deps.client.getLeaderboard(
          wallet.environment,
          { type: "all", l1Address: wallet.walletAddress },
          auth,
          { signal },
        ),
        request.signal,
      ),
      weekly: await settle(
        () => deps.client.getLeaderboard(
          wallet.environment,
          { type: "weekly", l1Address: wallet.walletAddress },
          auth,
          { signal },
        ),
        request.signal,
      ),
      livePoints: await settle(
        () => deps.client.getLivePointsTotal(
          wallet.environment,
          { accountIndex: wallet.accountIndex },
          auth,
          { signal },
        ),
        request.signal,
      ),
      referral: await settle(
        () => deps.client.getReferralPoints(
          wallet.environment,
          { accountIndex: wallet.accountIndex },
          auth,
          { signal },
        ),
        request.signal,
      ),
    };
    rows.push(projectPointsRow(wallet, reads, observedAt));
  }

  return {
    rows,
    walletCount: listed.totalCount,
    observedAt: deps.now().toISOString(),
  };
}
