/**
 * Shared fixtures for the `compaction_preparations` integration suites.
 *
 * `createPreparation` requires a caller-supplied client that already holds the
 * sessions row lock — that is its documented contract, and every test honours it
 * so the tests exercise the real call shape rather than a convenience wrapper
 * production never uses.
 */

import { createHash, randomUUID } from "node:crypto";

import { execute, withTransaction } from "@vex-agent/db/client.js";
import {
  FROZEN_CHUNKS_SNAPSHOT_VERSION,
  createPreparation,
  supersedeAndReplace,
  type CompactionPreparation,
  type FrozenChunksOutput,
  type NewCompactionPreparation,
} from "@vex-agent/db/repos/compaction-preparations/index.js";

export function newPreparationInput(
  sessionId: string,
  overrides: Partial<NewCompactionPreparation> = {},
): NewCompactionPreparation {
  const corpusText = overrides.corpusText ?? `corpus for ${sessionId}\nline two\n`;
  return {
    sessionId,
    watermarkMessageId: overrides.watermarkMessageId ?? 42,
    baseCheckpointGeneration: overrides.baseCheckpointGeneration ?? 0,
    targetCheckpointGeneration:
      overrides.targetCheckpointGeneration ?? (overrides.baseCheckpointGeneration ?? 0) + 1,
    frozenSessionSummary: overrides.frozenSessionSummary ?? null,
    corpusText,
    corpusSha256:
      overrides.corpusSha256 ?? createHash("sha256").update(corpusText).digest("hex"),
    corpusFormatVersion: overrides.corpusFormatVersion ?? 1,
    corpusMessageCount: overrides.corpusMessageCount ?? 12,
    corpusBytes: overrides.corpusBytes ?? Buffer.byteLength(corpusText, "utf8"),
    corpusRedactionHard: overrides.corpusRedactionHard ?? 0,
    corpusRedactionMask: overrides.corpusRedactionMask ?? 0,
  };
}

/** Fork a preparation the way capture does: inside the sessions row lock. */
export async function forkPreparation(
  sessionId: string,
  overrides: Partial<NewCompactionPreparation> = {},
): Promise<CompactionPreparation> {
  const result = await withTransaction(async (tx) => {
    await tx.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    return createPreparation(newPreparationInput(sessionId, overrides), tx);
  });
  if (!result.ok) {
    throw new Error(`forkPreparation: unexpected ${result.reason} for session ${sessionId}`);
  }
  return result.preparation;
}

export async function forkPreparationResult(
  sessionId: string,
  overrides: Partial<NewCompactionPreparation> = {},
): Promise<{ ok: boolean }> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    return createPreparation(newPreparationInput(sessionId, overrides), tx);
  });
}

export async function supersedeWithReplacement(
  previousId: number,
  sessionId: string,
  overrides: Partial<NewCompactionPreparation> = {},
): ReturnType<typeof supersedeAndReplace> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    return supersedeAndReplace(previousId, newPreparationInput(sessionId, overrides), tx);
  });
}

/**
 * A complete insert-ready snapshot — the shape branch B must freeze, including
 * the server-generated outstanding-item identity that makes a retry
 * byte-identical to the first attempt.
 */
export function frozenSnapshot(themes: readonly string[] = ["kyber_quote_timeout"]): FrozenChunksOutput {
  return {
    snapshotVersion: FROZEN_CHUNKS_SNAPSHOT_VERSION,
    chunks: themes.map((theme) => ({
      theme,
      themeSource: "chunker" as const,
      entities: [],
      protocols: [],
      errorClasses: [],
      chains: [],
      tasks: [],
      happenedMd: `happened for ${theme}`,
      didMd: "",
      triedMd: "",
      outstandingItems: [
        {
          id: randomUUID(),
          text: `follow up on ${theme}`,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          resolutionNote: null,
          resolutionSource: null,
        },
      ],
      bodyMd: `# ${theme}`,
      bodyMdHash: createHash("sha256").update(`# ${theme}`).digest("hex"),
      bodyMdSchemaVersion: "v1",
      contentHash: createHash("sha256").update(theme).digest("hex"),
    })),
  };
}

/** Age a lease past the stale threshold without waiting for wall-clock time. */
export async function ageHeartbeat(
  id: number,
  column: "summary_heartbeat_at" | "chunks_heartbeat_at" | "apply_heartbeat_at",
  ageMs: number,
): Promise<void> {
  await execute(
    `UPDATE compaction_preparations
     SET ${column} = NOW() - ($2::bigint || ' milliseconds')::interval
     WHERE id = $1`,
    [id, ageMs],
  );
}

/** Move a due timestamp into the past so a poll can pick the row up now. */
export async function makeDue(
  id: number,
  column: "summary_next_attempt_at" | "chunks_next_attempt_at",
): Promise<void> {
  await execute(
    `UPDATE compaction_preparations SET ${column} = NOW() - interval '1 second' WHERE id = $1`,
    [id],
  );
}

export async function setSessionGeneration(
  sessionId: string,
  generation: number,
): Promise<void> {
  await execute("UPDATE sessions SET checkpoint_generation = $2 WHERE id = $1", [
    sessionId,
    generation,
  ]);
}
