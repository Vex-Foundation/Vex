/**
 * THE POINTS READ MODEL - the projections against the bytes Lighter sent, and
 * the per-wallet outcomes against a typed fake client.
 *
 * THE DEFECT THIS PINS, and it was a real one caught in plan review: the first
 * reading of the probe took `entryId` for the board position. Both fields are
 * int32 in the descriptor and both are present on every row, so nothing but the
 * measurement distinguishes them - the owner's wallet sits at `entry` 22146 on
 * the all-time board with `entryId` 11, and at `entry` 1 on the weekly board
 * with the same `entryId` 11. Reverting the projection to `entryId` turns these
 * assertions red.
 *
 * The other two invariants here: a wallet whose authorization cannot be minted
 * is LISTED with its reason (never dropped, never zero), and one failing read
 * never blanks the other three.
 */

import { describe, expect, it, vi } from "vitest";

import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type {
  LighterLeaderboardResponse,
  LighterLivePointsTotalResponse,
  LighterReferralPointsResponse,
} from "@tools/lighter/types.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import {
  findWalletEntry,
  projectLeaderboardRank,
  projectPointsRow,
  projectReferralSummary,
  readLighterPointsForWallets,
  type LighterPointsClient,
  type LighterPointsDeps,
  type LighterPointsWallet,
} from "@vex-agent/tools/protocols/lighter/points.js";
import type { LighterReadOnlyAccountAuthOutcome } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { ACCOUNT_INDEX, POINTS_FIXTURE, WALLET } from "../../lighter/points-fixture.js";

const OBSERVED_AT = "2026-09-08T12:18:01.851Z";

const WALLET_ROW: LighterPointsWallet = {
  walletAddress: WALLET,
  environment: "rhc",
  accountIndex: ACCOUNT_INDEX,
  apiKeyIndex: 4,
  tradingKeyRegistered: true,
};

/**
 * A typed client double: only the three methods the read model calls, each
 * returning whatever the scenario scripted. Scripting by method keeps the
 * "one read fails, the rest still report" case honest.
 */
interface ScriptedReads {
  readonly leaderboard: (type: string) => Promise<LighterLeaderboardResponse>;
  readonly livePoints: () => Promise<LighterLivePointsTotalResponse>;
  readonly referral: () => Promise<LighterReferralPointsResponse>;
}

function fakeClient(script: ScriptedReads): {
  readonly client: LighterPointsClient;
  readonly signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const record = (options?: { readonly signal?: AbortSignal }): void => {
    if (options?.signal !== undefined) signals.push(options.signal);
  };
  const client: LighterPointsClient = {
    getLeaderboard: async (_environment, params, _auth, options) => {
      record(options);
      return script.leaderboard(params.type);
    },
    getLivePointsTotal: async (_environment, _params, _auth, options) => {
      record(options);
      return script.livePoints();
    },
    getReferralPoints: async (_environment, _params, _auth, options) => {
      record(options);
      return script.referral();
    },
  };
  return { client, signals };
}

function healthyScript(): ScriptedReads {
  return {
    leaderboard: async (type) =>
      type === "weekly" ? POINTS_FIXTURE.weeklyForWallet : POINTS_FIXTURE.authorizedAllForWallet,
    livePoints: async () => POINTS_FIXTURE.livePoints,
    referral: async () => POINTS_FIXTURE.referralPoints,
  };
}

function deps(input: {
  readonly script?: ScriptedReads;
  readonly wallets?: readonly LighterPointsWallet[];
  readonly totalCount?: number;
  readonly auth?: (
    environment: LighterEnvironment,
    accountIndex: number,
  ) => Promise<LighterReadOnlyAccountAuthOutcome>;
}): { readonly deps: LighterPointsDeps; readonly signals: AbortSignal[] } {
  const wallets = input.wallets ?? [WALLET_ROW];
  const { client, signals } = fakeClient(input.script ?? healthyScript());
  return {
    deps: {
      client,
      listWallets: async () => ({
        rows: wallets,
        totalCount: input.totalCount ?? wallets.length,
      }),
      resolveAuth: input.auth
        ?? (async (_environment, accountIndex) => ({
          kind: "auth",
          auth: { token: "read-only-token", accountIndex },
        })),
      now: () => new Date(OBSERVED_AT),
    },
    signals,
  };
}

