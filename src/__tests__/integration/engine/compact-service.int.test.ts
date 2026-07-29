/**
 * Integration: `executeCompactNow` service correctness under concurrency
 * and Track 2 worker resilience.
 *
 * Codex audit (P1 #1, #4, #5) — required gates before commit:
 *
 *   - Two concurrent `executeCompactNow` calls against the same session
 *     don't double-bump `checkpoint_generation` (FOR UPDATE row lock plus
 *     in-transaction live-message read prevent stale-plan + late-commit).
 *
 *   - Missing OpenRouter env (worker config) keeps the executor idle and
 *     does NOT consume `attempt_count` on pending jobs (regression for the
 *     claim-then-throw bug codex flagged).
 *
 *   - Empty archive range (the chunker job points at messages that have
 *     since vanished) marks the job FAILED with a backoff, NOT completed
 *     with 0 chunks (regression for the silent data-loss path codex
 *     flagged).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, beforeAll, afterEach } from "vitest";

import { executeCompactNow } from "@vex-agent/engine/compact-jobs/service.js";
import { startCompactJobsExecutor } from "@vex-agent/engine/compact-jobs/executor.js";
import {
  enqueueJob,
  getById,
  listPendingForSession,
  type NewCompactJob,
} from "@vex-agent/db/repos/compact-jobs/index.js";
import { execute, query, queryOne } from "@vex-agent/db/client.js";
import { resetCompactMutexForTests } from "@vex-agent/engine/compact-jobs/state.js";
import { GIANT_TOOL_THRESHOLD } from "@vex-agent/engine/checkpoint/prefix.js";
import { getAllMessages } from "@vex-agent/db/repos/messages.js";
import { insertMessage, makeSession, resetDb } from "../setup/fixtures.js";

function newJob(sessionId: string, gen: number, overrides: Partial<NewCompactJob> = {}): NewCompactJob {
  return {
    sessionId,
    checkpointGeneration: gen,
    agentSummary: overrides.agentSummary ?? `Summary gen ${gen}`,
    preserveMd: overrides.preserveMd ?? null,
    threadThemesHints: overrides.threadThemesHints ?? [],
    sourceStartMessageId: overrides.sourceStartMessageId ?? 999_999,
    sourceEndMessageId: overrides.sourceEndMessageId ?? 999_999,
  };
}

async function seedLongConversation(sessionId: string): Promise<void> {
  // `selectPrefixWithGiantFallback` keeps the last TAIL_WINDOW=10 messages
  // as the live tail; anything before that is the archive prefix. Seed >
  // TAIL_WINDOW so a normal-mode compact has something to archive.
  for (let i = 0; i < 14; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    await insertMessage(sessionId, role, `turn ${i}: realistic conversation content`);
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Scratch dir prefix for the spawned child scripts. The dirs MUST live under
 * `src/` and OUTSIDE `src/__tests__/`: tsx resolves the `@vex-agent/*`
 * tsconfig path alias only for files the root `tsconfig.json` actually
 * matches, and that config excludes `src/__tests__`. Each call gets its own
 * top-level dir (no shared parent to leave behind) and removes it in a
 * `finally`, so nothing is left in the tree.
 */
const CHILD_SCRATCH_PREFIX = resolve(REPO_ROOT, "src/__integration-child-");

/**
 * Run a command and, on failure, reject with a PLAIN error carrying a
 * truncated, printable summary.
 *
 * Attaching the child's raw stderr to the rejected error is what previously
 * hid this test's real failure: tsx's stderr echoes a minified bundle line
 * whose trailing sourcemap comment made Vitest's stack pretty-printer throw
 * inside `convert-source-map`, replacing the assertion failure with an
 * unrelated "Unexpected token" crash. Keep the failure legible.
 */
