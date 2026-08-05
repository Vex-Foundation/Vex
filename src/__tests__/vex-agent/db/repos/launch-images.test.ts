/**
 * `launch_images` repo — the locker METADATA and its lifecycle rule (C2).
 *
 * The behaviour worth protecting is the DELETE refusal, and specifically that it
 * is ATOMIC. C2 says an explicit deletion refuses while a LIVE (non-terminal)
 * intent references the image, and names it. If the check and the delete were
 * two calls, an intent created between them would have its image deleted out
 * from under a launch that is about to sign — a real-funds bug that a
 * check-then-delete caller cannot avoid on its own. So the rule lives inside the
 * repo, in one transaction, and that is what these tests pin.
 *
 * Also pinned: the reads are GLOBAL (an image belongs to the user, not to a
 * session — the deliberate asymmetry with `token_launch_intents`), and "live"
 * means exactly the four non-terminal statuses, taken from the shared constant
 * rather than re-listed here.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;
type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQueryOne: QueryOneMock;
let mockQuery: QueryMock;
/** Every statement the transaction ran, in order: `[sql, params]`. */
let txCalls: [string, unknown[]][];
/** Rows the fake transaction client returns, keyed by statement order. */
let txRows: Record<string, unknown>[][];

function resetMocks(): void {
  mockQueryOne = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
  txCalls = [];
  txRows = [];
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: vi.fn(),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params: unknown[]) => {
        txCalls.push([sql, params]);
        return { rows: txRows[txCalls.length - 1] ?? [], rowCount: (txRows[txCalls.length - 1] ?? []).length };
      },
    }),
}));

const repo = await import("@vex-agent/db/repos/launch-images.js");
const { EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES, LIVE_TOKEN_LAUNCH_INTENT_STATUSES } =
  await import("@vex-agent/db/repos/token-launch-intents.js");
const { launchImageLockKey } = await import("@vex-agent/db/repos/launch-image-lock.js");

beforeEach(() => resetMocks());

const IMAGE_ID = "img_0123456789abcdef0123456789abcdef";

function imageRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image_id: IMAGE_ID,
    label: "rocket.png",
    byte_length: 8192,
    mime: "image/png",
    width: 512,
    height: 512,
    digest: "a".repeat(64),
    uploaded_at: new Date("2026-08-02T10:00:00.000Z"),
    ...over,
  };
}

function liveIntentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { intent_id: "launch-intent-001", status: "authorized", name: "Test Coin", ...over };
}

describe("reads are GLOBAL — an image belongs to the user, not a session", () => {
  it("listLaunchImages is unscoped and most-recent-first", async () => {
    mockQuery.mockResolvedValue([imageRow()]);
    const rows = await repo.listLaunchImages();
    expect(rows).toHaveLength(1);
    const sql = mockQuery.mock.calls[0]![0].replace(/\s+/g, " ");
    expect(sql).toContain("ORDER BY uploaded_at DESC, image_id DESC");
    expect(sql).not.toContain("session_id");
  });

  it("getLaunchImage takes only the opaque id", async () => {
    mockQueryOne.mockResolvedValue(imageRow());
    const row = await repo.getLaunchImage(IMAGE_ID);
    expect(row?.imageId).toBe(IMAGE_ID);
    expect(row?.uploadedAt).toBe("2026-08-02T10:00:00.000Z");
    expect(mockQueryOne.mock.calls[0]![1]).toEqual([IMAGE_ID]);
  });

  it("insertLaunchImage does not accept an uploadedAt — the DB assigns it", async () => {
    mockQueryOne.mockResolvedValue(imageRow());
    await repo.insertLaunchImage({
      imageId: IMAGE_ID, label: "rocket.png", byteLength: 8192,
      mime: "image/png", width: 512, height: 512, digest: "a".repeat(64),
    });
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO launch_images");
    expect(params).toHaveLength(7);
  });
});

describe("findLiveIntentsReferencingImage", () => {
  it("asks for exactly the shared LIVE status set — never a re-listed copy", async () => {
    mockQuery.mockResolvedValue([liveIntentRow()]);
    const intents = await repo.findLiveIntentsReferencingImage(IMAGE_ID);
    expect(intents).toEqual([
      { intentId: "launch-intent-001", status: "authorized", name: "Test Coin" },
    ]);
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params![1]).toBe(LIVE_TOKEN_LAUNCH_INTENT_STATUSES);
  });
});

