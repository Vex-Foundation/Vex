/**
 * A failed consolidate item must SAY WHY.
 *
 * The user-visible symptom this pins: every memory item failed and the app's
 * error banner said the cause "was not reported". Three holes produced that:
 *
 *  1. `processItem`'s catch bucketed the throw and logged NOTHING;
 *  2. `mapErrorCode` matched on message SUBSTRINGS only, so a real provider
 *     rejection (which carries `statusCode` / `errorClass` own-properties from
 *     `normalizeOpenRouterError`) fell through to the opaque `item_error`;
 *  3. the items-failed job finalizer passed a literal `null` to
 *     `emitMemoryJobFailure`, so the engine error event carried an all-null
 *     signal and the renderer had nothing to classify.
 *
 * The error used here is exactly what `normalizeOpenRouterError` produces: a
 * plain `Error` with a scrubbed message and lean bounded own-properties. No
 * `.cause`, no raw SDK object — the redaction doctrine is part of the contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const JOB = { id: "job-1", jobKind: "consolidate", attemptCount: 1 };
const ITEM = { id: "item-1", candidateId: "cand-1" };

const claimNextDueJob = vi.fn(async () => JOB);
const markFailed = vi.fn(async () => ({ ok: true, terminal: true }));
const markCompleted = vi.fn(async () => true);
const heartbeat = vi.fn(async () => true);
const recoverStaleRunning = vi.fn(async () => ({ jobsReset: 0, jobsFailed: 0 }));
const listJobsByStatus = vi.fn(async () => []);
const enqueueConsolidateJob = vi.fn();
const bumpJobInference = vi.fn();

const reserveCandidatesForJob = vi.fn(async () => 1);
const listItemsByJob = vi.fn(async () => [ITEM]);
const markItemProcessing = vi.fn(async () => true);
const markItemDone = vi.fn(async () => true);
const markItemFailed =
  vi.fn<(itemId: string, jobId: string, workerId: string, errorCode: string) => Promise<boolean>>(
    async () => true,
  );

const consolidateCandidate = vi.fn();
const emitMemoryWorkerPermanentlyFailedBug = vi.fn(async () => {});

const memLogCalls: Array<{ level: string; area: string; event: string; meta?: unknown }> = [];
const memLog = Object.assign(
  (area: string, event: string, meta?: unknown) =>
    memLogCalls.push({ level: "info", area, event, meta }),
  {
    warn: (area: string, event: string, meta?: unknown) =>
      memLogCalls.push({ level: "warn", area, event, meta }),
    error: (area: string, event: string, meta?: unknown) =>
      memLogCalls.push({ level: "error", area, event, meta }),
  },
);

vi.mock("@vex-agent/db/repos/memory-jobs/index.js", () => ({
  claimNextDueJob: (...a: unknown[]) => claimNextDueJob(...(a as [])),
  markFailed: (...a: unknown[]) => markFailed(...(a as [])),
  markCompleted: (...a: unknown[]) => markCompleted(...(a as [])),
  heartbeat: (...a: unknown[]) => heartbeat(...(a as [])),
  recoverStaleRunning: (...a: unknown[]) => recoverStaleRunning(...(a as [])),
  listJobsByStatus: (...a: unknown[]) => listJobsByStatus(...(a as [])),
  enqueueConsolidateJob: (...a: unknown[]) => enqueueConsolidateJob(...(a as [])),
  bumpJobInference: (...a: unknown[]) => bumpJobInference(...(a as [])),
}));
vi.mock("@vex-agent/db/repos/memory-job-items/index.js", () => ({
  reserveCandidatesForJob: (...a: unknown[]) => reserveCandidatesForJob(...(a as [])),
  listItemsByJob: (...a: unknown[]) => listItemsByJob(...(a as [])),
  markItemProcessing: (...a: unknown[]) => markItemProcessing(...(a as [])),
  markItemDone: (...a: unknown[]) => markItemDone(...(a as [])),
  markItemFailed: (...a: unknown[]) =>
    markItemFailed(...(a as [string, string, string, string])),
}));
vi.mock("@vex-agent/db/repos/memory-decisions/index.js", () => ({
  getLatestDecision: vi.fn(async () => null),
}));
vi.mock("@vex-agent/db/repos/memory-candidates/index.js", () => ({
  listCandidatesByStatus: vi.fn(async () => []),
}));
vi.mock("@vex-agent/memory/manager/index.js", () => ({
  consolidateCandidate: (...a: unknown[]) => consolidateCandidate(...(a as [])),
  applyDecisionAtomically: vi.fn(),
  defaultConsolidateDeps: () => ({}),
  getCandidateById: vi.fn(async () => ({ id: "cand-1", status: "pending" })),
  getCandidateEmbedding: vi.fn(async () => [0.1]),
}));
vi.mock("@vex-agent/memory/observability/logger.js", () => ({ memLog }));
vi.mock("../../../../vex-agent/engine/memory-manager/bug-emit.js", () => ({
  emitMemoryWorkerPermanentlyFailedBug: (...a: unknown[]) =>
    emitMemoryWorkerPermanentlyFailedBug(...(a as [])),
}));
vi.mock("../../../../vex-agent/engine/memory-manager/decay-sweep.js", () => ({
  runDecaySweep: vi.fn(async () => {}),
}));

const { startMemoryManagerExecutor } = await import(
  "../../../../vex-agent/engine/memory-manager/executor.js"
);
const { engineErrorBus } = await import(
  "../../../../vex-agent/engine/runtime/error-bus.js"
);
import type { EngineErrorEvent } from "../../../../vex-agent/engine/runtime/error-bus.js";

/** Exactly the shape `normalizeOpenRouterError` returns for a 400 rejection. */
function normalizedProviderRejection(): Error {
  const err = new Error(
    "OpenRouter chat completion failed: status=400 | code=400 | Provider returned error",
  );
  Object.assign(err, {
    statusCode: 400,
    status: 400,
    errorClass: "BadRequestResponseError",
    causeCode: null,
  });
  return err;
}

