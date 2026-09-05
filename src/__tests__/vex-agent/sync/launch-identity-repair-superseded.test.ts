/**
 * D4 / U5 — THE THIRD ANSWER THE CHAIN CAN GIVE ABOUT A STAGED CREATE, AND WHAT
 * FINALLY ENDS IT.
 *
 * The owner's live case: launch tx `0x09b84e…e955` was unknown to the RPC ~24 h
 * after broadcast. The sweep could only say `created`, `reverted`, or `null`, so
 * a hash no node had ever heard of was reported exactly like "not mined yet" —
 * re-checked forever, explained never, and invisible in My Launches because
 * `launched_tokens` is written only on confirm.
 *
 * `superseded` was that missing answer, and the sweep DEFERRED on it — correctly,
 * because the `superseded_unproven` transition on the sibling `agent_activity`
 * row is claim-fenced and belongs to the pending lane. But nothing then carried
 * the lane's verdict back to the INTENT, so the launch was stuck forever anyway.
 *
 * This file pins both halves of the fix (owner approved changing the previous
 * defer-forever pin):
 *
 * - FRESH `superseded` from the RPC still defers. Unchanged.
 * - The lane's DURABLE verdict on the sibling row is consulted FIRST, before any
 *   provider call, and mirrored onto the intent. That is what works with the RPC
 *   completely unavailable, which is the state a superseded launch is usually
 *   discovered in.
 * - The sibling must be a `token_launch` row. `agent_activity.tx_hash` is
 *   globally unique, so a hash match alone would let a swap's verdict terminalize
 *   a launch.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import logger from "@utils/logger.js";

let pending: unknown[];
let mockConfirm: Mock;
let mockFail: Mock;
let mockRecord: Mock;
let mockStampIdentity: Mock;
let mockFindSibling: Mock;
let mockMarkSuperseded: Mock;

function reset(): void {
  pending = [];
  mockConfirm = vi.fn(async () => ({ intentId: "i1" }));
  mockFail = vi.fn(async () => ({ intentId: "i1" }));
  mockRecord = vi.fn(async () => ({ inserted: true }));
  mockStampIdentity = vi.fn(async () => true);
  mockFindSibling = vi.fn(async () => null);
  mockMarkSuperseded = vi.fn(async () => ({ intentId: "i1" }));
}
reset();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  claimBroadcastPendingForSweep: async () => pending,
  confirmWith: (...a: unknown[]) => mockConfirm(...a),
  failWith: (...a: unknown[]) => mockFail(...a),
  markSupersededUnprovenWith: (...a: unknown[]) => mockMarkSuperseded(...a),
}));
vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  record: (...a: unknown[]) => mockRecord(...a),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  stampLaunchOutputIdentityByTxHash: (...a: unknown[]) => mockStampIdentity(...a),
  findLaunchActivityTerminalByTxHash: (...a: unknown[]) => mockFindSibling(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_s: string, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

const { repairLaunchIdentities } = await import("@vex-agent/sync/launch-identity-repair.js");

const INTENT = {
  intentId: "i1",
  sessionId: "sess-1",
  chainId: 4663,
  walletAddress: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
  name: "Vex",
  symbol: "VEX",
  imageId: "img_01",
  txHash: "0xhash",
  prebuyRaw: "300000000000000",
  prebuyDecimals: 18,
};

/** The dependency a superseded launch is usually discovered WITHOUT. */
const RPC_UNAVAILABLE = {
  resolveLaunchOutcome: async (): Promise<never> => {
    throw new Error("no provider reachable");
  },
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reset();
  vi.restoreAllMocks();
  warnSpy = vi.spyOn(logger, "warn").mockReturnThis();
  infoSpy = vi.spyOn(logger, "info").mockReturnThis();
});

describe("a FRESH superseded classification from the chain", () => {
  it("is classified, not terminalized — and never counted as a failure", async () => {
    pending = [INTENT];

    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "superseded" }),
    });

    // Still pending: the A6 transition belongs to the claim-holding EVM lane.
    expect(result).toMatchObject({
      checked: 1,
      repaired: 0,
      indexed: 0,
      failed: 0,
      supersededMirrored: 0,
      stillPending: 1,
    });
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockMarkSuperseded).not.toHaveBeenCalled();
    // No identity row for a launch nothing proved.
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("says so ONCE, at info — not a warn every thirty seconds forever", async () => {
    pending = [INTENT];

    await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "superseded" }),
    });

    expect(warnSpy).not.toHaveBeenCalled();
    const calls = infoSpy.mock.calls.filter(
      (call: readonly unknown[]) => call[0] === "launch_identity_repair.superseded",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({ intentId: "i1" });
  });

  it("does not claim the launch failed, nor that a retry is safe", async () => {
    pending = [INTENT];

    await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "superseded" }),
    });

    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(logged.toLowerCase()).not.toContain("safe to retry");
    expect(logged.toLowerCase()).not.toContain("nothing was spent");
  });
});