function execFileSummarized(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const printable = (text: string): string =>
          text.replace(/[^\x20-\x7E\n]/g, "?").split(/\r?\n/).slice(-20).join("\n").slice(-2000);
        reject(
          new Error(
            `child compact failed (${error.message.split("\n")[0]})\n` +
              `--- stdout tail ---\n${printable(stdout)}\n` +
              `--- stderr tail ---\n${printable(stderr)}`,
          ),
        );
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

async function runChildCompact(sessionId: string, summary: string): Promise<unknown> {
  // `tsx -e` is NOT usable here: the eval source has no on-disk path, so tsx
  // resolves it against no tsconfig and `@vex-agent/*` fails with
  // MODULE_NOT_FOUND. Write a real `.mts` file inside the tsconfig's include
  // set instead — that also restores top-level await.
  const scratchDir = `${CHILD_SCRATCH_PREFIX}${randomUUID()}`;
  const scriptPath = resolve(scratchDir, "compact-child.mts");
  const script = `import { executeCompactNow } from "@vex-agent/engine/compact-jobs/service.js";

const result = await executeCompactNow({
  sessionId: process.env.VEX_CHILD_SESSION_ID!,
  agentSummary: process.env.VEX_CHILD_SUMMARY!,
  preserveMd: null,
  threadThemesHints: [],
  source: "agent_tool",
});
await new Promise<void>((done) => {
  process.stdout.write(JSON.stringify(result) + "\\n", () => done());
});
// Explicit exit: the DB pool keeps the event loop alive otherwise.
process.exit(0);
`;

  await mkdir(scratchDir, { recursive: true });
  try {
    await writeFile(scriptPath, script, "utf8");
    const { stdout } = await execFileSummarized(
      "pnpm",
      ["exec", "tsx", scriptPath],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          VEX_CHILD_SESSION_ID: sessionId,
          VEX_CHILD_SUMMARY: summary,
        },
        timeout: 20_000,
      },
    );
    const line = stdout.trim().split(/\r?\n/).findLast((candidate) => candidate.startsWith("{"));
    if (!line) throw new Error(`child compact produced no JSON stdout: ${stdout}`);
    return JSON.parse(line);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

describe("executeCompactNow concurrency (integration)", () => {
  beforeEach(async () => {
    await resetDb();
    resetCompactMutexForTests();
  });

  it("two in-process compact calls against the same session do not double-bump checkpoint_generation", async () => {
    const sid = await makeSession();
    await seedLongConversation(sid);

    // SCOPE NOTE (codex P2 — round 2): `executeCompactNow` always enters
    // `withCheckpointMutex` first, so two calls fired from the SAME
    // process serialize on the in-process Map before the FOR UPDATE row
    // lock is ever reached. This test therefore exercises the in-process
    // mutex (and the post-lock plan-then-bump invariant), not the
    // cross-process DB row lock. Multi-process row-lock coverage is
    // deferred — would require spawning a second Node process or running
    // against a separate connection pool.
    const [a, b] = await Promise.all([
      executeCompactNow({
        sessionId: sid,
        agentSummary: "First attempt",
        preserveMd: null,
        threadThemesHints: [],
        source: "agent_tool",
      }),
      executeCompactNow({
        sessionId: sid,
        agentSummary: "Second attempt",
        preserveMd: null,
        threadThemesHints: [],
        source: "forced_fallback",
      }),
    ]);

    // Even though the in-process mutex pre-serializes, the second call's
    // POST-lock plan happens against the snapshot the first call already
    // committed against — so it sees the archived prefix gone and returns
    // `noop` rather than bumping a stale generation. That's the durable
    // correctness primitive being asserted here.
    const committed = [a, b].filter((r) => r.kind === "committed");
    const noop = [a, b].filter((r) => r.kind === "noop");

    expect(committed.length + noop.length).toBe(2);
    expect(committed.length).toBe(1);
    expect(noop.length).toBe(1);

    // Check the persisted generation matches what the committed call reported.
    const sessionRow = await queryOne<{ checkpoint_generation: number }>(
      "SELECT checkpoint_generation FROM sessions WHERE id = $1",
      [sid],
    );
    if (committed[0]?.kind !== "committed") throw new Error("committed call returned wrong shape");
    expect(sessionRow?.checkpoint_generation).toBe(committed[0].generation);

    // Token count was reset to 0 by the committed call.
    const tokRow = await queryOne<{ token_count: number }>(
      "SELECT token_count FROM sessions WHERE id = $1",
      [sid],
    );
    expect(tokRow?.token_count).toBe(0);
  });

  it("two child-process compact calls serialize on the session row lock and do not double-bump generation", async () => {
    const sid = await makeSession();
    await seedLongConversation(sid);

    const [a, b] = await Promise.all([
      runChildCompact(sid, "Child process compact attempt A"),
      runChildCompact(sid, "Child process compact attempt B"),
    ]) as Array<{ kind: string; generation?: number; jobId?: number }>;

    const committed = [a, b].filter((r) => r.kind === "committed");
    const noop = [a, b].filter((r) => r.kind === "noop");
    expect(committed).toHaveLength(1);
    expect(noop).toHaveLength(1);

    const sessionRow = await queryOne<{ checkpoint_generation: number }>(
      "SELECT checkpoint_generation FROM sessions WHERE id = $1",
      [sid],
    );
    expect(sessionRow?.checkpoint_generation).toBe(1);

    const jobRows = await query<{ id: number; checkpoint_generation: number }>(
      "SELECT id, checkpoint_generation FROM compact_jobs WHERE session_id = $1",
      [sid],
    );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0].checkpoint_generation).toBe(1);
  }, 30_000);
});

