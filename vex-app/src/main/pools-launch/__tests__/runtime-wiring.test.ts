/**
 * THE SWAP ITSELF: `getPoolsLaunchRuntime()` is bound to the seven published
 * implementations, and to nothing else.
 *
 * This is the one test that looks at the real seam rather than a fake. It pins
 * the two things the swap can get wrong and a type cannot catch, because all
 * seven implementations share the same shape family:
 *
 *  1. a method that is WIRED TO THE WRONG IMPLEMENTATION — `claim` reaching
 *     `previewClaim` typechecks perfectly and would simulate a payout while
 *     reporting it as executed;
 *  2. a method that DROPS or REORDERS its arguments, which for `deploy` means
 *     signing for a session other than the caller's.
 *
 * The agent module is mocked, so nothing here loads the provider client, the
 * verifier or the database. What is asserted is the wiring.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const implementations = {
  preparePoolsLaunch: vi.fn(),
  deployPoolsLaunch: vi.fn(),
  cancelPoolsLaunch: vi.fn(),
  previewPoolsClaim: vi.fn(),
  claimPoolsFees: vi.fn(),
  listPoolsMyLaunches: vi.fn(),
  getAwaitingPoolsLaunchForm: vi.fn(),
};

vi.mock("@vex-agent/tools/protocols/pools/launch.js", () => implementations);

const { getPoolsLaunchRuntime } = await import("../runtime.js");

const SESSION = {
  sessionId: "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e",
  walletAddress: `0x${"1".repeat(40)}` as const,
};

/** Every method, the implementation it must reach, and the inputs it forwards. */
const WIRING = [
  ["prepare", implementations.preparePoolsLaunch, { name: "Moon" }],
  ["deploy", implementations.deployPoolsLaunch, { fingerprintId: "fp_1" }],
  ["cancel", implementations.cancelPoolsLaunch, { fingerprintId: "fp_1" }],
  ["previewClaim", implementations.previewPoolsClaim, { tokenAddress: `0x${"a".repeat(40)}` }],
  ["claim", implementations.claimPoolsFees, { tokenAddress: `0x${"a".repeat(40)}` }],
  ["myLaunches", implementations.listPoolsMyLaunches, { limit: 5 }],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPoolsLaunchRuntime", () => {
  it("exposes all seven contract methods and no eighth", () => {
    expect(Object.keys(getPoolsLaunchRuntime()).sort()).toEqual([
      "cancel",
      "claim",
      "deploy",
      "getAwaiting",
      "myLaunches",
      "prepare",
      "previewClaim",
    ]);
  });

  it.each(WIRING)(
    "%s reaches its own implementation with the session first and the inputs second",
    async (method, implementation, inputs) => {
      implementation.mockResolvedValue({ ok: true, value: "sentinel" });

      const runtime = getPoolsLaunchRuntime();
      // The cast is the test's own: `WIRING` deliberately pairs a method with a
      // shape the OTHER methods would reject, which is what makes a crossed wire
      // visible at all.
      const call = runtime[method] as (a: unknown, b: unknown) => Promise<unknown>;
      const outcome = await call(SESSION, inputs);

      expect(implementation).toHaveBeenCalledWith(SESSION, inputs);
      expect(outcome).toEqual({ ok: true, value: "sentinel" });

      // Nothing else was touched. A crossed wire fails HERE even when the
      // returned shape happens to be plausible.
      for (const other of Object.values(implementations)) {
        if (other !== implementation) expect(other).not.toHaveBeenCalled();
      }
    },
  );

  it("getAwaiting forwards the session alone, because the contract gives it nothing else", async () => {
    implementations.getAwaitingPoolsLaunchForm.mockResolvedValue({ ok: true, value: null });

    const outcome = await getPoolsLaunchRuntime().getAwaiting(SESSION);

    expect(implementations.getAwaitingPoolsLaunchForm).toHaveBeenCalledWith(SESSION);
    expect(outcome).toEqual({ ok: true, value: null });
  });

  it("surfaces a runtime refusal unchanged rather than reinterpreting it", async () => {
    const refusal = { kind: "verifier_refused", message: "point 9: devBuyMinOut was a band" };
    implementations.preparePoolsLaunch.mockResolvedValue({ ok: false, refusal });

    const outcome = await getPoolsLaunchRuntime().prepare(SESSION, {
      name: "Moon",
      symbol: "MOON",
      pairedAsset: "weth",
      feeRecipient: { kind: "session_wallet" },
    });

    expect(outcome).toEqual({ ok: false, refusal });
  });
});
