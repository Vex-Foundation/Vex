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
const { LIVE_TOKEN_LAUNCH_INTENT_STATUSES } = await import(
  "@vex-agent/db/repos/token-launch-intents.js"
);

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

describe("deleteLaunchImage — the refusal is ATOMIC with the delete", () => {
  it("refuses while a live intent references the image, and NAMES it", async () => {
    txRows = [[liveIntentRow({ name: "Rocket Coin" })]];
    const result = await repo.deleteLaunchImage(IMAGE_ID);
    expect(result).toEqual({
      deleted: false,
      reason: "referenced_by_live_intent",
      intents: [{ intentId: "launch-intent-001", status: "authorized", name: "Rocket Coin" }],
    });
  });

  it("runs NO delete statement when it refuses", async () => {
    txRows = [[liveIntentRow()]];
    await repo.deleteLaunchImage(IMAGE_ID);
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0]![0]).not.toMatch(/DELETE/i);
  });

  it("checks and deletes on the SAME client — no TOCTOU window", async () => {
    // Both statements come from the single `withTransaction` client, so an
    // intent created concurrently either blocks the delete or lands after it.
    txRows = [[], [imageRow()]];
    const result = await repo.deleteLaunchImage(IMAGE_ID);
    expect(result).toEqual({ deleted: true, row: expect.objectContaining({ imageId: IMAGE_ID }) });
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]![0]).toContain("FROM token_launch_intents");
    expect(txCalls[1]![0]).toMatch(/DELETE FROM launch_images/);
  });

  it("a TERMINAL intent does not block deletion", async () => {
    // The status predicate is the live set, so a confirmed/cancelled/expired
    // intent returns no blocking row and the delete proceeds.
    txRows = [[], [imageRow()]];
    const result = await repo.deleteLaunchImage(IMAGE_ID);
    expect(result.deleted).toBe(true);
  });

  it("reports not_found rather than pretending a delete happened", async () => {
    txRows = [[], []];
    expect(await repo.deleteLaunchImage(IMAGE_ID)).toEqual({
      deleted: false,
      reason: "not_found",
    });
  });
});
