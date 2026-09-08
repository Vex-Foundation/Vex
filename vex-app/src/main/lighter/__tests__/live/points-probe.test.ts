/**
 * LIVE PROBE - the Robinhood Chain points campaign endpoints, read with the
 * account's own read-only authorization the way the app derives it.
 *
 * Gated by `VEX_LIGHTER_LIVE_POINTS=1`. Reads only: leaderboard (all-time,
 * anonymous and authorized, with and without the wallet's l1_address),
 * livePoints/total and referral/points for the owner's account. Records the
 * exact provider responses as evidence so the client, its validators and the
 * Settings view are written from measured bytes, never from the descriptor's
 * examples.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  LIVE_ENVIRONMENT,
  openEvidence,
  requireLiveTarget,
  type EvidenceWriter,
  type LiveTarget,
} from "./harness.js";

const describeLive = flagEnabled("VEX_LIGHTER_LIVE_POINTS") ? describe : describe.skip;
const REST_BASE = "https://api.rh.lighter.xyz";

let disposeSeams: (() => void) | null = null;
let evidence: EvidenceWriter | null = null;
let target: LiveTarget | null = null;

beforeAll(async () => {
  evidence = openEvidence("points-probe");
  target = await requireLiveTarget();
  disposeSeams = await installLighterProductionSeams();
});

afterAll(async () => {
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

async function read(path: string, token: string | null): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${REST_BASE}${path}`, {
    headers: token === null ? {} : { Authorization: token },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* the raw text is the evidence then */ }
  return { status: response.status, body };
}

describeLive("Robinhood Chain points endpoints", () => {
  it("reads the leaderboard, the live points total and the referral points for the owner's account", { timeout: 120_000 }, async () => {
    if (target === null || evidence === null) throw new Error("The live probe was not set up.");
    const { resolveLighterReadOnlyAccountAuth } = await import("@vex-agent/tools/protocols/lighter/read-account-auth.js");
    const auth = await resolveLighterReadOnlyAccountAuth(LIVE_ENVIRONMENT, EXPECTED_ACCOUNT_INDEX);
    expect(auth, "no read-only authorization could be derived for the owner's account").not.toBeNull();
    const token = auth?.token ?? null;
    const wallet = target.walletAddress;

    const anonymousAll = await read("/api/v1/leaderboard?type=all", null);
    const authorizedAll = await read("/api/v1/leaderboard?type=all", token);
    const authorizedAllForWallet = await read(`/api/v1/leaderboard?type=all&l1_address=${wallet}`, token);
    const anonymousAllForWallet = await read(`/api/v1/leaderboard?type=all&l1_address=${wallet}`, null);
    const weeklyForWallet = await read(`/api/v1/leaderboard?type=weekly&l1_address=${wallet}`, token);
    const livePoints = await read(`/api/v1/livePoints/total?account_index=${EXPECTED_ACCOUNT_INDEX}`, token);
    const referralPoints = await read(`/api/v1/referral/points?account_index=${EXPECTED_ACCOUNT_INDEX}`, token);

    evidence.record("points", {
      wallet,
      accountIndex: EXPECTED_ACCOUNT_INDEX,
      anonymousAll,
      authorizedAll,
      authorizedAllForWallet,
      anonymousAllForWallet,
      weeklyForWallet,
      livePoints,
      referralPoints,
    });
    process.stdout.write(`${JSON.stringify({
      event: "lighter.live.points",
      authorizedAll: authorizedAll.body,
      authorizedAllForWallet: authorizedAllForWallet.body,
      anonymousAllForWallet: anonymousAllForWallet.body,
      weeklyForWallet: weeklyForWallet.body,
      livePoints: livePoints.body,
      referralPoints: referralPoints.body,
    })}\n`);

    expect(anonymousAll.status).toBe(200);
    expect(livePoints.status).toBe(200);
    expect(referralPoints.status).toBe(200);
  });
});
