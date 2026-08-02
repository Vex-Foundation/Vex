/**
 * A locker image deleted between planning and the authorize write.
 *
 * The intent writers now fail closed (`LaunchImageMissingError`, rolled back),
 * which is correct — but a raw repo error reaching the agent as a generic tool
 * failure tells it nothing it can act on. This is a NAMED, recoverable
 * situation with one obvious remedy, so it gets the repo's named-refusal shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

import { LaunchImageMissingError } from "@vex-agent/db/repos/launch-image-lock.js";

const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");

let createThrows: unknown = null;
let runStatus: string | null = "running";
let statusQueries: unknown[][] = [];

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[]) => {
      statusQueries.push([sql, params]);
      return { rows: runStatus === null ? [] : [{ status: runStatus }] };
    },
  }),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: async () => undefined,
}));
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  createWith: async () => { if (createThrows) throw createThrows; return { intentId: "i1" }; },
  consumeIfAuthorizedWith: async () => ({ intentId: "i1" }),
  failWith: async () => ({ intentId: "i1" }),
}));
vi.mock("@vex-agent/engine/mission/launch-ceiling.js", () => ({
  countMissionRunLaunches: async () => 0,
}));

const { authorizeAndConsumeLaunch } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch/execute/authorize.js"
);

function input() {
  return {
    intentId: "i1",
    authorizationId: "auth-1",
    sessionId: "sess-1",
    walletAddress: WALLET,
    missionRunId: null,
    isAutonomous: false,
    ceilings: null,
    request: {
      name: "Vex",
      symbol: "VEX",
      description: "d",
      links: [],
      imageId: "img_01",
      prebuyWei: 0n,
    },
  } as never;
}

beforeEach(() => { createThrows = null; });

describe("a deleted locker image refuses BY NAME", () => {
  it("returns the named refusal instead of a generic tool error", async () => {
    createThrows = new LaunchImageMissingError("img_01");
    const result = await authorizeAndConsumeLaunch(input());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("Trench Photos locker");
    expect(result.reason).toContain("img_01");
    expect(result.reason).toContain("Nothing was signed");
    // The remedy the user can actually act on.
    expect(result.reason.toLowerCase()).toContain("upload");
  });

  it("does NOT swallow other errors — an unknown failure still propagates", async () => {
    createThrows = new Error("connection reset");
    await expect(authorizeAndConsumeLaunch(input())).rejects.toThrow("connection reset");
  });

  it("authorizes normally when the image is still there", async () => {
    const result = await authorizeAndConsumeLaunch(input());
    expect(result.ok).toBe(true);
  });
});

/**
 * THE LIVENESS GATE: a user Stop landing mid-call must not be outrun by the
 * signature.
 *
 * Nothing in the tool path re-checked run status before signing, so a Stop
 * during a long launch call stopped the runner and not the transaction. This is
 * NOT a second ceilings read — the frozen contract cannot drift — it is an
 * authority check, and it lives inside the transaction that already holds the
 * session lock so a Stop cannot slip between the check and the consume.
 */
describe("a mission run that went terminal mid-call cannot authorize a signature", () => {
  const autonomous = () => ({
    ...(input() as Record<string, unknown>),
    isAutonomous: true,
    missionRunId: "run-7",
    ceilings: { maxLaunchValueRaw: "1000", maxLaunchValueDecimals: 18, maxLaunchCount: 3 },
  }) as never;

  it("refuses by name when the run was stopped while the call was in flight", async () => {
    runStatus = "stopped";
    const result = await authorizeAndConsumeLaunch(autonomous());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("run-7");
    expect(result.reason).toContain("Nothing was signed");
    // Read under the SAME lock as the count CAS.
    expect(statusQueries.some(([sql]) => String(sql).includes("mission_runs"))).toBe(true);
  });

  it("passes a run that is still live", async () => {
    runStatus = "running";
    expect((await authorizeAndConsumeLaunch(autonomous())).ok).toBe(true);
  });

  // ALLOWLIST, not denylist (Codex final-arc round 5): only ACTIVE_RUN_STATUSES
  // may authorize. A paused run must stop spending at the next safe checkpoint
  // — pre-sign IS that checkpoint — and an unknown/corrupt status is no
  // evidence of authority at all.
  for (const paused of [
    "paused_approval", "paused_wake", "paused_error", "paused_user",
    "paused_plan_acceptance", "paused_user_form",
  ]) {
    it(`refuses a ${paused} run — paused means no new spending`, async () => {
      runStatus = paused;
      const result = await authorizeAndConsumeLaunch(autonomous());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.reason).toContain("run-7");
      expect(result.reason).toContain("Nothing was signed");
    });
  }

  it("refuses an unknown/corrupt status literal", async () => {
    runStatus = "corrupted_nonsense";
    const result = await authorizeAndConsumeLaunch(autonomous());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("Nothing was signed");
  });

  it("does not gate the human-approved path — no run, no liveness question", async () => {
    runStatus = "stopped";
    // `isAutonomous: false` with no run id: a person authorized this.
    expect((await authorizeAndConsumeLaunch(input())).ok).toBe(true);
  });

  it("FAILS CLOSED when the run row has vanished — absence is not authority", async () => {
    // A missing row is not an ambiguous status, it is the absence of the thing
    // that grants authority, and the permissive reading of no evidence is the
    // wrong one on a signing path.
    //
    // It also keeps the two checkpoints in agreement: the plan-time ceilings
    // read already refuses a nonexistent run, so letting absence pass HERE
    // would treat a row that disappeared between the two checks as more
    // trustworthy than one that was already gone at the first.
    runStatus = null;
    const result = await authorizeAndConsumeLaunch(autonomous());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("run-7");
    expect(result.reason).toContain("Nothing was signed");
  });
});