describe("finding the wallet's own row", () => {
  it("matches the full address, case-insensitively", () => {
    const entry = findWalletEntry(
      POINTS_FIXTURE.authorizedAllForWallet.entries,
      WALLET.toLowerCase(),
    );
    expect(entry?.entry).toBe(22146);
  });

  it("never matches a masked row", () => {
    // Every foreign row arrives as `0x9C****...`. A prefix comparison would
    // attribute a stranger's 19995 points to a wallet starting 0x9C.
    expect(
      findWalletEntry(
        POINTS_FIXTURE.anonymousAllForWallet.entries,
        "0x9C99999999999999999999999999999999999999",
      ),
    ).toBeNull();
    expect(
      findWalletEntry(POINTS_FIXTURE.anonymousAllForWallet.entries, WALLET),
    ).toBeNull();
  });

  it("refuses a malformed address instead of scanning for a partial match", () => {
    expect(findWalletEntry(POINTS_FIXTURE.weeklyForWallet.entries, "0x33eF")).toBeNull();
  });
});

describe("the rank projection", () => {
  it("reads the board position from `entry`, as measured on both boards", () => {
    expect(projectLeaderboardRank(POINTS_FIXTURE.authorizedAllForWallet, WALLET)).toEqual({
      kind: "rank",
      points: 0.00004470142,
      position: 22146,
    });
    expect(projectLeaderboardRank(POINTS_FIXTURE.weeklyForWallet, WALLET)).toEqual({
      kind: "rank",
      points: 0,
      position: 1,
    });
  });

  it("reports an absent row as rank_unavailable, never as zero points", () => {
    expect(projectLeaderboardRank(POINTS_FIXTURE.anonymousAllForWallet, WALLET)).toEqual({
      kind: "rank_unavailable",
    });
  });
});

describe("the referral projection", () => {
  it("keeps the provider's multiplier string and counts the referrals", () => {
    expect(projectReferralSummary(POINTS_FIXTURE.referralPoints)).toEqual({
      totalPoints: 0,
      lastWeekPoints: 0,
      rewardPoints: 0,
      lastWeekRewardPoints: 0,
      multiplier: "0.1000",
      referralCount: 0,
    });
  });
});

describe("projecting one wallet's row", () => {
  it("keeps every settled read's own outcome side by side", () => {
    const row = projectPointsRow(
      WALLET_ROW,
      {
        allTime: { kind: "value", value: POINTS_FIXTURE.authorizedAllForWallet },
        weekly: { kind: "value", value: POINTS_FIXTURE.weeklyForWallet },
        livePoints: {
          kind: "unavailable",
          reason: "provider_timeout",
          detail: "Lighter did not answer within the read deadline.",
        },
        referral: { kind: "value", value: POINTS_FIXTURE.referralPoints },
      },
      OBSERVED_AT,
    );

    expect(row).toEqual({
      kind: "points",
      walletAddress: WALLET,
      environment: "rhc",
      accountIndex: ACCOUNT_INDEX,
      allTime: { kind: "rank", points: 0.00004470142, position: 22146 },
      weekly: { kind: "rank", points: 0, position: 1 },
      livePoints: {
        kind: "unavailable",
        reason: "provider_timeout",
        detail: "Lighter did not answer within the read deadline.",
      },
      referral: {
        kind: "value",
        value: {
          totalPoints: 0,
          lastWeekPoints: 0,
          rewardPoints: 0,
          lastWeekRewardPoints: 0,
          multiplier: "0.1000",
          referralCount: 0,
        },
      },
      observedAt: OBSERVED_AT,
    });
  });
});

