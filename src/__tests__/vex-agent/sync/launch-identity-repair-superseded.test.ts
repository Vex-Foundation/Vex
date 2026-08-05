/**
 * D4 — THE THIRD ANSWER THE CHAIN CAN GIVE ABOUT A STAGED CREATE.
 *
 * The owner's live case: launch tx `0x09b84e…e955` was unknown to the RPC ~24 h
 * after broadcast. The sweep could only say `created`, `reverted`, or `null`, so
 * a hash no node had ever heard of was reported exactly like "not mined yet" —
 * re-checked forever, explained never, and invisible in My Launches because
 * `launched_tokens` is written only on confirm.
 *
 * `superseded` is that missing answer. What it does and does not do:
 *
 * - It NEVER terminalizes here. The `superseded_unproven` transition is CLAIM
 *   FENCED (`markSupersededUnproven` requires the lane's `evm_claim_token`), and
 *   a launch's `agent_activity` row is already covered by the EVM pending lane —
 *   which holds that claim and owns both A6 clocks. Two writers for one terminal
 *   transition is precisely the stale-over-fresh race the fence exists to stop,
 *   so this sweep CLASSIFIES and the lane TERMINALIZES.
 * - It is therefore counted as STILL PENDING, not as a failure. Nothing here
 *   establishes that the launch did not happen: a replacement reusing the nonce
 *   may have carried the same calldata and created the token.
 * - It is logged ONCE per state, not once per poll — the runaway-loop lesson.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import logger from "@utils/logger.js";

let pending: unknown[];
let mockConfirm: Mock;
let mockFail: Mock;
let mockRecord: Mock;
let mockStampIdentity: Mock;

function reset(): void {
  pending = [];
  mockConfirm = vi.fn(async () => ({ intentId: "i1" }));
  mockFail = vi.fn(async () => ({ intentId: "i1" }));
  mockRecord = vi.fn(async () => ({ inserted: true }));
  mockStampIdentity = vi.fn(async () => true);
}
reset();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  claimBroadcastPendingForSweep: async () => pending,
  confirmWith: (...a: unknown[]) => mockConfirm(...a),
  failWith: (...a: unknown[]) => mockFail(...a),
}));
vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  record: (...a: unknown[]) => mockRecord(...a),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  stampLaunchOutputIdentityByTxHash: (...a: unknown[]) => mockStampIdentity(...a),
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

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reset();
  vi.restoreAllMocks();
  warnSpy = vi.spyOn(logger, "warn").mockReturnThis();
  infoSpy = vi.spyOn(logger, "info").mockReturnThis();
});

describe("a launch hash no node can account for", () => {
  it("is classified, not terminalized — and never counted as a failure", async () => {
    pending = [INTENT];

    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({ kind: "superseded" }),
    });

    // Still pending: the A6 transition belongs to the claim-holding EVM lane.
    expect(result).toMatchObject({ checked: 1, repaired: 0, indexed: 0, failed: 0, stillPending: 1 });
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
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
      (call: readonly unknown[]) => call[0] === "trench.launch_identity_repair.superseded",
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