describe("the lane's DURABLE verdict on the sibling activity row", () => {
  it("terminalizes the intent WITHOUT any provider call — the sweep works offline", async () => {
    pending = [INTENT];
    mockFindSibling.mockResolvedValue({ status: "superseded_unproven" });

    const result = await repairLaunchIdentities(RPC_UNAVAILABLE);

    expect(mockFindSibling).toHaveBeenCalledWith("0xhash");
    expect(result).toMatchObject({ checked: 1, supersededMirrored: 1, stillPending: 0, failed: 0 });
    // The CAS is session-scoped AND hash-scoped: the evidence is about ONE hash.
    expect(mockMarkSuperseded).toHaveBeenCalledWith({}, "i1", "sess-1", "0xhash");
    // Never a failure, never an identity.
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("is consulted BEFORE the RPC, so a superseded launch costs no provider call", async () => {
    pending = [INTENT];
    mockFindSibling.mockResolvedValue({ status: "superseded_unproven" });
    const resolveLaunchOutcome = vi.fn(async () => null);

    await repairLaunchIdentities({ resolveLaunchOutcome });

    expect(resolveLaunchOutcome).not.toHaveBeenCalled();
  });

  it("says what is known and refuses to license a relaunch", async () => {
    pending = [INTENT];
    mockFindSibling.mockResolvedValue({ status: "superseded_unproven" });

    await repairLaunchIdentities(RPC_UNAVAILABLE);

    const calls = infoSpy.mock.calls.filter(
      (call: readonly unknown[]) =>
        call[0] === "launch_identity_repair.superseded_mirrored",
    );
    expect(calls).toHaveLength(1);
    const logged = JSON.stringify(calls).toLowerCase();
    expect(logged).toContain("not a failure");
    expect(logged).not.toContain("safe to retry");
    expect(logged).not.toContain("nothing was spent");
  });

  it("counts a CAS miss as still pending, never as a mirror that happened", async () => {
    pending = [INTENT];
    mockFindSibling.mockResolvedValue({ status: "superseded_unproven" });
    mockMarkSuperseded.mockResolvedValue(null);

    const result = await repairLaunchIdentities(RPC_UNAVAILABLE);

    expect(result).toMatchObject({ checked: 1, supersededMirrored: 0, stillPending: 1 });
  });

  it("ignores a sibling that is still pending and falls through to the RPC", async () => {
    pending = [INTENT];
    mockFindSibling.mockResolvedValue({ status: "pending" });
    const resolveLaunchOutcome = vi.fn(async () => null);

    const result = await repairLaunchIdentities({ resolveLaunchOutcome });

    expect(mockMarkSuperseded).not.toHaveBeenCalled();
    expect(resolveLaunchOutcome).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ supersededMirrored: 0, stillPending: 1 });
  });

  it("defers when there is NO sibling row at all", async () => {
    pending = [INTENT];
    mockFindSibling.mockResolvedValue(null);
    const resolveLaunchOutcome = vi.fn(async () => null);

    const result = await repairLaunchIdentities({ resolveLaunchOutcome });

    expect(mockMarkSuperseded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ supersededMirrored: 0, stillPending: 1 });
  });

  it("contains a sibling lookup failure instead of aborting the sweep", async () => {
    pending = [INTENT];
    mockFindSibling.mockRejectedValue(new Error("db down"));
    const resolveLaunchOutcome = vi.fn(async () => null);

    const result = await repairLaunchIdentities({ resolveLaunchOutcome });

    expect(mockMarkSuperseded).not.toHaveBeenCalled();
    expect(resolveLaunchOutcome).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ checked: 1, stillPending: 1 });
  });

  it("still confirms a launch whose sibling is confirmed and whose receipt decodes", async () => {
    pending = [INTENT];
    mockFindSibling.mockResolvedValue({ status: "confirmed" });

    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({
        kind: "created" as const,
        identity: { tokenAddress: "0xtoken" },
      }),
    });

    expect(result).toMatchObject({ repaired: 1, supersededMirrored: 0, stillPending: 0 });
  });
});
