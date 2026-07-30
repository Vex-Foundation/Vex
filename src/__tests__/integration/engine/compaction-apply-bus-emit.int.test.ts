/**
 * Integration: the apply surface's POST-COMMIT bus emits — real Postgres.
 *
 * The bus contract is binding: producers emit only AFTER the transaction that
 * made the row fetchable has COMMITTED. The renderer treats the event purely as
 * an invalidation signal and immediately re-reads the preparation, so an emit
 * issued inside the transaction would make that refetch observe the OLD state
 * and then not refetch again until the 60 s fallback poll.
 *
 * That ordering is unobservable from a mock, so every listener here re-reads the
 * row FROM THE DATABASE at emit time and records what it saw. "Emitted after
 * commit" therefore means something falsifiable: the committed status was
 * already visible to an independent reader when the event fired.
 *
 * Two negative properties matter as much as the positive ones, and both are the
 * kind that pass vacuously if you only assert on happy paths:
 *   - a ROLLED-BACK cutover emits nothing for the transition that did not
 *     happen;
 *   - a LOST CAS emits nothing, because this process did not perform it.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import {
  compactionPreparationBus,
  COMPACTION_PREPARATION_EVENT_TYPE,
  type CompactionPreparationEvent,
} from "@vex-agent/engine/runtime/compaction-bus.js";
import {
  commitPreparation,
  requestApply,
} from "@vex-agent/engine/compaction/apply/index.js";
import { enqueueSessionStopRequest } from "@vex-agent/engine/runtime/lease-and-status.js";
import { makeSession, insertMessage, resetDb } from "../setup/fixtures.js";
import { forkPreparation } from "../repos/compaction-preparation-fixtures.js";

interface Observed {
  readonly event: CompactionPreparationEvent;
  /** The row's status as an INDEPENDENT reader saw it at emit time. */
  readonly statusInDbAtEmit: string;
}

let observed: Observed[] = [];
let unsubscribe: (() => void) | null = null;
let pendingReads: Promise<void>[] = [];

function listenWithDbReadback(preparationId: () => number): void {
  unsubscribe = compactionPreparationBus.subscribe((event) => {
    // The bus is synchronous, so capture the read-back as a promise the test
    // awaits before asserting.
    pendingReads.push(
      (async () => {
        const row = await queryOne<{ status: string }>(
          "SELECT status FROM compaction_preparations WHERE id = $1",
          [preparationId()],
        );
        observed.push({ event, statusInDbAtEmit: row?.status ?? "missing" });
      })(),
    );
  });
}

async function settle(): Promise<void> {
  await Promise.all(pendingReads);
}

