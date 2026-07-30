/**
 * Integration: the branch-A worker tick against real Postgres.
 *
 * The properties here are the ones that decide whether an unreviewed model
 * output can become durable prompt content, and whether a session can be told
 * its compaction permanently failed when it has not.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  getPreparationById,
  SUMMARY_MAX_ATTEMPTS,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { execute } from "@vex-agent/db/client.js";
import {
  buildPreparationCorpus,
  fingerprintPreparationCorpus,
  serializePreparationCorpus,
} from "@vex-agent/engine/compaction-prep/index.js";
import { runSummaryBranchTick } from "@vex-agent/engine/compaction/branch-a-summary-worker.js";
import { SUMMARY_PROMPT_VERSION } from "@vex-agent/engine/compaction/summary-prompt.js";
import type { BranchInferenceProvider } from "@vex-agent/engine/compaction/branch-provider-call.js";
import type { ProviderMessage } from "@vex-agent/inference/types.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages/types.js";

import { makeSession, resetDb } from "../setup/fixtures.js";
import { forkPreparation, makeDue } from "../repos/compaction-preparation-fixtures.js";

const WORKER = "test-summary-worker";

function corpusText(): string {
  return serializePreparationCorpus(
    buildPreparationCorpus({
      frozenSummary: "the user prefers Solana",
      rows: [
        {
          id: 1,
          role: "user",
          content: "please check my positions",
          toolCallId: null,
          toolCalls: null,
        },
      ] as unknown as MessageWithId[],
      watermarkMessageId: 1,
    }),
  );
}

function provider(content: string): () => Promise<BranchInferenceProvider> {
  return async () => ({
    loadConfig: async () => ({ model: "test/model" }),
    chatCompletionSimple: async () => ({ content, usage: { cost: 0.0002 } }),
  });
}

const GOOD = JSON.stringify({
  conversation_summary:
    "The user asked about their positions and prefers Solana; no action was taken.",
});

async function forkWithCorpus() {
  const sessionId = await makeSession();
  const text = corpusText();
  const preparation = await forkPreparation(sessionId, {
    corpusText: text,
    corpusSha256: fingerprintPreparationCorpus(text),
  });
  await makeDue(preparation.id, "summary_next_attempt_at");
  return { sessionId, preparation };
}

describe("branch-A summary worker (integration)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.AGENT_MODEL;

  beforeEach(async () => {
    await resetDb();
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalModel;
  });

  it("sends the frozen tape with roles preserved, instruction last", async () => {
    // End-to-end through the real corpus columns: what leaves the worker is the
    // conversation itself, not a flattened transcript.
    await forkWithCorpus();
    let sent: ProviderMessage[] = [];

    await runSummaryBranchTick(WORKER, {
      makeProvider: async () => ({
        loadConfig: async () => ({ model: "test/model" }),
        chatCompletionSimple: async (messages) => {
          sent = messages;
          return { content: GOOD, usage: { cost: 0.0002 } };
        },
      }),
    });

    expect(sent.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(sent[1]?.content).toBe("please check my positions");
    expect(sent.at(-1)?.content).toMatch(/conversation above/i);
    // The corpus is never re-flattened into the instruction turn.
    expect(sent.at(-1)?.content).not.toContain("please check my positions");
  });

  it("reaches summary_ready only through validated output, stamping the prompt version", async () => {
    const { preparation } = await forkWithCorpus();

    const outcome = await runSummaryBranchTick(WORKER, {
      makeProvider: provider(GOOD),
    });
    expect(outcome).toMatchObject({ kind: "ready", preparationId: preparation.id });

    const row = await getPreparationById(preparation.id);
    expect(row?.status).toBe("summary_ready");
    expect(row?.summaryStatus).toBe("succeeded");
    expect(row?.summaryOutput).toContain("prefers Solana");
    expect(row?.summaryPromptVersion).toBe(SUMMARY_PROMPT_VERSION);
    expect(row?.summaryModel).toBe("test/model");
    expect(row?.summaryCostUsd).toBeCloseTo(0.0002, 6);
  });

  it("treats invalid output as a FAILED ATTEMPT, never as readiness", async () => {
    const { preparation } = await forkWithCorpus();

    const outcome = await runSummaryBranchTick(WORKER, {
      makeProvider: provider(JSON.stringify({ conversation_summary: "   " })),
    });
    expect(outcome).toMatchObject({ kind: "failed", terminal: false });

    const row = await getPreparationById(preparation.id);
    // The row is still `preparing` with nothing written and a backoff pending:
    // exactly one attempt burned, no readiness published.
    expect(row?.status).toBe("preparing");
    expect(row?.summaryStatus).toBe("failed");
    expect(row?.summaryOutput).toBeNull();
    expect(row?.summaryAttemptCount).toBe(1);
    expect(row?.summaryLastError).toContain("compaction_summary_rejected_empty");
  });

  it("terminalizes the row after the attempt budget is spent", async () => {
    const { preparation } = await forkWithCorpus();

    for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt += 1) {
      await makeDue(preparation.id, "summary_next_attempt_at");
      await runSummaryBranchTick(WORKER, {
        makeProvider: provider("not json at all"),
      });
    }

    const row = await getPreparationById(preparation.id);
    expect(row?.summaryAttemptCount).toBe(SUMMARY_MAX_ATTEMPTS);
    expect(row?.summaryStatus).toBe("permanently_failed");
    // No summary means no readiness and no cutover — the row itself is dead.
    expect(row?.status).toBe("failed");
  });

  it("refuses a late readiness write against a superseded row", async () => {
    const { preparation } = await forkWithCorpus();

    const outcome = await runSummaryBranchTick(WORKER, {
      makeProvider: async () => ({
        loadConfig: async () => ({ model: "test/model" }),
        chatCompletionSimple: async () => {
          // The row is superseded WHILE the call is in flight — the exact C3
          // race the state-checked CAS exists for.
          await execute(
            "UPDATE compaction_preparations SET status = 'superseded' WHERE id = $1",
            [preparation.id],
          );
          return { content: GOOD };
        },
      }),
    });

    expect(outcome).toMatchObject({ kind: "rejected", reason: "claim_lost" });
    const row = await getPreparationById(preparation.id);
    expect(row?.status).toBe("superseded");
    expect(row?.summaryOutput).toBeNull();
  });

  it("does not claim at all while the vault has not populated the provider config", async () => {
    const { preparation } = await forkWithCorpus();
    delete process.env.OPENROUTER_API_KEY;

    const outcome = await runSummaryBranchTick(WORKER);
    expect(outcome).toEqual({ kind: "idle_no_provider_config" });

    // Claiming increments the attempt counter, so a claim here would burn the
    // retry budget for a locked vault.
    const row = await getPreparationById(preparation.id);
    expect(row?.summaryAttemptCount).toBe(0);
    expect(row?.summaryStatus).toBe("pending");
  });

  it("refuses to summarise a corpus that does not match its fingerprint", async () => {
    const { preparation } = await forkWithCorpus();
    await execute(
      "UPDATE compaction_preparations SET corpus_text = $2 WHERE id = $1",
      [preparation.id, corpusText().replace("positions", "balances")],
    );

    const outcome = await runSummaryBranchTick(WORKER, {
      makeProvider: provider(GOOD),
    });

    expect(outcome).toMatchObject({ kind: "failed" });
    const row = await getPreparationById(preparation.id);
    expect(row?.summaryLastError).toContain("corpus mismatch");
    expect(row?.summaryOutput).toBeNull();
  });
});
