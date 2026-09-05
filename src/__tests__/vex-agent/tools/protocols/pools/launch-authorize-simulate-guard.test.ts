/**
 * The authorization owner refuses a simulated plan ITSELF.
 *
 * `poolsLaunchExecuteHandler` returns before authorizing under `simulateOnly`,
 * and `launch-execute-authorization.test.ts` proves that. This file proves the
 * other half: `authorizeAndConsumePoolsLaunch` is exported, and a direct or
 * future caller handing it a plan flagged `simulateOnly` must get a refusal
 * BEFORE any transaction opens - no session lock, no intent row, no CAS consume.
 * A plan built with no signer and reported as "nothing was signed" can never
 * become a row a broadcast consumes (Codex final review of PR1, 2026-09-04).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import * as dbClient from "@vex-agent/db/client.js";
import * as intents from "@vex-agent/db/repos/token-launch-intents.js";
import * as lease from "@vex-agent/engine/runtime/lease-and-status.js";
import { authorizeAndConsumePoolsLaunch } from "@vex-agent/tools/protocols/pools/handlers/launch/execute/authorize.js";
import type { PoolsLaunchPlan } from "@vex-agent/tools/protocols/pools/handlers/launch/execute/plan.js";
import type { PoolsLaunchAuthorization } from "@vex-agent/tools/protocols/pools/handlers/launch/authorization.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authorizeAndConsumePoolsLaunch refuses a simulateOnly plan before any write", () => {
  it("returns a named refusal and touches neither the lock, the writers nor the consumer", async () => {
    const tx = vi.spyOn(dbClient, "withTransaction");
    const lock = vi.spyOn(lease, "acquireSessionControlLock");
    const create = vi.spyOn(intents, "createWith");
    const consume = vi.spyOn(intents, "consumeIfAuthorizedWith");

    // Only the flag is read before the refusal, so the rest of the plan is
    // deliberately absent: a guard that reached into `binding` would throw here
    // instead of refusing, which is itself the regression this test catches.
    const plan = { simulateOnly: true } as unknown as PoolsLaunchPlan;

    const result = await authorizeAndConsumePoolsLaunch({
      intentId: "intent-simulated",
      authorizationId: "auth-simulated",
      sessionId: "session-1",
      missionRunId: null,
      plan,
      authorizationKind: "session_full",
      ceilings: null,
      authorization: {} as PoolsLaunchAuthorization,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("simulateOnly");
    expect(result.reason).toContain("must never be signed");
    expect(tx, "no transaction may open").not.toHaveBeenCalled();
    expect(lock, "no session lock may be taken").not.toHaveBeenCalled();
    expect(create, "no intent row may be written").not.toHaveBeenCalled();
    expect(consume, "no authorization may be consumed").not.toHaveBeenCalled();
  });
});
