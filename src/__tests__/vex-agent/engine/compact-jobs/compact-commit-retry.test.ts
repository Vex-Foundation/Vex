/**
 * `executeCompactNow` — commit-retry boundary.
 *
 * The compact commit is pure DB work in ONE explicit BEGIN/COMMIT with a
 * ROLLBACK on throw, so a failure BEFORE the COMMIT wrote nothing and is safely
 * replayable. A failure AFTER the COMMIT was issued is NOT: the inner call
 * recomputes `nextGen` from a fresh `SELECT … FOR UPDATE`, so a retry would
 * read the already-bumped generation, bump it AGAIN, enqueue a SECOND chunking
 * job and archive a SECOND prefix. `enqueueJob`'s idempotency is keyed on
 * `(session_id, checkpoint_generation)` and therefore cannot save us from a
 * DIFFERENT generation.
 *
 * These are DB attempts, not provider calls — this path makes no inference
 * call at all. That belongs to the archive chunking worker, which has its own
 * separate retry budget.
 *
 * The DB is mocked at the pool boundary so the retry semantics are pinned
 * deterministically, including the post-COMMIT case, which a live-DB test
 * cannot reliably provoke.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  COMPACT_COMMIT_MAX_ATTEMPTS,
  COMPACT_COMMIT_RETRY_BACKOFF_MS,
} from "@vex-agent/engine/compact-jobs/policy.js";

const SESSION_ID = "session-compact-retry";

/** Records every statement issued across all attempts, in order. */
let statements: string[] = [];
/** Sequential per-statement failure injectors, keyed by SQL fragment. */
let failOn: { fragment: string; attempt: number; error: Error } | null = null;
/** How many times `pool.connect()` was called — one per inner attempt. */
let connectCount = 0;
let enqueueCount = 0;
let archiveCount = 0;

function classify(sql: string): string {
  if (sql.startsWith("BEGIN")) return "BEGIN";
  if (sql.startsWith("COMMIT")) return "COMMIT";
  if (sql.startsWith("ROLLBACK")) return "ROLLBACK";
  if (sql.includes("SELECT checkpoint_generation")) return "SELECT_GEN";
  if (sql.includes("UPDATE sessions SET checkpoint_generation")) return "BUMP_GEN";
  return sql;
}

async function defaultQueryImpl(sql: string): Promise<{ rows: unknown[] }> {
  const kind = classify(sql);
  statements.push(kind);
  if (failOn && kind === failOn.fragment) {
    const occurrences = statements.filter((s) => s === kind).length;
    if (occurrences === failOn.attempt) throw failOn.error;
  }
  if (kind === "SELECT_GEN") {
    return { rows: [{ checkpoint_generation: 7 }] };
  }
  return { rows: [] };
}

const fakeClient = {
  query: vi.fn(defaultQueryImpl),
  release: vi.fn(),
};

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({
    connect: async () => {
      connectCount += 1;
      return fakeClient;
    },
  }),
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  getLiveMessagesWithId: vi.fn(async () => [
    { id: 1, role: "user", content: "hello" },
    { id: 2, role: "assistant", content: "hi" },
  ]),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  setRollingSummary: vi.fn(async () => undefined),
}));

vi.mock("@vex-agent/db/repos/sessions-archive.js", () => ({
  archivePrefix: vi.fn(async () => {
    archiveCount += 1;
  }),
  forkToolMessageToArchive: vi.fn(async () => undefined),
}));

vi.mock("@vex-agent/db/repos/compact-jobs/index.js", () => ({
  enqueueJob: vi.fn(async () => {
    enqueueCount += 1;
    return { job: { id: 4242 }, created: true };
  }),
}));

vi.mock("@vex-agent/engine/checkpoint/prefix.js", () => ({
  selectPrefixWithGiantFallback: vi.fn(() => ({
    mode: "prefix",
    prefix: [{ id: 1, role: "user", content: "hello" }],
    tail: [{ id: 2, role: "assistant", content: "hi" }],
    cutoffMessageId: 1,
  })),
}));

vi.mock("@vex-agent/memory/redaction.js", () => ({
  redact: (text: string) => ({ text, hardRedactCount: 0, maskCount: 0 }),
}));