describe("reading the campaign for every registered wallet", () => {
  it("reports both boards, the live total and the referral rewards for a healthy wallet", async () => {
    const { deps: healthy } = deps({});
    const report = await readLighterPointsForWallets({
      signal: new AbortController().signal,
      deps: healthy,
    });

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    if (row.kind !== "points") throw new Error("expected a points row");
    expect(row.allTime).toEqual({ kind: "rank", points: 0.00004470142, position: 22146 });
    expect(row.weekly).toEqual({ kind: "rank", points: 0, position: 1 });
    expect(row.livePoints).toEqual({ kind: "value", value: 0.00004470142118493782 });
    expect(row.referral).toEqual({
      kind: "value",
      value: {
        totalPoints: 0,
        lastWeekPoints: 0,
        rewardPoints: 0,
        lastWeekRewardPoints: 0,
        multiplier: "0.1000",
        referralCount: 0,
      },
    });
    expect(row.observedAt).toBe(OBSERVED_AT);
  });

  it("keeps a registered account missing its local key beside a readable sibling", async () => {
    const missing = { ...WALLET_ROW, accountIndex: 123, walletAddress: "0x1111111111111111111111111111111111111111" };
    const { deps: mixed, signals } = deps({
      wallets: [missing, WALLET_ROW],
      auth: async (_environment, accountIndex) => accountIndex === missing.accountIndex
        ? { kind: "unavailable", reason: "no_credential", detail: "No local credential." }
        : { kind: "auth", auth: { token: "test-read-authorization", accountIndex } },
    });
    const report = await readLighterPointsForWallets({ signal: new AbortController().signal, deps: mixed });
    expect(report.walletCount).toBe(2);
    expect(report.rows[0]).toEqual({ ...missing, kind: "credential_missing_here", observedAt: OBSERVED_AT });
    expect(report.rows[1]).toMatchObject({ kind: "points", accountIndex: ACCOUNT_INDEX });
    expect(signals).toHaveLength(4);
  });

  it("does not invent a registered key for an account still awaiting registration", async () => {
    const wallet = { ...WALLET_ROW, apiKeyIndex: null, tradingKeyRegistered: false };
    const { deps: missing } = deps({ wallets: [wallet], auth: async () => ({
      kind: "unavailable", reason: "no_credential", detail: "No local credential.",
    }) });
    const report = await readLighterPointsForWallets({ signal: new AbortController().signal, deps: missing });
    expect(report.rows).toEqual([{ ...wallet, kind: "credential_missing_here", observedAt: OBSERVED_AT }]);
  });

  it("lists a wallet whose vault is locked, with the reason, instead of dropping it", async () => {
    const { deps: locked } = deps({
      auth: async () => ({
        kind: "unavailable",
        reason: "vault_locked",
        detail: "Vex is locked.",
      }),
    });
    const report = await readLighterPointsForWallets({
      signal: new AbortController().signal,
      deps: locked,
    });
    expect(report.rows).toEqual([
      {
        kind: "unavailable",
        walletAddress: WALLET,
        environment: "rhc",
        accountIndex: ACCOUNT_INDEX,
        reason: "vault_locked",
        detail: "Vex is locked.",
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it("keeps the three healthy reads when one is refused", async () => {
    const { deps: partial } = deps({
      script: {
        ...healthyScript(),
        livePoints: async () => {
          throw new VexError(ErrorCodes.LIGHTER_INVALID_RESPONSE, "Lighter refused the read.");
        },
      },
    });
    const report = await readLighterPointsForWallets({
      signal: new AbortController().signal,
      deps: partial,
    });
    const row = report.rows[0];
    if (row.kind !== "points") throw new Error("expected a points row");
    expect(row.livePoints).toEqual({
      kind: "unavailable",
      reason: "provider_refused",
      detail: "Lighter refused the read.",
    });
    // The other three still carry their measured values.
    expect(row.allTime).toEqual({ kind: "rank", points: 0.00004470142, position: 22146 });
    expect(row.weekly).toEqual({ kind: "rank", points: 0, position: 1 });
    expect(row.referral.kind).toBe("value");
  });

  it("classifies an unreachable provider apart from a refusal", async () => {
    const { deps: down } = deps({
      script: {
        ...healthyScript(),
        referral: async () => {
          throw new VexError(ErrorCodes.LIGHTER_API_ERROR, "Lighter RHC server error.");
        },
      },
    });
    const report = await readLighterPointsForWallets({
      signal: new AbortController().signal,
      deps: down,
    });
    const row = report.rows[0];
    if (row.kind !== "points") throw new Error("expected a points row");
    expect(row.referral).toEqual({
      kind: "unavailable",
      reason: "provider_unavailable",
      detail: "Lighter RHC server error.",
    });
  });

  it("reports a per-read timeout without turning it into a refusal", async () => {
    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    const { deps: slow } = deps({
      script: {
        ...healthyScript(),
        leaderboard: async () => {
          throw timeout;
        },
      },
    });
    const report = await readLighterPointsForWallets({
      signal: new AbortController().signal,
      deps: slow,
    });
    const row = report.rows[0];
    if (row.kind !== "points") throw new Error("expected a points row");
    expect(row.allTime).toEqual({
      kind: "unavailable",
      reason: "provider_timeout",
      detail: "Lighter did not answer within the read deadline.",
    });
  });

  it("performs at most four provider reads per wallet, in the listed order", async () => {
    const seen: string[] = [];
    const script: ScriptedReads = {
      leaderboard: async (type) => {
        seen.push(`leaderboard:${type}`);
        return type === "weekly"
          ? POINTS_FIXTURE.weeklyForWallet
          : POINTS_FIXTURE.authorizedAllForWallet;
      },
      livePoints: async () => {
        seen.push("livePoints");
        return POINTS_FIXTURE.livePoints;
      },
      referral: async () => {
        seen.push("referral");
        return POINTS_FIXTURE.referralPoints;
      },
    };
    const second: LighterPointsWallet = {
      walletAddress: "0x1111111111111111111111111111111111111111",
      environment: "core",
      accountIndex: 7,
      apiKeyIndex: null,
      tradingKeyRegistered: false,
    };
    const { deps: two } = deps({ script, wallets: [WALLET_ROW, second] });
    const report = await readLighterPointsForWallets({
      signal: new AbortController().signal,
      deps: two,
    });
    expect(seen).toEqual([
      "leaderboard:all",
      "leaderboard:weekly",
      "livePoints",
      "referral",
      "leaderboard:all",
      "leaderboard:weekly",
      "livePoints",
      "referral",
    ]);
    expect(report.rows.map((row) => row.walletAddress)).toEqual([
      WALLET,
      second.walletAddress,
    ]);
  });

  it("propagates a caller abort instead of reporting a provider failure", async () => {
    const controller = new AbortController();
    const { deps: aborting } = deps({
      script: {
        ...healthyScript(),
        leaderboard: async () => {
          controller.abort();
          controller.signal.throwIfAborted();
          return POINTS_FIXTURE.weeklyForWallet;
        },
      },
    });
    await expect(
      readLighterPointsForWallets({ signal: controller.signal, deps: aborting }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops before the next wallet once the caller aborts", async () => {
    const controller = new AbortController();
    const listWallets = vi.fn(async () => ({
      rows: [WALLET_ROW],
      totalCount: 1,
    }));
    const { deps: base } = deps({});
    controller.abort();
    await expect(
      readLighterPointsForWallets({
        signal: controller.signal,
        deps: { ...base, listWallets },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(listWallets).not.toHaveBeenCalled();
  });

  it("keeps cancellation during local authorization from publishing a missing row", async () => {
    const controller = new AbortController();
    const { deps: cancelling, signals } = deps({ auth: async () => {
      controller.abort();
      return { kind: "unavailable", reason: "no_credential", detail: "No local credential." };
    } });
    await expect(readLighterPointsForWallets({ signal: controller.signal, deps: cancelling }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(signals).toHaveLength(0);
  });

  it("hands every provider read a signal that carries both the caller and the deadline", async () => {
    const controller = new AbortController();
    const { deps: healthy, signals } = deps({});
    await readLighterPointsForWallets({
      signal: controller.signal,
      deps: healthy,
      deadlineMsPerWallet: 5_000,
    });
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal !== controller.signal)).toBe(true);
    controller.abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("reports how many registered wallets exist when the bounded page left some out", async () => {
    const { deps: bounded } = deps({ totalCount: 12 });
    const report = await readLighterPointsForWallets({
      signal: new AbortController().signal,
      deps: bounded,
      maxWallets: 1,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.walletCount).toBe(12);
  });
});
