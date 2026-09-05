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
    public_cid: null,
    public_url: null,
    public_uploaded_at: null,
    ...over,
  };
}

const PUBLIC_CID = "c".repeat(64);
const PUBLIC_URL = `https://assets.example/a/${PUBLIC_CID}.png`;
const PUBLISHED_AT = new Date("2026-09-01T12:00:00.000Z");

function publishedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return imageRow({
    public_cid: PUBLIC_CID,
    public_url: PUBLIC_URL,
    public_uploaded_at: PUBLISHED_AT,
    ...over,
  });
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
      onchainByteLength: 8192, onchainDigest: "a".repeat(64),
    });
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO launch_images");
    // Nine columns since migration 083: the seven original ones plus the
    // Trench on-chain copy's length and digest. `uploaded_at` is still absent.
    expect(params).toHaveLength(9);
  });

  it("carries the on-chain variant BOTH ways, including its absence", async () => {
    // `null`/`null` is the pools-only image: a real, launchable picture with no
    // copy inside Trench's calldata budget. It must survive the round trip as
    // NULL rather than being coerced into a number the launch path would trust.
    mockQueryOne.mockResolvedValue(
      imageRow({ onchain_byte_length: null, onchain_digest: null }),
    );
    const row = await repo.getLaunchImage(IMAGE_ID);
    expect(row?.onchainByteLength).toBeNull();
    expect(row?.onchainDigest).toBeNull();

    mockQueryOne.mockResolvedValue(
      imageRow({ onchain_byte_length: 14_000, onchain_digest: "b".repeat(64) }),
    );
    const derived = await repo.getLaunchImage(IMAGE_ID);
    expect(derived?.onchainByteLength).toBe(14_000);
    expect(derived?.onchainDigest).toBe("b".repeat(64));
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

// -- the public asset (migration 106) ----------------------------------------
//
// A launchpad's on-chain `image` is a URL, and a URL is mutable by whoever
// serves it. Vex publishes the locker bytes to a content-addressed host so the
// committed address can be re-verified against the bytes before signing. The
// three columns record that ONE publication, and the behaviour worth pinning is
// that the record can never be half-set, never silently overwritten, and never
// mistaken for a withdrawal.
//
// Same harness caveat as the lock pins above: the pg client is mocked, so these
// prove the repo's own decisions and the statements it issues, not that Postgres
// evaluates the CHECKs. The migration's constraints are proved separately
// against a real database.
describe("public asset - reading it back", () => {
  it("is null on a fresh row, which means NOT PUBLISHED", async () => {
    mockQueryOne.mockResolvedValue(imageRow());
    const row = await repo.getLaunchImage(IMAGE_ID);
    expect(row?.publicCid).toBeNull();
    expect(row?.publicUrl).toBeNull();
    expect(row?.publicUploadedAt).toBeNull();
  });

  it("survives a get round trip with the timestamp as an ISO string", async () => {
    mockQueryOne.mockResolvedValue(publishedRow());
    const row = await repo.getLaunchImage(IMAGE_ID);
    expect(row?.publicCid).toBe(PUBLIC_CID);
    expect(row?.publicUrl).toBe(PUBLIC_URL);
    expect(row?.publicUploadedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("survives a listing round trip", async () => {
    mockQuery.mockResolvedValue([publishedRow(), imageRow({ image_id: "img_other" })]);
    const rows = await repo.listLaunchImages();
    expect(rows[0]!.publicUrl).toBe(PUBLIC_URL);
    expect(rows[1]!.publicUrl).toBeNull();
    expect(mockQuery.mock.calls[0]![0]).toContain("public_uploaded_at");
  });

  it("an insert cannot claim a publication - a staged image is never published", async () => {
    mockQueryOne.mockResolvedValue(imageRow());
    await repo.insertLaunchImage({
      imageId: IMAGE_ID, label: "rocket.png", byteLength: 8192,
      mime: "image/png", width: 512, height: 512, digest: "a".repeat(64),
      onchainByteLength: 8192, onchainDigest: "a".repeat(64),
    });
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    // Still the nine 083 columns. Publication is a separate, later act with its
    // own writer, which is where the cid validation and idempotence rule live.
    expect(params).toHaveLength(9);
    // The RETURNING clause reads the public columns back (they are part of the
    // row); the INSERT column list must not WRITE them.
    const inserted = sql.slice(0, sql.indexOf("VALUES"));
    expect(inserted).not.toContain("public_cid");
    expect(inserted).not.toContain("public_url");
    expect(inserted).not.toContain("public_uploaded_at");
  });
});

describe("recordPublicAsset", () => {
  it("sets all three and lets the DATABASE stamp the time", async () => {
    txRows = [[], [imageRow()], [publishedRow()]];
    const row = await repo.recordPublicAsset(IMAGE_ID, { cid: PUBLIC_CID, url: PUBLIC_URL });
    expect(row).toEqual(expect.objectContaining({
      publicCid: PUBLIC_CID,
      publicUrl: PUBLIC_URL,
      publicUploadedAt: "2026-09-01T12:00:00.000Z",
    }));
    const [sql, params] = txCalls[2]!;
    expect(sql).toContain("public_uploaded_at = NOW()");
    // Three params: the id, the cid and the url. A caller-supplied timestamp
    // would be a second source of truth for when bytes became public.
    expect(params).toEqual([IMAGE_ID, PUBLIC_CID, PUBLIC_URL]);
  });

  it("serializes under the image's advisory lock before it reads", async () => {
    txRows = [[], [imageRow()], [publishedRow()]];
    await repo.recordPublicAsset(IMAGE_ID, { cid: PUBLIC_CID, url: PUBLIC_URL });
    expect(txCalls[0]![0]).toContain("pg_advisory_xact_lock");
    expect(txCalls[0]![1]).toEqual([launchImageLockKey(IMAGE_ID)]);
    expect(txCalls[1]![0]).toContain("SELECT");
  });

  it("re-recording the SAME publication is idempotent and runs NO write", async () => {
    // The upload is idempotent by content, so this is the ordinary outcome of
    // publishing an image a second time. `public_uploaded_at` records when the
    // bytes became public and must not slide forward on a re-confirmation.
    txRows = [[], [publishedRow()]];
    const row = await repo.recordPublicAsset(IMAGE_ID, { cid: PUBLIC_CID, url: PUBLIC_URL });
    expect(row?.publicUploadedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(txCalls).toHaveLength(2);
    expect(txCalls.map(([sql]) => sql).join(" ")).not.toMatch(/UPDATE/i);
  });

  it("REFUSES a different cid over an existing one, and writes nothing", async () => {
    // The bytes of a locker row never change (the row carries a `digest` of
    // exactly those bytes), so a second, different cid means something upstream
    // is wrong. Overwriting would destroy the only handle for withdrawing the
    // copy actually on the host - a URL that may already be on chain.
    txRows = [[], [publishedRow()]];
    await expect(
      repo.recordPublicAsset(IMAGE_ID, { cid: "d".repeat(64), url: "https://assets.example/a/x.png" }),
    ).rejects.toThrow(repo.PublicAssetConflictError);
    expect(txCalls.map(([sql]) => sql).join(" ")).not.toMatch(/UPDATE/i);
  });

  it("REFUSES the same cid at a different URL - that is a different publication", async () => {
    txRows = [[], [publishedRow()]];
    await expect(
      repo.recordPublicAsset(IMAGE_ID, { cid: PUBLIC_CID, url: "https://other.example/a/x.png" }),
    ).rejects.toThrow(repo.PublicAssetConflictError);
  });

  it("refuses a malformed cid BY NAME without touching the database", async () => {
    for (const bad of ["", "not-a-cid", "C".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      await expect(
        repo.recordPublicAsset(IMAGE_ID, { cid: bad, url: PUBLIC_URL }),
      ).rejects.toThrow(/invalid cid/);
    }
    expect(txCalls).toHaveLength(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it("returns null for an unknown image rather than pretending it published", async () => {
    txRows = [[], []];
    expect(await repo.recordPublicAsset(IMAGE_ID, { cid: PUBLIC_CID, url: PUBLIC_URL })).toBeNull();
    expect(txCalls.map(([sql]) => sql).join(" ")).not.toMatch(/UPDATE/i);
  });
});

describe("clearPublicAsset - forgets the record, does not withdraw the bytes", () => {
  it("nulls all three and reports the change", async () => {
    mockQueryOne.mockResolvedValue({ image_id: IMAGE_ID });
    expect(await repo.clearPublicAsset(IMAGE_ID)).toBe(true);
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    const flat = sql.replace(/\s+/g, " ");
    expect(flat).toContain("public_cid = NULL");
    expect(flat).toContain("public_url = NULL");
    expect(flat).toContain("public_uploaded_at = NULL");
    expect(params).toEqual([IMAGE_ID]);
  });

  it("reports false when nothing changed - unknown image, or nothing published", async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await repo.clearPublicAsset(IMAGE_ID)).toBe(false);
    // The predicate is what makes an already-clear row report false rather than
    // claiming a withdrawal the user never had to perform.
    expect(mockQueryOne.mock.calls[0]![0].replace(/\s+/g, " "))
      .toContain("AND public_cid IS NOT NULL");
  });
});

describe("the pairing invariant holds through the repo's own API", () => {
  it("neither writer can produce a half-set row", async () => {
    // recordPublicAsset writes all three in ONE statement and clearPublicAsset
    // nulls all three in ONE statement. There is no path through this module
    // that assigns a subset, which is what makes the DB's pairing CHECK a
    // backstop rather than the only guard.
    txRows = [[], [imageRow()], [publishedRow()]];
    const recorded = await repo.recordPublicAsset(IMAGE_ID, { cid: PUBLIC_CID, url: PUBLIC_URL });
    const set = [recorded!.publicCid, recorded!.publicUrl, recorded!.publicUploadedAt];
    expect(set.every((v) => v !== null)).toBe(true);

    const writeSql = txCalls[2]![0].replace(/\s+/g, " ");
    expect(writeSql).toMatch(
      /SET public_cid = \$2, public_url = \$3, public_uploaded_at = NOW\(\)/,
    );

    mockQueryOne.mockResolvedValue({ image_id: IMAGE_ID });
    await repo.clearPublicAsset(IMAGE_ID);
    const clearSql = mockQueryOne.mock.calls[0]![0].replace(/\s+/g, " ");
    expect(clearSql).toMatch(
      /SET public_cid = NULL, public_url = NULL, public_uploaded_at = NULL/,
    );
  });
});
