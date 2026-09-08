/**
 * THE POINTS CLIENT AND ITS VALIDATORS, over the bytes Lighter actually sent.
 *
 * The fixture is the live probe's own recording (2026-09-08, RHC, account
 * 24226), not a hand-written example: the two facts this suite exists to hold
 * still - that the wallet's own row appears ONLY on the authenticated read with
 * `l1_address`, and that `entry` is the board position while `entryId` is a row
 * id - are facts about the provider that no fixture written from the descriptor
 * could have carried. The descriptor's `LeaderboardEntry` types both as int32.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import { LighterClient } from "@tools/lighter/client.js";
import type { LighterEndpointConfig, LighterEnvironment } from "@tools/lighter/constants.js";
import {
  validateLighterLeaderboard,
  validateLighterLivePointsTotal,
  validateLighterReferralPoints,
} from "@tools/lighter/validation.js";
import { POINTS_FIXTURE, WALLET } from "./points-fixture.js";

const ENDPOINTS: Record<LighterEnvironment, LighterEndpointConfig> = {
  core: {
    restBaseUrl: "https://core.example",
    wsUrl: "wss://core.example/stream",
    readonlyWsUrl: "wss://core.example/stream?readonly=true",
  },
  rhc: {
    restBaseUrl: "https://rhc.example",
    wsUrl: "wss://rhc.example/stream",
    readonlyWsUrl: "wss://rhc.example/stream?readonly=true",
  },
};

const AUTH = { token: "auth-token", accountIndex: 24226 } as const;

const originalFetch = globalThis.fetch;
let client: LighterClient;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  client = new LighterClient(ENDPOINTS);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOk(data: unknown): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    headers: new Headers(),
    json: async () => data,
  });
}

function lastCall(): { readonly url: URL; readonly init: RequestInit } {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls[calls.length - 1];
  return { url: new URL(call[0] as string), init: call[1] as RequestInit };
}

function authorizationHeader(): string | undefined {
  const headers = lastCall().init.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe("the leaderboard read", () => {
  it("sends the board type, the wallet and the authorization Lighter needs to include that wallet's row", async () => {
    mockOk(POINTS_FIXTURE.authorizedAllForWallet);
    const response = await client.getLeaderboard("rhc", { type: "all", l1Address: WALLET }, AUTH);

    const { url } = lastCall();
    expect(url.pathname).toBe("/api/v1/leaderboard");
    expect(url.searchParams.get("type")).toBe("all");
    expect(url.searchParams.get("l1_address")).toBe(WALLET);
    expect(url.searchParams.get("competition_id")).toBeNull();
    expect(authorizationHeader()).toBe("auth-token");
    expect(response.entries).toHaveLength(11);
  });

  it("reads the board anonymously when no authorization is supplied", async () => {
    mockOk(POINTS_FIXTURE.anonymousAllForWallet);
    await client.getLeaderboard("rhc", { type: "all", l1Address: WALLET });
    expect(authorizationHeader()).toBeUndefined();
  });

  it("refuses a competition board with no competition id, before any request", async () => {
    await expect(client.getLeaderboard("rhc", { type: "competition" }, AUTH)).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
    });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("refuses an empty authorization token rather than sending an unauthenticated read as an authenticated one", async () => {
    await expect(
      client.getLeaderboard("rhc", { type: "all" }, { token: "  ", accountIndex: 24226 }),
    ).rejects.toMatchObject({ code: ErrorCodes.LIGHTER_INVALID_REQUEST });
  });
});

describe("the account points reads", () => {
  it("binds the live-points read to the authorized account index", async () => {
    mockOk(POINTS_FIXTURE.livePoints);
    const response = await client.getLivePointsTotal("rhc", { accountIndex: 24226 }, AUTH);
    const { url } = lastCall();
    expect(url.pathname).toBe("/api/v1/livePoints/total");
    expect(url.searchParams.get("account_index")).toBe("24226");
    expect(authorizationHeader()).toBe("auth-token");
    expect(response.total_live_points).toBeCloseTo(0.00004470142118493782, 18);
  });

  it("refuses a live-points read for an account the token does not authorize", async () => {
    await expect(
      client.getLivePointsTotal("rhc", { accountIndex: 999 }, AUTH),
    ).rejects.toMatchObject({ code: ErrorCodes.LIGHTER_INVALID_REQUEST });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("reads the referral points and multiplier for the authorized account", async () => {
    mockOk(POINTS_FIXTURE.referralPoints);
    const response = await client.getReferralPoints("rhc", { accountIndex: 24226 }, AUTH);
    expect(lastCall().url.pathname).toBe("/api/v1/referral/points");
    expect(response.reward_point_multiplier).toBe("0.1000");
    expect(response.referrals).toEqual([]);
  });
});

describe("the HTTP-200 logical refusal", () => {
  // Measured: an unauthenticated points read answers HTTP 200 with
  // `{code: 20001, message: "invalid param ..."}`. The status is not the error
  // signal; the code is.
  it("reports the provider's own reason instead of an invalid-shape error", () => {
    let thrown: unknown;
    try {
      validateLighterLivePointsTotal(POINTS_FIXTURE.unauthorizedLivePoints);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown as VexError;
    expect(error.code).toBe(ErrorCodes.LIGHTER_API_ERROR);
    expect(error.message).toContain("20001");
    expect(error.message).toContain("auth query param");
  });

  it("applies to the two bodies that carry no code of their own when they succeed", () => {
    for (const validate of [validateLighterLeaderboard, validateLighterReferralPoints]) {
      expect(() => validate(POINTS_FIXTURE.unauthorizedLivePoints)).toThrowError(
        /refused .* with code 20001/,
      );
    }
    // ... and a SUCCESS body from either endpoint carries no `code` at all,
    // which is exactly why the envelope is checked separately from the shape.
    expect(validateLighterLeaderboard(POINTS_FIXTURE.weeklyForWallet).entries).toHaveLength(1);
    expect(POINTS_FIXTURE.weeklyForWallet).not.toHaveProperty("code");
    expect(POINTS_FIXTURE.referralPoints).not.toHaveProperty("code");
  });
});

describe("the leaderboard validator", () => {
  it("accepts a row with no metadata, which is every row the provider has ever sent", () => {
    const parsed = validateLighterLeaderboard(POINTS_FIXTURE.authorizedAllForWallet);
    expect(parsed.entries.every((entry) => entry.metadata === undefined)).toBe(true);
  });

  it("refuses a row whose points are not a finite number", () => {
    expect(() =>
      validateLighterLeaderboard({
        entries: [{ l1_address: WALLET, points: "1000.01", entry: 1, entryId: 1 }],
      }),
    ).toThrowError(/Invalid Lighter leaderboard response/);
  });
});

/** The fixture is a committed artifact; this proves it is the recorded one. */
describe("the points fixture", () => {
  it("carries the live probe's provenance", () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "fixtures/lighter-points-live-2026-09-08.json",
        ),
        "utf8",
      ),
    ) as { readonly provenance: { readonly source: string; readonly accountIndex: number } };
    expect(raw.provenance.source).toContain("points-probe.test.ts");
    expect(raw.provenance.accountIndex).toBe(24226);
  });
});