/**
 * The live-verified failure shape (2026-07-31): OpenRouter rejects a
 * `response_format` request whose pinned endpoint pool is empty with HTTP 404
 * "No endpoints found for <model>" — the exact rejection that bucketed as
 * `item_error` before the fix.
 */
function normalizedNoEndpointsRejection(): Error {
  const err = new Error(
    "OpenRouter simple chat completion failed: status=404 | code=404 | No endpoints found for deepseek/deepseek-v4-pro.",
  );
  Object.assign(err, {
    statusCode: 404,
    status: 404,
    errorClass: "NotFoundResponseError",
    causeCode: null,
  });
  return err;
}

let seen: EngineErrorEvent[] = [];

async function runOneTick(): Promise<void> {
  const handle = startMemoryManagerExecutor({
    pollIntervalMs: 5,
    sweepIntervalMs: 60_000,
  });
  await new Promise((r) => setTimeout(r, 50));
  await handle.stop();
}

describe("a failed consolidate item reports its cause", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    memLogCalls.length = 0;
    seen = [];
    engineErrorBus.subscribe((event) => seen.push(event));
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.AGENT_MODEL = "deepseek/deepseek-v4-pro";
    claimNextDueJob.mockResolvedValueOnce(JOB).mockResolvedValue(null as never);
    consolidateCandidate.mockRejectedValue(normalizedProviderRejection());
  });

  afterEach(async () => {
    engineErrorBus.clear();
    process.env = { ...originalEnv };
  });

  it("maps a provider 400 to a NAMED error code, not the opaque item_error", async () => {
    await runOneTick();

    expect(markItemFailed).toHaveBeenCalled();
    const code = markItemFailed.mock.calls[0]?.[3];
    expect(code).toBe("provider_bad_request");
  });

  it("logs the bounded failure signals instead of swallowing them", async () => {
    await runOneTick();

    const warn = memLogCalls.find((c) => c.level === "warn" && c.event === "item_failed");
    expect(warn).toBeDefined();
    expect(warn?.meta).toMatchObject({
      jobId: "job-1",
      candidateId: "cand-1",
      errorCode: "provider_bad_request",
      statusCode: 400,
      errorKind: "BadRequestResponseError",
    });
  });

  it("maps the live-verified 404 no-endpoints rejection to provider_not_found end-to-end", async () => {
    consolidateCandidate.mockRejectedValue(normalizedNoEndpointsRejection());
    await runOneTick();

    expect(markItemFailed.mock.calls[0]?.[3]).toBe("provider_not_found");
    expect(seen[0]).toMatchObject({
      scope: "memory",
      statusCode: 404,
      errorClass: "NotFoundResponseError",
    });
    expect(emitMemoryWorkerPermanentlyFailedBug).toHaveBeenCalledWith(
      expect.objectContaining({ errorMsg: expect.stringContaining("status=404") }),
    );
  });

  it("passes the representative item error to the job failure emit (was literal null)", async () => {
    await runOneTick();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: null,
      scope: "memory",
      statusCode: 400,
      errorClass: "BadRequestResponseError",
    });
    expect(emitMemoryWorkerPermanentlyFailedBug).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        errorMsg: expect.stringContaining("status=400"),
      }),
    );
  });
});
