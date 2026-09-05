/**
 * A short deposit costs Vex its fee. It must not cost the user their
 * reconciliation row.
 *
 * `abortPlannedEvents` finalizes EVERY hashless pending row from `fromIndex`
 * onward, and the logical `bridge_fill_expected` row is planned at the index
 * right after the Vex fee row on both venues. A deposit that came up short was
 * still SUBMITTED to the provider, so its fill may still land: aborting that row
 * would terminalize a live bridge's reconciliation record and release its
 * in-flight guard, which is what lets a duplicate bridge through.
 *
 * This suite pins the pass-through both venues use for the withholding path:
 * `abortRemaining(executionId, fromIndex, reason, toIndexExclusive)` reaches the
 * repository with the exclusive bound intact, and the unbounded form still
 * exists for the callers that legitimately abort a tail.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockAbort = vi.fn(async (..._args: unknown[]) => []);
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  abortPlannedEvents: (...args: unknown[]) => mockAbort(...args),
  attachProviderOrderId: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn() }));
vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const relay = await import("@vex-agent/tools/protocols/relay/handlers/bridge/recording.js");
const khalani = await import("@vex-agent/tools/protocols/khalani/handlers/bridge-support.js");

const VENUES: readonly (readonly [string, (
  executionId: number,
  fromIndex: number,
  reason: string,
  toIndexExclusive?: number,
) => Promise<void>])[] = [
  ["relay.bridge", relay.abortRemaining],
  ["khalani.bridge", khalani.abortRemaining],
];

beforeEach(() => {
  mockAbort.mockClear();
});

describe("abortRemaining - the exclusive bound reaches the repository", () => {
  for (const [venue, abortRemaining] of VENUES) {
    it(`${venue}: the fee row alone, with the fill row's index as the exclusive bound`, async () => {
      await abortRemaining(42, 3, "deposit proved less than the quoted principal", 4);
      expect(mockAbort).toHaveBeenCalledTimes(1);
      expect(mockAbort).toHaveBeenCalledWith(42, 3, "deposit proved less than the quoted principal", 4);
    });

    it(`${venue}: an unbounded abort still passes no bound at all`, async () => {
      await abortRemaining(42, 3, "earlier leg reverted");
      expect(mockAbort).toHaveBeenCalledWith(42, 3, "earlier leg reverted");
    });

    it(`${venue}: a repository failure is swallowed, never flipping the caller's result`, async () => {
      mockAbort.mockRejectedValueOnce(new Error("pool down"));
      await expect(abortRemaining(42, 3, "deposit proved less than the quoted principal", 4))
        .resolves.toBeUndefined();
    });
  }
});