const { executeCompactNow } = await import("@vex-agent/engine/compact-jobs/service.js");
const { resetCompactMutexForTests } = await import("@vex-agent/engine/compact-jobs/state.js");

function args() {
  return {
    sessionId: SESSION_ID,
    agentSummary: "a summary",
    preserveMd: null,
    threadThemesHints: [],
    source: "agent_tool" as const,
  };
}

describe("executeCompactNow — commit-retry boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls but NOT implementations — restore the
    // default explicitly so a case that swaps it cannot leak into the next.
    fakeClient.query.mockImplementation(defaultQueryImpl);
    resetCompactMutexForTests();
    statements = [];
    failOn = null;
    connectCount = 0;
    enqueueCount = 0;
    archiveCount = 0;
  });

  it("commits on the first attempt when nothing fails", async () => {
    const result = await executeCompactNow(args());

    expect(result).toMatchObject({ kind: "committed", generation: 8, jobId: 4242 });
    expect(connectCount).toBe(1);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
  });

  it("retries a PRE-COMMIT failure and commits exactly one generation", async () => {
    // Fail the generation bump on the first attempt only — the transaction
    // rolls back having written nothing.
    failOn = { fragment: "BUMP_GEN", attempt: 1, error: new Error("deadlock detected") };

    const result = await executeCompactNow(args());

    expect(result).toMatchObject({ kind: "committed", generation: 8 });
    expect(connectCount).toBe(2);
    expect(statements.filter((s) => s === "ROLLBACK")).toHaveLength(1);
    // The whole point: ONE commit, ONE enqueue, ONE archive.
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(enqueueCount).toBe(1);
    expect(archiveCount).toBe(1);
  });

  it("gives up after COMPACT_COMMIT_MAX_ATTEMPTS pre-COMMIT failures", async () => {
    // Fail every attempt: `attempt: 0` never matches an occurrence count.
    fakeClient.query.mockImplementation(async (sql: string) => {
      const kind = classify(sql);
      statements.push(kind);
      if (kind === "BUMP_GEN") throw new Error("pool exhausted");
      if (kind === "SELECT_GEN") return { rows: [{ checkpoint_generation: 7 }] };
      return { rows: [] };
    });

    await expect(executeCompactNow(args())).rejects.toThrow("pool exhausted");

    expect(connectCount).toBe(COMPACT_COMMIT_MAX_ATTEMPTS);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(0);
  });

  it("NEVER retries a POST-COMMIT failure — a retry would double-bump the generation", async () => {
    // The COMMIT statement itself throws. We cannot know whether the server
    // applied it, so the only safe assumption is that it did.
    failOn = { fragment: "COMMIT", attempt: 1, error: new Error("connection reset") };

    await expect(executeCompactNow(args())).rejects.toThrow("connection reset");

    // ONE inner attempt. A second would have re-read generation 7 (or 8) and
    // bumped again, enqueueing a second job and archiving a second prefix.
    expect(connectCount).toBe(1);
    expect(statements.filter((s) => s === "SELECT_GEN")).toHaveLength(1);
    expect(statements.filter((s) => s === "BUMP_GEN")).toHaveLength(1);
    expect(enqueueCount).toBe(1);
    expect(archiveCount).toBe(1);
  });

  it("does not retry a noop — an empty session is a result, not a failure", async () => {
    const prefix = await import("@vex-agent/engine/checkpoint/prefix.js");
    vi.mocked(prefix.selectPrefixWithGiantFallback).mockReturnValueOnce({
      mode: "noop",
      reason: "empty_session",
    });

    const result = await executeCompactNow(args());

    expect(result).toEqual({ kind: "noop", reason: "empty_session" });
    expect(connectCount).toBe(1);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(0);
  });

  it("keeps the retry budget and backoff conservative", () => {
    // A blocked caller is waiting on this: three attempts at half a second is
    // a stall the user can absorb, an aggressive schedule is not.
    expect(COMPACT_COMMIT_MAX_ATTEMPTS).toBe(3);
    expect(COMPACT_COMMIT_RETRY_BACKOFF_MS).toBeLessThanOrEqual(1_000);
  });
});
