/**
 * The live points probe's recorded bodies, typed for the suites that read them.
 *
 * A helper module, not a spec: both the client suite and the read-model suite
 * assert against the SAME recorded bytes, so a projection and a validator can
 * never be proven against two different versions of what the provider said.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  LighterLeaderboardResponse,
  LighterLivePointsTotalResponse,
  LighterReferralPointsResponse,
} from "@tools/lighter/types.js";

interface PointsFixture {
  readonly authorizedAllForWallet: LighterLeaderboardResponse;
  readonly anonymousAllForWallet: LighterLeaderboardResponse;
  readonly weeklyForWallet: LighterLeaderboardResponse;
  readonly livePoints: LighterLivePointsTotalResponse;
  readonly referralPoints: LighterReferralPointsResponse;
  /** The HTTP-200 logical refusal an unauthenticated points read receives. */
  readonly unauthorizedLivePoints: { readonly code: number; readonly message: string };
}

export const POINTS_FIXTURE: PointsFixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures/lighter-points-live-2026-09-08.json"),
    "utf8",
  ),
) as PointsFixture;

/** The wallet the probe queried; the repo-wide test wallet. */
export const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
export const ACCOUNT_INDEX = 24226;
