/**
 * Integration: fork-time capture against real Postgres.
 *
 * Capture is the only writer of the frozen preparation input, and everything
 * downstream — both branch workers, every retry, and the cutover — trusts what
 * it wrote. So these tests exercise the real transaction: real row lock, real
 * partial unique index, real concurrent clients. Mocked SQL would prove
 * nothing about a function whose whole job is what a transaction observes.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, getPool, queryOne } from "@vex-agent/db/client.js";
import {
  getLivePreparationForSession,
  getPreparationById,
  listPreparationsForSession,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { assertCorpusFingerprint } from "@vex-agent/db/repos/compaction-preparations/index.js";
import { capturePreparation } from "@vex-agent/engine/compaction-prep/capture.js";
import {
  CORPUS_FORMAT_VERSION,
  fingerprintPreparationCorpus,
  parsePreparationCorpus,
  serializePreparationCorpus,
} from "@vex-agent/engine/compaction-prep/corpus.js";
import { SUPERSEDE_MIN_NEW_MESSAGES } from "@vex-agent/engine/compaction-prep/supersession.js";
import {
  compactionPreparationBus,
  type CompactionPreparationEvent,
} from "@vex-agent/engine/runtime/compaction-bus.js";
import { insertMessage, makeSession, resetDb } from "../setup/fixtures.js";

async function capture(sessionId: string) {
  return capturePreparation({ sessionId, source: "warning_band_auto" });
}

async function setSummary(sessionId: string, summary: string | null) {
  await execute("UPDATE sessions SET summary = $2 WHERE id = $1", [
    sessionId,
    summary,
  ]);
}

async function setGeneration(sessionId: string, generation: number) {
  await execute(
    "UPDATE sessions SET checkpoint_generation = $2 WHERE id = $1",
    [sessionId, generation],
  );
}

/**
 * Insert a message WITHOUT the shared fixture's `sessions.message_count`
 * bump. That bump needs the session row lock, so using the fixture while a
 * test deliberately holds that lock would wedge the test itself rather than
 * exercise capture.
 */