describe("compact-worker missing-config gate (integration)", () => {
  let savedApiKey: string | undefined;
  let savedAgentModel: string | undefined;

  beforeAll(() => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    savedAgentModel = process.env.AGENT_MODEL;
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    // Restore env so subsequent tests / suites are not poisoned.
    if (savedApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedApiKey;
    if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = savedAgentModel;
  });

  it("does NOT claim pending jobs (or burn attempt_count) when provider env is unset", async () => {
    const sid = await makeSession();
    const enq = await enqueueJob(newJob(sid, 1));
    const jobId = enq.job.id;

    // Unset env BEFORE starting the executor so the pre-claim gate fires.
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AGENT_MODEL;

    const handle = startCompactJobsExecutor({ pollIntervalMs: 50 });
    // Give the executor a few tick cycles to demonstrate it's idle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.stop();

    const after = await getById(jobId);
    expect(after).not.toBeNull();
    // Status untouched, attempt_count still 0 — the executor never claimed.
    expect(after!.status).toBe("pending");
    expect(after!.attemptCount).toBe(0);
  });
});

describe("executeCompactNow giant_tool plan (integration)", () => {
  // Replaces the deleted `giant-tool-chain.int.test.ts` coverage: when a
  // single bloated tool message exceeds GIANT_TOOL_THRESHOLD, the compact
  // path forks that one row to messages_archive and leaves a placeholder
  // (referencing the compact_job_id + session_memory_search) in the live transcript.
  // This is the codex-required regression test for the PR4 sunset.

  beforeEach(async () => {
    await resetDb();
    resetCompactMutexForTests();
  });

  it("forks single bloated tool result to archive, leaves placeholder pointing at compact_job", async () => {
    const sid = await makeSession();

    // Small head conversation + one bloated tool message + small tail.
    await insertMessage(sid, "user", "fetch a big dump");
    await insertMessage(sid, "assistant", "calling tool", { toolCalls: [{ id: "tc-bloat-1", type: "function", function: { name: "demo", arguments: "{}" } }] });
    const bloatedId = await insertMessage(
      sid,
      "tool",
      "x".repeat(GIANT_TOOL_THRESHOLD + 1000),
      { toolCallId: "tc-bloat-1" },
    );
    await insertMessage(sid, "assistant", "tool result received; proceeding");

    const result = await executeCompactNow({
      sessionId: sid,
      agentSummary: "compact summary",
      preserveMd: null,
      threadThemesHints: [],
      source: "agent_tool",
    });

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") throw new Error("unreachable");
    expect(result.planMode).toBe("giant_tool");
    expect(result.archivedMessages).toBe(1);

    // Original bloated payload in messages_archive.
    const archivedRow = await queryOne<{ content: string }>(
      `SELECT content FROM messages_archive WHERE id = $1`,
      [bloatedId],
    );
    expect(archivedRow).not.toBeNull();
    expect(archivedRow!.content.length).toBeGreaterThan(GIANT_TOOL_THRESHOLD);
    expect(archivedRow!.content.startsWith("xxxx")).toBe(true);

    // Live row replaced by placeholder mentioning compact_job_id + session_memory_search.
    const liveRow = await queryOne<{ content: string }>(
      `SELECT content FROM messages WHERE id = $1`,
      [bloatedId],
    );
    expect(liveRow).not.toBeNull();
    expect(liveRow!.content).toContain(String(result.jobId));
    expect(liveRow!.content.toLowerCase()).toContain("session_memory_search");
    // Placeholder is bounded — much smaller than the original payload.
    expect(liveRow!.content.length).toBeLessThan(GIANT_TOOL_THRESHOLD);

    // compact_job source range points at the forked message id (single-row range).
    const job = await queryOne<{
      source_start_message_id: number;
      source_end_message_id: number;
    }>(
      `SELECT source_start_message_id, source_end_message_id FROM compact_jobs WHERE id = $1`,
      [result.jobId],
    );
    expect(job?.source_start_message_id).toBe(bloatedId);
    expect(job?.source_end_message_id).toBe(bloatedId);

    // getAllMessages returns canonical archived payload once, NOT the placeholder.
    // This is the consumer-side proof that the fork is visible-as-archived to
    // any code reading through getAllMessages (resume paths, history viewers).
    const allMessages = await getAllMessages(sid);
    const matchingRows = allMessages.filter((m) => m.id === bloatedId);
    expect(matchingRows).toHaveLength(1);
    expect(matchingRows[0].content.startsWith("xxxx")).toBe(true);
  });
});

