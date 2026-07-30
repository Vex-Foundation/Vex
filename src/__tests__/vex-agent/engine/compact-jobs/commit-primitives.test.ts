/**
 * Unit tests for the extracted compact-commit primitives.
 *
 * The load-bearing one is `runWithCommitRetry`: its retry discriminator is
 * `tracker.commitAttempted`, NEVER the error type. A retry after a COMMIT was
 * issued would re-read the already-bumped generation, bump it a second time and
 * archive a second prefix — the defect the whole boundary exists to prevent.
 *
 * `replaceRollingSummaryAndBumpGeneration` is pinned on the other invariant:
 * the generation bump and the `token_count = 0` reset must reach the database
 * as ONE statement, so no restart can observe a bumped generation with a stale
 * token count.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const warn = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const setRollingSummary = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  setRollingSummary: (...args: unknown[]) => setRollingSummary(...args),
}));

const {
  runWithCommitRetry,
  lockSessionAndReadGeneration,
  replaceRollingSummaryAndBumpGeneration,
} = await import("../../../../vex-agent/engine/compact-jobs/commit-primitives.js");

type FakeClient = { query: ReturnType<typeof vi.fn> };

function fakeClient(rows: unknown[] = []): FakeClient {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

const RETRY_INPUT = { sessionId: "s-1", source: "agent_tool", maxAttempts: 3, backoffMs: 0 };

beforeEach(() => {
  warn.mockClear();
  setRollingSummary.mockClear();
});

describe("runWithCommitRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue({ kind: "committed" });
    await expect(runWithCommitRetry(RETRY_INPUT, fn)).resolves.toEqual({ kind: "committed" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries a pre-COMMIT failure and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValueOnce({ kind: "committed" });
    await expect(runWithCommitRetry(RETRY_INPUT, fn)).resolves.toEqual({ kind: "committed" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "compact.commit_retry",
      expect.objectContaining({ sessionId: "s-1", source: "agent_tool", attempt: 1, maxAttempts: 3 }),
    );
  });

  it("rethrows IMMEDIATELY once commitAttempted is set, whatever the error", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const fn = vi.fn(async (tracker: { commitAttempted: boolean }) => {
      tracker.commitAttempted = true;
      throw boom;
    });
    await expect(runWithCommitRetry(RETRY_INPUT, fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not retry a post-COMMIT failure even on the FIRST attempt", async () => {
    // The dangerous shape: attempt 1 committed, then threw on the way out.
    // Retrying would bump a second generation.
    const fn = vi.fn(async (tracker: { commitAttempted: boolean }) => {
      tracker.commitAttempted = true;
      throw new Error("post-commit bookkeeping blew up");
    });
    await expect(runWithCommitRetry(RETRY_INPUT, fn)).rejects.toThrow(/post-commit/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives each attempt a FRESH tracker so an earlier attempt cannot poison a later one", async () => {
    const seen: boolean[] = [];
    const fn = vi.fn(async (tracker: { commitAttempted: boolean }) => {
      seen.push(tracker.commitAttempted);
      if (seen.length < 2) throw new Error("pre-commit");
      return "ok";
    });
    await expect(runWithCommitRetry(RETRY_INPUT, fn)).resolves.toBe("ok");
    expect(seen).toEqual([false, false]);
  });

  it("stops at maxAttempts and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("pool exhausted"));
    await expect(runWithCommitRetry(RETRY_INPUT, fn)).rejects.toThrow(/pool exhausted/);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2); // no warn on the final, rethrown attempt
  });

  it("honours a maxAttempts of 1 as no retry at all", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(runWithCommitRetry({ ...RETRY_INPUT, maxAttempts: 1 }, fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("lockSessionAndReadGeneration", () => {
  it("takes a FOR UPDATE row lock and derives nextGen", async () => {
    const client = fakeClient([{ checkpoint_generation: 7 }]);
    const result = await lockSessionAndReadGeneration(client as never, "s-1");
    expect(result).toEqual({ currentGen: 7, nextGen: 8 });
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT checkpoint_generation FROM sessions WHERE id = \$1 FOR UPDATE/);
    expect(params).toEqual(["s-1"]);
  });

  it("treats a missing session row as generation 0", async () => {
    const client = fakeClient([]);
    await expect(lockSessionAndReadGeneration(client as never, "s-missing")).resolves.toEqual({
      currentGen: 0,
      nextGen: 1,
    });
  });
});

describe("replaceRollingSummaryAndBumpGeneration", () => {
  it("REPLACES the summary on the caller's client and bumps generation + token_count together", async () => {
    const client = fakeClient([]);
    await replaceRollingSummaryAndBumpGeneration(client as never, {
      sessionId: "s-1",
      summary: "redacted narrative",
      nextGen: 8,
    });

    expect(setRollingSummary).toHaveBeenCalledWith("s-1", "redacted narrative", client);

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    // ONE statement — a separate token_count UPDATE would let a restart observe
    // a bumped generation with a stale critical-band token count.
    expect(sql).toMatch(
      /UPDATE sessions SET checkpoint_generation = \$2, token_count = 0 WHERE id = \$1/,
    );
    expect(params).toEqual(["s-1", 8]);
  });
});
