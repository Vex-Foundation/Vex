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
 *
 * SECOND STEP, added with the feature: after the four raw reads, the REAL read
 * model runs against the same live provider and its row is asserted against
 * those raw bytes. A green fixture suite cannot prove that the shipped
 * projection reads the same field the probe measured; this can.
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

  it("projects the same numbers through the shipped read model", { timeout: 120_000 }, async () => {
    if (target === null || evidence === null) throw new Error("The live probe was not set up.");
    const wallet = target.walletAddress;

    // The RAW bytes this run measured, read again so the assertion compares the
    // model against THIS run's provider state rather than a recorded one.
    const rawAll = await read(`/api/v1/leaderboard?type=all&l1_address=${wallet}`, await liveToken());
    const rawWeekly = await read(`/api/v1/leaderboard?type=weekly&l1_address=${wallet}`, await liveToken());
    const rawLive = await read(`/api/v1/livePoints/total?account_index=${EXPECTED_ACCOUNT_INDEX}`, await liveToken());

    const { readLighterPointsForWallets } = await import(
      "@vex-agent/tools/protocols/lighter/points.js"
    );
    const report = await readLighterPointsForWallets({ signal: AbortSignal.timeout(90_000) });
    const row = report.rows.find(
      (candidate) => candidate.walletAddress.toLowerCase() === wallet.toLowerCase(),
    );
    evidence.record("points-read-model", { wallet, accountIndex: EXPECTED_ACCOUNT_INDEX, row });
    if (row === undefined || row.kind !== "points") {
      throw new Error(
        `The read model produced no points row for ${wallet}: ${JSON.stringify(row ?? null)}`,
      );
    }

    const allEntry = walletEntry(rawAll.body, wallet);
    const weeklyEntry = walletEntry(rawWeekly.body, wallet);
    expect(row.allTime).toEqual(
      allEntry === null
        ? { kind: "rank_unavailable" }
        : { kind: "rank", points: allEntry.points, position: allEntry.entry },
    );
    expect(row.weekly).toEqual(
      weeklyEntry === null
        ? { kind: "rank_unavailable" }
        : { kind: "rank", points: weeklyEntry.points, position: weeklyEntry.entry },
    );
    expect(row.livePoints).toEqual({
      kind: "value",
      value: (rawLive.body as { total_live_points: number }).total_live_points,
    });
  });
});

async function liveToken(): Promise<string | null> {
  const { resolveLighterReadOnlyAccountAuth } = await import(
    "@vex-agent/tools/protocols/lighter/read-account-auth.js"
  );
  const auth = await resolveLighterReadOnlyAccountAuth(LIVE_ENVIRONMENT, EXPECTED_ACCOUNT_INDEX);
  return auth?.token ?? null;
}

/** The wallet's own row in a raw leaderboard body, by exact address. */
function walletEntry(
  body: unknown,
  wallet: string,
): { readonly points: number; readonly entry: number } | null {
  if (body === null || typeof body !== "object") return null;
  const entries = (body as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  for (const candidate of entries) {
    if (candidate === null || typeof candidate !== "object") continue;
    const row = candidate as { l1_address?: unknown; points?: unknown; entry?: unknown };
    if (typeof row.l1_address !== "string") continue;
    if (row.l1_address.toLowerCase() !== wallet.toLowerCase()) continue;
    if (typeof row.points !== "number" || typeof row.entry !== "number") continue;
    return { points: row.points, entry: row.entry };
  }
  return null;
}
