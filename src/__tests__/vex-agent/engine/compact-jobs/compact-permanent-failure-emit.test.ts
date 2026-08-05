/**
 * Compact permanent failure — what the user is told, decided by the REAL
 * executor.
 *
 * A compact job that gives up permanently is not background noise: the
 * session's context is no longer being compacted, so the NEXT turn is the one
 * that hits the context wall. But the opposite error is worse — telling a user
 * their compaction died when it is alive and retrying under another worker.
 *
 * `markFailed` decides `terminal` from a SELECT and then re-checks ownership
 * in the UPDATE's WHERE clause. When another worker reclaimed the row in
 * between (`recoverStaleRunning` after a heartbeat lapse) the CAS matches zero
 * rows and the repo returns `{ ok: false, terminal: true }` — nothing written,
 * job still alive. Gating on `terminal` alone produced a false permanent-
 * failure banner AND a false bug report.
 *
 * These tests drive `startCompactJobsExecutor` itself with the repo and the
 * expensive helpers mocked, so the terminal/ok decision under test is the
 * executor's real one. An earlier version of this file copied that decision
 * into a local helper — a test that re-implements the code it is checking
 * stays green while the product breaks (`rules/90`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SESSION = "00000000-0000-4000-8000-00000000000a";

const claimNextDueJob = vi.fn();
const markFailed = vi.fn();
const markCompleted = vi.fn();
const heartbeat = vi.fn();
const recoverStaleRunning = vi.fn(async (..._args: unknown[]) => 0);
const loadArchivedPrefix = vi.fn();
const emitCompactWorkerPermanentlyFailedBug = vi.fn(async (..._args: unknown[]) => {});

vi.mock("@vex-agent/db/repos/compact-jobs/index.js", () => ({
  claimNextDueJob: (...a: unknown[]) => claimNextDueJob(...a),
  markFailed: (...a: unknown[]) => markFailed(...a),
  markCompleted: (...a: unknown[]) => markCompleted(...a),
  heartbeat: (...a: unknown[]) => heartbeat(...a),
  recoverStaleRunning: (...a: unknown[]) => recoverStaleRunning(...a),
}));
vi.mock("../../../../vex-agent/engine/compact-jobs/archived-prefix.js", () => ({
  loadArchivedPrefix: (...a: unknown[]) => loadArchivedPrefix(...a),
}));
vi.mock("../../../../vex-agent/engine/compact-jobs/bug-emit.js", () => ({
  emitCompactWorkerPermanentlyFailedBug: (...a: unknown[]) =>
    emitCompactWorkerPermanentlyFailedBug(...a),
}));

import { startCompactJobsExecutor } from "../../../../vex-agent/engine/compact-jobs/executor.js";
import {
  engineErrorBus,
  type EngineErrorEvent,
} from "../../../../vex-agent/engine/runtime/error-bus.js";

let seen: EngineErrorEvent[] = [];

const job = {
  id: 7,
  sessionId: SESSION,
  sourceStartMessageId: 1,
  sourceEndMessageId: 9,
  attemptCount: 3,
  maxAttempts: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  seen = [];
  engineErrorBus.subscribe((event) => seen.push(event));
  process.env.OPENROUTER_API_KEY = "sk-test";
  process.env.AGENT_MODEL = "test/model";
  // One claim, then idle — so a single tick processes exactly one job.
  claimNextDueJob.mockResolvedValueOnce(job).mockResolvedValue(null);
  heartbeat.mockResolvedValue(true);
  recoverStaleRunning.mockResolvedValue(0);
});

afterEach(() => {
  engineErrorBus.clear();
});

/** Run the executor until it has settled the failure, then shut it down. */
async function runOneTick(): Promise<void> {
  const handle = startCompactJobsExecutor({ pollIntervalMs: 1 });
  await vi.waitFor(() => {
    expect(markFailed).toHaveBeenCalled();
  });
  await handle.stop();
}

describe("compact permanent failure -> engine.error", () => {
  it("reports when THIS worker settled the terminal failure", async () => {
    const err = new Error("OpenRouter chunker failed: status=429");
    Object.assign(err, {
      statusCode: 429,
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      retryAfterSeconds: 41,
    });
    loadArchivedPrefix.mockRejectedValue(err);
    markFailed.mockResolvedValue({ ok: true, terminal: true });

    await runOneTick();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: SESSION,
      scope: "compact",
      statusCode: 429,
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      retryAfterSeconds: 41,
    });
    expect(emitCompactWorkerPermanentlyFailedBug).toHaveBeenCalledTimes(1);
  });

  it("stays SILENT when the terminal CAS LOST ownership (ok:false, terminal:true)", async () => {
    // The regression: nothing was written, the job is alive under its new
    // owner, and its retry may succeed. Announcing a permanent failure here is
    // a lie to the user and a phantom bug report for the operator.
    loadArchivedPrefix.mockRejectedValue(new Error("boom"));
    markFailed.mockResolvedValue({ ok: false, terminal: true });

    await runOneTick();

    expect(seen).toHaveLength(0);
    expect(emitCompactWorkerPermanentlyFailedBug).not.toHaveBeenCalled();
  });

  it("stays SILENT for a non-terminal failure — the job retries", async () => {
    loadArchivedPrefix.mockRejectedValue(new Error("transient"));
    markFailed.mockResolvedValue({ ok: true, terminal: false });

    await runOneTick();

    expect(seen).toHaveLength(0);
    expect(emitCompactWorkerPermanentlyFailedBug).not.toHaveBeenCalled();
  });

  it("never carries the exception message — that stays in the bug report", async () => {
    loadArchivedPrefix.mockRejectedValue(
      new Error("chunker blew up with sk-secret123 in the payload"),
    );
    markFailed.mockResolvedValue({ ok: true, terminal: true });

    await runOneTick();

    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain("sk-secret123");
    expect(Object.keys(seen[0] ?? {})).not.toContain("message");
    // The raw text still reaches the internal diagnostics channel.
    expect(emitCompactWorkerPermanentlyFailedBug).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMsg: expect.stringContaining("sk-secret123"),
      }),
    );
  });

  it("reports an unclassifiable failure rather than staying silent", async () => {
    loadArchivedPrefix.mockRejectedValue(new Error("plain"));
    markFailed.mockResolvedValue({ ok: true, terminal: true });

    await runOneTick();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.statusCode).toBeNull();
    expect(seen[0]?.errorType).toBeNull();
  });
});