async function insertMessageRow(
  sessionId: string,
  content: string,
): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW()) RETURNING id`,
    [sessionId, content],
  );
  if (!row) throw new Error("insertMessageRow: no row returned");
  return row.id;
}

let sessionId: string;

beforeEach(async () => {
  await resetDb();
  sessionId = await makeSession();
});

describe("capturePreparation — the frozen input", () => {
  it("freezes the summary as it was at fork time", async () => {
    await setSummary(sessionId, "history as of the fork");
    await insertMessage(sessionId, "user", "hello");

    const outcome = await capture(sessionId);
    expect(outcome.kind).toBe("captured");

    // Everything downstream reads the ROW, not the session — a later summary
    // rewrite must not leak into a preparation already forked.
    await setSummary(sessionId, "SOMETHING ELSE ENTIRELY");

    const live = await getLivePreparationForSession(sessionId);
    expect(live?.frozenSessionSummary).toBe("history as of the fork");
  });

  it("stores a corpus whose stored sha256 matches the stored text", async () => {
    await insertMessage(sessionId, "user", "hello");
    await insertMessage(sessionId, "assistant", "hi");

    await capture(sessionId);
    const live = await getLivePreparationForSession(sessionId);
    expect(live).not.toBeNull();
    if (!live) return;

    expect(live.corpusFormatVersion).toBe(CORPUS_FORMAT_VERSION);
    expect(live.corpusText).not.toBeNull();
    const corpusText = live.corpusText ?? "";

    // The repo's assertion helper is what every worker runs before spending an
    // inference call; it must accept the row capture just wrote.
    expect(() =>
      assertCorpusFingerprint(live, fingerprintPreparationCorpus(corpusText)),
    ).not.toThrow();

    // Round-trip: the only reader parses the stored bytes back and
    // re-serializing reproduces them exactly.
    const parsed = parsePreparationCorpus(corpusText);
    expect(serializePreparationCorpus(parsed)).toBe(corpusText);
    expect(live.corpusBytes).toBe(Buffer.byteLength(corpusText, "utf8"));
    expect(live.corpusMessageCount).toBe(parsed.entries.length);
  });

  it("takes the watermark from the MAX id, not the last chronological row", async () => {
    // `created_at` is caller-supplied, so the highest id can sort first. A
    // watermark taken from the last sorted row would leave a higher-id row
    // above the cutoff and out of the corpus the cutover archives.
    const backdatedHighId = await insertMessage(sessionId, "user", "backdated", {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    const laterLowerSort = await insertMessage(sessionId, "assistant", "later");
    expect(backdatedHighId).toBeGreaterThan(0);
    expect(laterLowerSort).toBeGreaterThan(backdatedHighId);

    // Force the ordering conflict: make the NEWEST id the OLDEST timestamp.
    await execute(
      "UPDATE messages SET created_at = NOW() - interval '2 hours' WHERE id = $1",
      [laterLowerSort],
    );

    await capture(sessionId);
    const live = await getLivePreparationForSession(sessionId);
    expect(live?.watermarkMessageId).toBe(laterLowerSort);

    const corpus = parsePreparationCorpus(live?.corpusText ?? "");
    expect(corpus.entries.map((e) => e.sourceMessageId).sort()).toEqual(
      [backdatedHighId, laterLowerSort].sort(),
    );
  });

  it("never records a watermark it did not include, even under a concurrent insert", async () => {
    await insertMessage(sessionId, "user", "inside");

    // Hold the session row so capture blocks, then insert a row it must not see
    // in its watermark.
    const blocker = await getPool().connect();
    let lateId = 0;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        sessionId,
      ]);

      const capturing = capture(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // NOT awaited before the COMMIT: inserting a message takes a
      // `FOR KEY SHARE` lock on the parent session row through the FK, which
      // conflicts with the `FOR UPDATE` this test is holding. Awaiting it here
      // would wedge the test on its own blocker instead of racing capture.
      const inserting = insertMessageRow(sessionId, "arrived during capture");
      await blocker.query("COMMIT");

      lateId = await inserting;
      const outcome = await capturing;
      expect(outcome.kind).toBe("captured");
    } finally {
      blocker.release();
    }

    // Capture's own snapshot begins when it acquires the lock, so the late row
    // is legitimately either in or out; what must NEVER happen is a corpus that
    // claims a watermark it did not include.
    const live = await getLivePreparationForSession(sessionId);
    const corpus = parsePreparationCorpus(live?.corpusText ?? "");
    const ids = corpus.entries
      .map((e) => e.sourceMessageId)
      .filter((id): id is number => id !== null);
    expect(Math.max(...ids)).toBe(live?.watermarkMessageId);
    for (const id of ids) {
      expect(id).toBeLessThanOrEqual(live?.watermarkMessageId ?? 0);
    }
    expect(lateId).toBeGreaterThan(0);
  });

  it("records the base and target generations it read under the lock", async () => {
    await setGeneration(sessionId, 4);
    await insertMessage(sessionId, "user", "hello");

    await capture(sessionId);
    const live = await getLivePreparationForSession(sessionId);
    expect(live?.baseCheckpointGeneration).toBe(4);
    expect(live?.targetCheckpointGeneration).toBe(5);
  });
});

describe("capturePreparation — one live preparation", () => {
  it("skips when a live preparation has not moved materially", async () => {
    await insertMessage(sessionId, "user", "hello");
    const first = await capture(sessionId);
    expect(first.kind).toBe("captured");

    await insertMessage(sessionId, "user", "one more");
    const second = await capture(sessionId);
    expect(second).toEqual({
      kind: "skipped",
      reason: "live_preparation_not_material",
    });

    expect(await listPreparationsForSession(sessionId, 10)).toHaveLength(1);
  });

  it("supersedes and replaces once the transcript moves materially", async () => {
    await insertMessage(sessionId, "user", "hello");
    const first = await capture(sessionId);
    expect(first.kind).toBe("captured");

    for (let i = 0; i < SUPERSEDE_MIN_NEW_MESSAGES; i++) {
      await insertMessage(sessionId, "user", `later ${i}`);
    }

    const second = await capture(sessionId);
    expect(second.kind).toBe("superseded_and_captured");
    if (second.kind !== "superseded_and_captured") return;

    const superseded = await getPreparationById(second.supersededPreparationId);
    expect(superseded?.status).toBe("superseded");
    expect(superseded?.supersededById).toBe(second.preparationId);

    // Exactly one live row survives, and it is the replacement.
    const live = await getLivePreparationForSession(sessionId);
    expect(live?.id).toBe(second.preparationId);
    expect(await listPreparationsForSession(sessionId, 10)).toHaveLength(2);
  });

  it("never supersedes a preparation whose apply was requested", async () => {
    await insertMessage(sessionId, "user", "hello");
    await capture(sessionId);
    const live = await getLivePreparationForSession(sessionId);
    await execute(
      // `cprep_ready_requires_summary` forbids reaching `apply_requested`
       // without a summary, so the fixture has to produce the real shape.
      `UPDATE compaction_preparations
       SET status = 'apply_requested', apply_source = 'ui_button', apply_requested_at = NOW(),
           summary_status = 'succeeded', summary_output = 'a validated summary',
           summary_completed_at = NOW()
       WHERE id = $1`,
      [live?.id],
    );

    for (let i = 0; i < SUPERSEDE_MIN_NEW_MESSAGES * 5; i++) {
      await insertMessage(sessionId, "user", `later ${i}`);
    }

    expect(await capture(sessionId)).toEqual({
      kind: "skipped",
      reason: "supersede_forbidden",
    });
    const after = await getPreparationById(live?.id ?? 0);
    expect(after?.status).toBe("apply_requested");
  });

  it("yields exactly one captured row under two concurrent captures", async () => {
    await insertMessage(sessionId, "user", "hello");

    const [a, b] = await Promise.all([capture(sessionId), capture(sessionId)]);

    // Exactly one fork. The loser's shape depends on where it lost: blocked on
    // the row lock it sees the winner's row and reports it as not-material;
    // racing past the read it is refused by the partial unique. Both are
    // correct and neither may create a second row — THAT is the invariant.
    const created = [a, b].filter((o) => o.kind === "captured");
    expect(created).toHaveLength(1);
    const loser = [a, b].find((o) => o.kind !== "captured");
    expect(["already_live", "skipped"]).toContain(loser?.kind);

    expect(await listPreparationsForSession(sessionId, 10)).toHaveLength(1);
  });

  it("leaves nothing behind when the session has no messages", async () => {
    expect(await capture(sessionId)).toEqual({
      kind: "skipped",
      reason: "no_messages",
    });
    expect(await listPreparationsForSession(sessionId, 10)).toHaveLength(0);
  });
});

describe("capturePreparation — exhausted branch A", () => {
  it("refuses to re-prepare the same base generation after branch A permanently failed", async () => {
    await setGeneration(sessionId, 2);
    await insertMessage(sessionId, "user", "hello");
    await capture(sessionId);
    const first = await getLivePreparationForSession(sessionId);
    await execute(
      `UPDATE compaction_preparations
       SET status = 'failed', summary_status = 'permanently_failed',
           summary_attempt_count = summary_max_attempts, completed_at = NOW()
       WHERE id = $1`,
      [first?.id],
    );

    for (let i = 0; i < SUPERSEDE_MIN_NEW_MESSAGES * 2; i++) {
      await insertMessage(sessionId, "user", `later ${i}`);
    }

    expect(await capture(sessionId)).toEqual({
      kind: "skipped",
      reason: "summary_exhausted_for_generation",
    });
    expect(await listPreparationsForSession(sessionId, 10)).toHaveLength(1);
  });

  it("becomes eligible again once the fallback bumps the generation", async () => {
    await setGeneration(sessionId, 2);
    await insertMessage(sessionId, "user", "hello");
    await capture(sessionId);
    const first = await getLivePreparationForSession(sessionId);
    await execute(
      `UPDATE compaction_preparations
       SET status = 'failed', summary_status = 'permanently_failed',
           summary_attempt_count = summary_max_attempts, completed_at = NOW()
       WHERE id = $1`,
      [first?.id],
    );

    // The deterministic fallback compacted the session.
    await setGeneration(sessionId, 3);
    await insertMessage(sessionId, "user", "after the fallback");

    const outcome = await capture(sessionId);
    expect(outcome.kind).toBe("captured");
    const live = await getLivePreparationForSession(sessionId);
    expect(live?.baseCheckpointGeneration).toBe(3);
  });
});

describe("capturePreparation — post-commit bus emit", () => {
  /**
   * Collects events AND, from inside each listener, starts an independent read
   * on a different connection. That read is the actual proof of ordering: a row
   * is only visible to another connection after COMMIT, so if the emit were
   * issued inside the transaction the read would come back empty.
   */
  function subscribeWithVisibilityProbe() {
    const events: CompactionPreparationEvent[] = [];
    const probes: Promise<{ n: string } | null>[] = [];
    const unsubscribe = compactionPreparationBus.subscribe((event) => {
      events.push(event);
      probes.push(
        queryOne<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM compaction_preparations
           WHERE session_id = $1
             AND status IN ('preparing','summary_ready','apply_requested','applying')`,
          [event.sessionId],
        ),
      );
    });
    return { events, probes, unsubscribe };
  }

  it("emits once AFTER commit, with the committed row's state", async () => {
    await insertMessage(sessionId, "user", "hello");
    const bus = subscribeWithVisibilityProbe();

    try {
      const outcome = await capture(sessionId);
      expect(outcome.kind).toBe("captured");

      expect(bus.events).toHaveLength(1);
      expect(bus.events[0]).toEqual({
        type: "engine.compaction.preparation",
        sessionId,
        status: "preparing",
        summaryReady: false,
        correlationId: null,
      });

      // The row was already committed and visible to another connection at the
      // moment the event fired.
      const [visible] = await Promise.all(bus.probes);
      expect(visible?.n).toBe("1");
    } finally {
      bus.unsubscribe();
    }
  });

  it("emits the REPLACEMENT's state on supersede-and-replace, not the superseded one", async () => {
    await insertMessage(sessionId, "user", "hello");
    await capture(sessionId);
    for (let i = 0; i < SUPERSEDE_MIN_NEW_MESSAGES; i++) {
      await insertMessage(sessionId, "user", `later ${i}`);
    }

    const bus = subscribeWithVisibilityProbe();
    try {
      const outcome = await capture(sessionId);
      expect(outcome.kind).toBe("superseded_and_captured");

      // One event for one committed transaction. `superseded` is a terminal
      // status the session surface must not be told it is in.
      expect(bus.events).toHaveLength(1);
      expect(bus.events[0].status).toBe("preparing");
      expect(bus.events[0].summaryReady).toBe(false);

      const [visible] = await Promise.all(bus.probes);
      expect(visible?.n).toBe("1");
    } finally {
      bus.unsubscribe();
    }
  });

  it("emits nothing on any rolled-back or skipped path", async () => {
    const bus = subscribeWithVisibilityProbe();
    try {
      // no_messages
      expect((await capture(sessionId)).kind).toBe("skipped");

      await insertMessage(sessionId, "user", "hello");
      await capture(sessionId); // the one legitimate emit
      const afterCapture = bus.events.length;
      expect(afterCapture).toBe(1);

      // live_preparation_not_material
      await insertMessage(sessionId, "user", "one more");
      expect((await capture(sessionId)).kind).toBe("skipped");

      // supersede_forbidden
      const live = await getLivePreparationForSession(sessionId);
      await execute(
        `UPDATE compaction_preparations
         SET status = 'apply_requested', apply_source = 'ui_button', apply_requested_at = NOW(),
             summary_status = 'succeeded', summary_output = 'a validated summary',
             summary_completed_at = NOW()
         WHERE id = $1`,
        [live?.id],
      );
      for (let i = 0; i < SUPERSEDE_MIN_NEW_MESSAGES; i++) {
        await insertMessage(sessionId, "user", `later ${i}`);
      }
      expect((await capture(sessionId)).kind).toBe("skipped");

      expect(bus.events).toHaveLength(afterCapture);
    } finally {
      bus.unsubscribe();
    }
  });
});

describe("capturePreparation — no partial state", () => {
  it("commits nothing when the session vanishes mid-transaction", async () => {
    await insertMessage(sessionId, "user", "hello");
    const orphan = randomUUID();

    // A session id that does not exist: the lock read finds no row, so the
    // generation defaults and there are no messages to capture.
    expect(await capture(orphan)).toEqual({
      kind: "skipped",
      reason: "no_messages",
    });
    const count = await queryOne<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM compaction_preparations WHERE session_id = $1",
      [orphan],
    );
    expect(count?.n).toBe("0");
  });
});
