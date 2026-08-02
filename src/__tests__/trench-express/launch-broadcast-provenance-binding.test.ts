/**
 * WHICH RUN authorizes an unattended launch.
 *
 * The autonomous path read its ceilings by MISSION only, so
 * `readMissionLaunchCeilings` fell back to "whichever run is active right now".
 * A dispatch carrying run A could therefore be gated by run B's frozen
 * snapshot — a different, possibly larger, spend ceiling than the one the host
 * bound to this call. The provenance already names the exact run; it must be
 * the one that is read.
 *
 * The engine-side identity rules (run belongs to this mission, run exists, run
 * is not terminal) live in `launch-ceiling.ts` and are hardened there. What is
 * pinned HERE is the handler contract on top of them: the exact run id is
 * passed through, and every `null` the engine returns becomes a named refusal
 * that signs nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let ceilingsCalls: Array<[string, string | null | undefined]>;
let ceilingsResult: unknown = null;

vi.mock("@vex-agent/engine/mission/launch-ceiling.js", () => ({
  readMissionLaunchCeilings: async (missionId: string, missionRunId?: string | null) => {
    ceilingsCalls.push([missionId, missionRunId]);
    return ceilingsResult;
  },
  countMissionRunLaunches: async () => 0,
  enforceAutonomousLaunchCeilings: () => ({ ok: true }),
  launchChargeableWei: (a: bigint) => a,
}));

const { resolveAuthorizationVariantForTest } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch/execute.js"
);

function context(over: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    missionId: "mission-A",
    missionRunId: "run-7",
    sessionPermission: "full",
    ...over,
  } as never;
}

beforeEach(() => {
  ceilingsCalls = [];
  ceilingsResult = {
    ok: true,
    ceilings: { maxLaunchValueRaw: "1000", maxLaunchValueDecimals: 18, maxLaunchCount: 3 },
  };
});

describe("the autonomous path binds ceilings to the EXACT provenance run", () => {
  it("passes the dispatch's own missionRunId, never letting the active run be chosen", async () => {
    const result = await resolveAuthorizationVariantForTest(context());
    expect(result.ok).toBe(true);
    expect(ceilingsCalls).toEqual([["mission-A", "run-7"]]);
  });

  // Sora's actual refusal literals, copied VERBATIM from
  // `engine/mission/launch-ceiling.ts`. A mocked module returns whatever this
  // test hands it, so asserting on an invented string would pin nothing — the
  // guard below re-reads his source and fails if any of these literals stops
  // existing, which is what makes surfacing them a real contract rather than a
  // self-fulfilling assertion.
  const ENGINE_REFUSALS = [
    "does not exist, so the contract that would ",
    "belongs to a different mission than the one ",
    "is already ",
    "has no readable frozen contract snapshot, so ",
  ] as const;

  it("keeps its copies of the engine's refusal literals honest", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../vex-agent/engine/mission/launch-ceiling.ts", import.meta.url), "utf8"));
    const drifted = ENGINE_REFUSALS.filter((literal) => !source.includes(literal));
    expect(drifted).toEqual([]);
  });

  it.each([
    ["missing run", `Refusing to launch: mission run run-7 does not exist, so the contract that would authorize this launch cannot be read. Nothing was signed.`],
    ["cross-mission run", `Refusing to launch: mission run run-7 belongs to a different mission than the one authorizing this launch. Ceilings are never read across that boundary. Nothing was signed.`],
    ["terminal run", `Refusing to launch: mission run run-7 is already completed. A finished run's contract cannot authorize new spending. Nothing was signed.`],
    ["unreadable snapshot", `Refusing to launch: mission run run-7 has no readable frozen contract snapshot, so its spend ceilings are unknown. An unattended launch with unknown limits is never signed.`],
  ])("surfaces the engine's %s refusal VERBATIM behind the tool id", async (_case, reason) => {
    ceilingsResult = { ok: false, reason };
    const result = await resolveAuthorizationVariantForTest(context());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // Verbatim: the whole sentence survives, only prefixed by the tool it names.
    expect(result.reason).toBe(`trench.launch_execute ${reason}`);
    // Every engine refusal ends by saying nothing was signed — two of them word
    // it as "is never signed", so the pin matches the PROMISE, not one phrasing.
    expect(result.reason).toMatch(/Nothing was signed|never signed/);
  });

  it("refuses a dispatch with no run at all — provenance is required, never inferred", async () => {
    const result = await resolveAuthorizationVariantForTest(context({ missionRunId: null }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("missionRunId");
    // The ceilings read is never even attempted without a bound run.
    expect(ceilingsCalls).toEqual([]);
  });

  it("does not gate the human-approved path on mission ceilings at all", async () => {
    const result = await resolveAuthorizationVariantForTest(
      context({ approvalId: "appr-1", _approvalId: "appr-1" }),
    );
    // A person decided; §C6 explicitly does not gate that path.
    if (result.ok) expect(result.ceilings).toBeNull();
  });
});
