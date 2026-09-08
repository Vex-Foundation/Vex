/**
 * THE VOCABULARY GATE AT VERSION 4, and the defect a widening introduces every
 * time.
 *
 * Widening the reportable vocabulary makes rows that ALREADY EXIST newly
 * eligible, so each arm is gated at the version that introduced IT - never at
 * "the current version". The V3 arm was written against
 * `AGENTSCAN_VOCABULARY_VERSION` while that constant happened to be 3, which
 * reads correctly and is a latent defect: the moment the constant moves to 4,
 * that arm silently re-gates itself at 4 and an installation that already
 * covered V3 stops reporting its historical launch fees, waiting for a backfill
 * it will never be asked to run. This suite pins each arm to its own literal.
 *
 * The second half pins the FILL LEDGER's own scan: it is gated at 4 with the
 * same two-part discipline (the database carries the widening, and this scan is
 * either the controlled backfill or runs after one that covered the
 * vocabulary), so fills written before this install ever registered are
 * reported as history rather than as live activity.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

const mockExecuteWith = vi.fn().mockResolvedValue(3);
const mockQueryOneWith = vi.fn();
const mockWithTransaction = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn().mockResolvedValue(1),
  executeWith: (...args: unknown[]) => mockExecuteWith(...args),
  queryOne: vi.fn().mockResolvedValue(null),
  queryOneWith: (...args: unknown[]) => mockQueryOneWith(...args),
  queryWith: vi.fn().mockResolvedValue([]),
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}));

const repo = await import("@vex-agent/db/repos/agentscan-reporting.js");

async function reportingSource(): Promise<string> {
  return readFile(
    new URL("../../../vex-agent/db/repos/agentscan-reporting.ts", import.meta.url),
    "utf8",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteWith.mockResolvedValue(3);
  mockQueryOneWith.mockResolvedValue({ registration_generation: 7 });
  mockWithTransaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => run({}));
});

describe("the version constants", () => {
  it("walks to 4 for the Lighter vocabulary", () => {
    expect(repo.AGENTSCAN_VOCABULARY_VERSION).toBe(4);
    expect(repo.LIGHTER_VOCABULARY_VERSION).toBe(4);
  });

  it("pins each earlier arm to its OWN literal, so a widening never re-gates it", async () => {
    const source = await reportingSource();
    // The launch-fee arm belongs to migration 111 and stays at 3 forever.
    expect(source).toContain("const LAUNCH_FEE_VOCABULARY_VERSION = 3;");
    expect(source).toContain("const LAUNCHPAD_FAMILY_VOCABULARY_VERSION = 2;");
    expect(source).toContain("ELIGIBLE_VOCABULARY_V3_SQL}\n         AND s.vocabulary_version >= ${LAUNCH_FEE_VOCABULARY_VERSION}");
  });
});

describe("the fill ledger's diff scan", () => {
  it("is fenced on the caller's registration generation", async () => {
    mockQueryOneWith.mockResolvedValue({ registration_generation: 9 });

    const outcome = await repo.enqueueEligibleLighterFills(false, 7);

    expect(outcome).toEqual({ kind: "stale_generation", rows: 0 });
    expect(mockExecuteWith).not.toHaveBeenCalled();
  });

  it("enqueues at the current generation and reports the rows", async () => {
    const outcome = await repo.enqueueEligibleLighterFills(false, 7);
    expect(outcome).toEqual({ kind: "applied", rows: 3 });
  });

  it("gates on the database carrying the widening AND on backfill coverage", async () => {
    await repo.enqueueEligibleLighterFills(false, 7);
    const [, sql] = mockExecuteWith.mock.calls[0] ?? [];
    expect(String(sql)).toContain("s.vocabulary_version >= 4");
    expect(String(sql)).toContain("$1::boolean OR s.backfill_vocabulary_version >= 4");
  });

  it("writes fills into their own id space, never the activity foreign key", async () => {
    await repo.enqueueEligibleLighterFills(false, 7);
    const [, sql] = mockExecuteWith.mock.calls[0] ?? [];
    expect(String(sql)).toContain("INSERT INTO agentscan_outbox (source_kind, lighter_fill_id, status, backfill)");
    expect(String(sql)).toContain("'lighter_fill'");
    expect(String(sql)).not.toContain("activity_id");
  });

  it("enqueues exactly one confirmed pair per fill", async () => {
    await repo.enqueueEligibleLighterFills(false, 7);
    const [, sql] = mockExecuteWith.mock.calls[0] ?? [];
    // A fill's economics are settled when the provider matched it: there is no
    // pending snapshot and no terminal transition to wait for.
    expect(String(sql)).toContain("'confirmed'");
    expect(String(sql)).toContain("NOT EXISTS (SELECT 1 FROM agentscan_outbox o");
  });
});

describe("the controlled backfill", () => {
  it("covers BOTH ledgers before it marks the vocabulary as covered", async () => {
    mockQueryOneWith.mockResolvedValue({
      registration_generation: 7,
      backfill_enqueued_at: null,
      backfill_vocabulary_version: null,
    });

    const outcome = await repo.enqueueBackfillAndMark({ startedAtGeneration: 7 });

    const statements = mockExecuteWith.mock.calls.map((call) => String(call[1]));
    expect(statements.some((sql) => sql.includes("FROM agent_activity a"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM lighter_fills f"))).toBe(true);
    // Marking coverage while scanning one of the two would leave the other
    // permanently blocked by its own gate's second condition.
    expect(statements.some((sql) => sql.includes("backfill_vocabulary_version = GREATEST"))).toBe(true);
    expect(outcome.marked).toBe(true);
  });

  it("declines without scanning either ledger when the generation moved", async () => {
    mockQueryOneWith.mockResolvedValue({
      registration_generation: 8,
      backfill_enqueued_at: null,
      backfill_vocabulary_version: null,
    });

    const outcome = await repo.enqueueBackfillAndMark({ startedAtGeneration: 7 });

    expect(outcome).toEqual({ enqueued: 0, marked: false, declined: "generation_moved" });
    expect(mockExecuteWith).not.toHaveBeenCalled();
  });

  it("declines when a backfill already covered this vocabulary", async () => {
    mockQueryOneWith.mockResolvedValue({
      registration_generation: 7,
      backfill_enqueued_at: new Date(),
      backfill_vocabulary_version: 4,
    });

    const outcome = await repo.enqueueBackfillAndMark({ startedAtGeneration: 7 });

    expect(outcome).toEqual({ enqueued: 0, marked: false, declined: "already_marked" });
  });

  it("runs again when the vocabulary widened past what the last backfill covered", async () => {
    mockQueryOneWith.mockResolvedValue({
      registration_generation: 7,
      backfill_enqueued_at: new Date(),
      backfill_vocabulary_version: 3,
    });

    const outcome = await repo.enqueueBackfillAndMark({ startedAtGeneration: 7 });

    expect(outcome.declined).toBeNull();
    expect(outcome.marked).toBe(true);
  });
});

describe("the exchange funding arm", () => {
  it("admits exactly the two funding roles, gated at 4", async () => {
    const source = await reportingSource();
    expect(source).toContain("a.event_role IN ('exchange_deposit','exchange_withdrawal')");
    expect(source).toContain("ELIGIBLE_VOCABULARY_V4_SQL}\n         AND s.vocabulary_version >= ${LIGHTER_VOCABULARY_VERSION}");
  });

  it("does not admit a fill through the activity scan, which has no fill row to find", async () => {
    const source = await reportingSource();
    expect(source).not.toContain("'perp_fill'");
    expect(source).not.toContain("'spot_fill'");
  });
});