// ── the lapsed-window half of "live" ────────────────────────────────────────
//
// THE LIVE BUG THIS PINS (owner report, 2026-08-05): a user launched a token
// successfully and could then never delete its image from the locker again. The
// `confirmed` intent was not the blocker — an EARLIER attempt on the same image
// was, stranded at `authorized` by a refusal that returned before the consume
// CAS. `authorized` can only move forward through `consumeIfAuthorizedWith`,
// whose predicate carries `expires_at > NOW()`, so once that window lapsed the
// row could never sign again; and the expiry sweep only stamps
// `awaiting_user_form`, so nothing would ever retire it. The refusal outlived
// the launch it existed to protect, permanently.
//
// These are SQL-SHAPE pins, like the lock pin below: the client is mocked, so
// they prove the predicate is issued with the right parameters, not that
// Postgres evaluates it. `expires_at` is compared in the database with NOW() so
// the clock is never this process's.
describe("a launch that can no longer sign does not block deletion", () => {
  function liveIntentsPredicate(sql: string): string {
    return sql.replace(/\s+/g, " ");
  }

  it("exempts the expiry-bound statuses whose window has lapsed", async () => {
    await repo.findLiveIntentsReferencingImage(IMAGE_ID);
    const firstCall = mockQuery.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected a query call");
    const [sql, params] = firstCall;
    expect(liveIntentsPredicate(sql)).toContain(
      "AND (NOT (status = ANY($3::text[])) OR expires_at > NOW())",
    );
    if (params === undefined) throw new Error("expected query params");
    expect(params[2]).toBe(EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES);
  });

  it("applies the SAME predicate inside the delete transaction, not just the preflight", async () => {
    txRows = [[], [], [imageRow()]];
    await repo.deleteLaunchImage(IMAGE_ID);
    const secondCall = txCalls[1];
    if (secondCall === undefined) throw new Error("expected a gate query inside the transaction");
    const [sql, params] = secondCall;
    expect(liveIntentsPredicate(sql)).toContain("OR expires_at > NOW()");
    expect((params as unknown[])[2]).toBe(EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES);
  });

  it("the expiry-bound set is exactly the two PRE-SIGNING statuses", () => {
    // `consuming` may still sign after its window lapses
    // (`markBroadcastPendingWith` has no expiry predicate) and
    // `broadcast_pending` already signed. Admitting either here would delete an
    // image out from under a real launch, which is the guard's whole purpose.
    expect([...EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES].sort()).toEqual([
      "authorized",
      "awaiting_user_form",
    ]);
    for (const status of EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES) {
      expect(LIVE_TOKEN_LAUNCH_INTENT_STATUSES).toContain(status);
    }
  });
});

describe("deleteLaunchImage — the refusal is ATOMIC with the delete", () => {
  it("refuses while a live intent references the image, and NAMES it", async () => {
    txRows = [[], [liveIntentRow({ name: "Rocket Coin" })]];
    const result = await repo.deleteLaunchImage(IMAGE_ID);
    expect(result).toEqual({
      deleted: false,
      reason: "referenced_by_live_intent",
      intents: [{ intentId: "launch-intent-001", status: "authorized", name: "Rocket Coin" }],
    });
  });

  it("runs NO delete statement when it refuses", async () => {
    txRows = [[], [liveIntentRow()]];
    await repo.deleteLaunchImage(IMAGE_ID);
    expect(txCalls).toHaveLength(2);
    expect(txCalls.map(([sql]) => sql).join(" ")).not.toMatch(/DELETE/i);
  });

  // ── the serialization pin ────────────────────────────────────────────────
  //
  // Sharing one client is NOT serialization. Postgres READ COMMITTED lets a
  // concurrent transaction insert an intent that this transaction's reference
  // check never sees, and there is no foreign key to stop it (the refusal is
  // status-conditional, which an FK cannot express). So the delete takes the
  // image's advisory lock FIRST — the same lock every intent write that
  // references an image takes — and only then checks and deletes.
  //
  // RESIDUAL GAP: this suite mocks the pg client, so this is a SQL-SHAPE pin.
  // It proves the lock statement is issued with the right key before the
  // check; it cannot prove Postgres blocks the concurrent writer. That needs a
  // real database and two connections, which this repo has no harness for.
  it("takes the image's advisory lock BEFORE the reference check", async () => {
    txRows = [[], [], [imageRow()]];
    const result = await repo.deleteLaunchImage(IMAGE_ID);
    expect(result).toEqual({ deleted: true, row: expect.objectContaining({ imageId: IMAGE_ID }) });
    expect(txCalls).toHaveLength(3);
    expect(txCalls[0]![0]).toContain("pg_advisory_xact_lock");
    expect(txCalls[0]![1]).toEqual([launchImageLockKey(IMAGE_ID)]);
    expect(txCalls[1]![0]).toContain("FROM token_launch_intents");
    expect(txCalls[2]![0]).toMatch(/DELETE FROM launch_images/);
  });

  it("holds the lock even on the refusal path — the check itself must be serialized", async () => {
    txRows = [[], [liveIntentRow()]];
    await repo.deleteLaunchImage(IMAGE_ID);
    expect(txCalls[0]![0]).toContain("pg_advisory_xact_lock");
  });

  it("a TERMINAL intent does not block deletion", async () => {
    // The status predicate is the live set, so a confirmed/cancelled/expired
    // intent returns no blocking row and the delete proceeds.
    txRows = [[], [], [imageRow()]];
    const result = await repo.deleteLaunchImage(IMAGE_ID);
    expect(result.deleted).toBe(true);
  });

  it("reports not_found rather than pretending a delete happened", async () => {
    txRows = [[], [], []];
    expect(await repo.deleteLaunchImage(IMAGE_ID)).toEqual({
      deleted: false,
      reason: "not_found",
    });
  });
});
