/**
 * Memory permanent failure — global (session-less) error emit + diagnostics.
 *
 * Memory consolidation and reconcile are GLOBAL maintenance over
 * `knowledge_entries`: `memory_jobs` has no `session_id` column, so these
 * failures belong to no conversation. They therefore emit with
 * `sessionId: null` and `scope: "memory"`, which routes them to the app-wide
 * surface — a session banner would tell the user their conversation broke when
 * it did not.
 *
 * The gating mirrors compact exactly, including the ownership subtlety:
 * `markFailed` decides `terminal` from a SELECT and re-checks ownership in the
 * UPDATE's WHERE clause, so a row reclaimed in between returns
 * `{ ok: false, terminal: true }` — nothing written, job alive under its new
 * owner. Reporting on `terminal` alone announces a failure that did not happen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const claimNextDueJob = vi.fn();
const markFailed = vi.fn();
const markCompleted = vi.fn();
const heartbeat = vi.fn();
const recoverStaleRunning = vi.fn(async () => 0);
const listJobsByStatus = vi.fn(async () => []);
const enqueueConsolidateJob = vi.fn();
const bumpJobInference = vi.fn();

const reserveCandidatesForJob = vi.fn(async () => 0);
const listItemsByJob = vi.fn(async () => []);

const emitMemoryWorkerPermanentlyFailedBug = vi.fn(async () => {});

vi.mock("@vex-agent/db/repos/memory-jobs/index.js", () => ({
  claimNextDueJob: (...a: unknown[]) => claimNextDueJob(...a),
  markFailed: (...a: unknown[]) => markFailed(...a),
  markCompleted: (...a: unknown[]) => markCompleted(...a),
  heartbeat: (...a: unknown[]) => heartbeat(...a),
  recoverStaleRunning: (...a: unknown[]) => recoverStaleRunning(...a),
  listJobsByStatus: (...a: unknown[]) => listJobsByStatus(...a),
  enqueueConsolidateJob: (...a: unknown[]) => enqueueConsolidateJob(...a),
  bumpJobInference: (...a: unknown[]) => bumpJobInference(...a),
}));
vi.mock("@vex-agent/db/repos/memory-job-items/index.js", () => ({
  reserveCandidatesForJob: (...a: unknown[]) => reserveCandidatesForJob(...a),
  listItemsByJob: (...a: unknown[]) => listItemsByJob(...a),
  markItemProcessing: vi.fn(),
  markItemDone: vi.fn(),
  markItemFailed: vi.fn(),
}));
vi.mock("../../../../vex-agent/engine/memory-manager/bug-emit.js", () => ({
  emitMemoryWorkerPermanentlyFailedBug: (...a: unknown[]) =>
    emitMemoryWorkerPermanentlyFailedBug(...a),
}));

import {
  engineErrorBus,
  type EngineErrorEvent,
} from "../../../../vex-agent/engine/runtime/error-bus.js";

let seen: EngineErrorEvent[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  seen = [];
  engineErrorBus.subscribe((event) => seen.push(event));
});

afterEach(() => {
  engineErrorBus.clear();
});

/**
 * The executor's failure settlement is reached through a long DB-bound job
 * path, so this drives the emit decision through the module's own exported
 * surface where possible and otherwise pins the source. The behavioural
 * contract of the EMIT ITSELF — payload shape, null session, scope — is
 * exercised directly against the real bus.
 */
describe("memory job failure -> global engine.error", () => {
  it("emits session-LESS with scope `memory` and bounded signals", async () => {
    const { emitEngineError } = await import(
      "../../../../vex-agent/engine/runtime/error-bus.js"
    );
    const { readMissionErrorSignal } = await import(
      "../../../../vex-agent/engine/core/runner/mission-error-signal.js"
    );
    const err = new Error("consolidate blew up: status=429");
    Object.assign(err, {
      statusCode: 429,
      errorType: "rate_limit_exceeded",
      retryAfterSeconds: 41,
    });
    const signal = readMissionErrorSignal(err);
    emitEngineError({
      sessionId: null,
      scope: "memory",
      errorType: signal.errorType,
      errorClass: signal.errorClass,
      statusCode: signal.status,
      causeCode: signal.causeCode,
      retryAfterSeconds: signal.retryAfterSeconds,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      // The load-bearing field: null routes this to the GLOBAL surface.
      sessionId: null,
      scope: "memory",
      statusCode: 429,
      errorType: "rate_limit_exceeded",
      retryAfterSeconds: 41,
    });
    expect(Object.keys(seen[0] ?? {})).not.toContain("message");
  });

  it("emits an all-null signal when there is no throwable (items-failed path)", async () => {
    const { emitEngineError } = await import(
      "../../../../vex-agent/engine/runtime/error-bus.js"
    );
    const { readMissionErrorSignal } = await import(
      "../../../../vex-agent/engine/core/runner/mission-error-signal.js"
    );
    // The items-failed settlement has no exception — a guess would be worse
    // than an honest "nothing classifiable".
    const signal = readMissionErrorSignal(null);
    emitEngineError({
      sessionId: null,
      scope: "memory",
      errorType: signal.errorType,
      errorClass: signal.errorClass,
      statusCode: signal.status,
      causeCode: signal.causeCode,
      retryAfterSeconds: signal.retryAfterSeconds,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: null,
      scope: "memory",
      errorType: null,
      errorClass: null,
      statusCode: null,
    });
  });
});

describe("the executor gates BOTH settlement points on ok && terminal", () => {
  it("wires the emit beside the bug report, inside the ownership gate", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL(
        "../../../../vex-agent/engine/memory-manager/executor.ts",
        import.meta.url,
      ),
      "utf8",
    );

    // Two settlement points: the items-failed path and the catch. Both must
    // gate on ownership, not merely on terminal — otherwise a reclaimed row
    // announces a permanent failure that never happened.
    const gates = source.match(/if \(result\.ok && result\.terminal\) \{/g) ?? [];
    expect(gates).toHaveLength(2);
    // And no ungated `result.terminal` check may remain.
    expect(source).not.toMatch(/if \(result\.terminal\)/);

    // Each gate emits the global error AND the bug report.
    const emits = source.match(/emitMemoryJobFailure\(/g) ?? [];
    expect(emits.length).toBeGreaterThanOrEqual(2);
    const bugs = source.match(/emitMemoryWorkerPermanentlyFailedBug\(\{/g) ?? [];
    expect(bugs).toHaveLength(2);

    // The emit helper must be session-less by construction.
    const helper = source.slice(source.indexOf("function emitMemoryJobFailure("));
    expect(helper).toContain("sessionId: null");
    expect(helper).toContain('scope: "memory"');
  });
});