describe("compaction apply — post-commit bus emits", () => {
  let sessionId: string;
  let leaseId: string;
  let ids: number[];
  let prepId = 0;

  beforeEach(async () => {
    await resetDb();
    observed = [];
    pendingReads = [];
    compactionPreparationBus.clear();
    sessionId = await makeSession();
    leaseId = `runner-${randomUUID()}`;
    await runnerLeasesRepo.acquireLease({
      sessionId,
      ownerId: leaseId,
      processKind: "electron_main",
      ttlMs: 600_000,
    });
    ids = [
      await insertMessage(sessionId, "user", "first"),
      await insertMessage(sessionId, "assistant", "second"),
      await insertMessage(sessionId, "user", "third"),
      await insertMessage(sessionId, "assistant", "fourth"),
    ];
    listenWithDbReadback(() => prepId);
  });

  afterEach(() => {
    unsubscribe?.();
    compactionPreparationBus.clear();
  });

  async function makeReady(): Promise<number> {
    const prep = await forkPreparation(sessionId, { watermarkMessageId: ids[1]! });
    prepId = prep.id;
    const workerId = `summary-${randomUUID()}`;
    await preparationsRepo.claimBranch("summary", workerId);
    const ready = await preparationsRepo.casSummaryReady(prep.id, workerId, {
      summary: "the compacted narrative",
      promptVersion: "v1.0.0",
      provider: "openrouter",
      model: "test-model",
      costUsd: null,
    });
    expect(ready.ok).toBe(true);
    return prep.id;
  }

  it("requestApply emits apply_requested AFTER its CAS is visible in the DB", async () => {
    await makeReady();

    const outcome = await requestApply({ sessionId, source: "ui_button" });
    await settle();

    expect(outcome.kind).toBe("queued");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.event).toEqual({
      type: COMPACTION_PREPARATION_EVENT_TYPE,
      sessionId,
      status: "apply_requested",
      summaryReady: true,
      correlationId: null,
    });
    // The falsifiable half: the transition was already committed and readable.
    expect(observed[0]!.statusInDbAtEmit).toBe("apply_requested");
  });

  it("a SECOND request emits nothing — it changed no row", async () => {
    await makeReady();
    await requestApply({ sessionId, source: "ui_button" });
    await settle();
    observed = [];

    const second = await requestApply({ sessionId, source: "agent_tool" });
    await settle();

    expect(second.kind).toBe("already_requested");
    expect(observed).toHaveLength(0);
  });

  it("a refused request (still preparing) emits nothing", async () => {
    const prep = await forkPreparation(sessionId, { watermarkMessageId: ids[1]! });
    prepId = prep.id;

    const outcome = await requestApply({ sessionId, source: "ui_button" });
    await settle();

    expect(outcome.kind).toBe("not_ready");
    expect(observed).toHaveLength(0);
  });

  it("the full happy path emits applying then applied, each after its commit", async () => {
    const id = await makeReady();
    await preparationsRepo.casRequestApply(id, "ui_button");
    observed = [];

    // Tx A, exactly as the boundary consumer performs it.
    const begun = await preparationsRepo.casBeginApply(id, leaseId);
    expect(begun.ok).toBe(true);
    // The consumer emits this immediately after Tx A commits; assert the same
    // ordering property the production call site relies on.
    const applyingVisible = await queryOne<{ status: string }>(
      "SELECT status FROM compaction_preparations WHERE id = $1",
      [id],
    );
    expect(applyingVisible?.status).toBe("applying");

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId: id,
      runnerLeaseId: leaseId,
      mode: "requested",
    });
    await settle();

    expect(result.kind).toBe("applied");
    expect(observed.map((o) => o.event.status)).toEqual(["applied"]);
    // The cutover's own COMMIT had landed before the event fired.
    expect(observed[0]!.statusInDbAtEmit).toBe("applied");
    expect(observed[0]!.event.summaryReady).toBe(true);
  });

  it("a ROLLED-BACK cutover emits the DEFERRAL only — never `applied`", async () => {
    const id = await makeReady();
    await preparationsRepo.casRequestApply(id, "ui_button");
    await preparationsRepo.casBeginApply(id, leaseId);
    // A queued stop makes Tx B roll back before the cutover.
    await enqueueSessionStopRequest({ sessionId });
    observed = [];

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId: id,
      runnerLeaseId: leaseId,
      mode: "requested",
    });
    await settle();

    expect(result.kind).toBe("stop_queued");
    // The transition that did NOT happen is not announced; the one that did
    // (the release back to `apply_requested`) is.
    expect(observed.map((o) => o.event.status)).toEqual(["apply_requested"]);
    expect(observed[0]!.statusInDbAtEmit).toBe("apply_requested");
  });

  it("an unsatisfiable request emits the terminal `failed`, after it commits", async () => {
    const id = await makeReady();
    await preparationsRepo.casRequestApply(id, "ui_button");
    await preparationsRepo.casBeginApply(id, leaseId);
    // A concurrent compaction moved the generation out from under the request.
    await execute("UPDATE sessions SET checkpoint_generation = 9 WHERE id = $1", [
      sessionId,
    ]);
    observed = [];

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId: id,
      runnerLeaseId: leaseId,
      mode: "requested",
    });
    await settle();

    expect(result.kind).toBe("generation_moved");
    expect(observed.map((o) => o.event.status)).toEqual(["failed"]);
    expect(observed[0]!.statusInDbAtEmit).toBe("failed");
  });

  it("a LOST CAS emits nothing — this process performed no transition", async () => {
    const id = await makeReady();
    await preparationsRepo.casRequestApply(id, "ui_button");
    await preparationsRepo.casBeginApply(id, leaseId);
    observed = [];

    // Another runner owns the apply lease, so every release CAS misses.
    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId: id,
      runnerLeaseId: `other-${randomUUID()}`,
      mode: "requested",
    });
    await settle();

    expect(result.kind).toBe("preparation_not_applicable");
    expect(observed).toHaveLength(0);
    // The row is untouched by the loser — still owned by the real holder.
    const row = await preparationsRepo.getPreparationById(id);
    expect(row?.status).toBe("applying");
    expect(row?.applyLockedBy).toBe(leaseId);
  });
});