describe("compact-worker empty-archive failure mode (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("marks the job FAILED (retryable) when the source range resolves to zero archived rows", async () => {
    // Provider env must be present so the pre-claim gate doesn't short-circuit
    // the test. Worker will claim, attempt processJob, hit the empty-archive
    // branch, throw → processJob.catch → markFailed with backoff.
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "test-fixture-key";
    process.env.AGENT_MODEL = process.env.AGENT_MODEL ?? "test/fixture-model";

    const sid = await makeSession();
    // Enqueue a job pointing at message ids that DON'T exist in
    // messages_archive — the worker will read zero rows and throw.
    const enq = await enqueueJob(newJob(sid, 1, {
      sourceStartMessageId: 88_888,
      sourceEndMessageId: 99_999,
    }));
    const jobId = enq.job.id;

    const handle = startCompactJobsExecutor({ pollIntervalMs: 50 });
    // Wait for the worker to claim + fail the job.
    let after = await getById(jobId);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      after = await getById(jobId);
      if (after && after.status !== "pending" && after.status !== "running") break;
      // Could also be back in pending after markFailed with backoff — check attempt count.
      if (after && after.attemptCount > 0 && after.status === "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await handle.stop();

    expect(after).not.toBeNull();
    // The empty-archive throw bumps attempt_count via markFailed → status
    // returns to 'pending' (retryable) with next_attempt_at scheduled, OR
    // 'permanently_failed' after WORKER_MAX_ATTEMPTS. Either is a NON-success
    // terminal — the key invariant is that the job is NOT 'completed' with
    // zero chunks.
    expect(after!.status).not.toBe("completed");
    expect(after!.attemptCount).toBeGreaterThanOrEqual(1);
    expect(after!.lastError).toContain("compact_worker_empty_archive_range");
  });
});
