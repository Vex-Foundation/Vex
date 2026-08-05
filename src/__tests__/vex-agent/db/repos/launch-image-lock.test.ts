/**
 * The image advisory lock — the serialization that makes the C2 delete refusal
 * race-free.
 *
 * `launch_images` has NO foreign key from `token_launch_intents.image_id` (the
 * refusal is conditional on the referencing row's STATUS, which a foreign key
 * cannot express), so the database will NOT block a delete that races an intent
 * creation. Without an application-level lock the two transactions never see
 * each other: the delete's reference check finds nothing, the concurrent insert
 * captures the image id, and both commit — leaving a live launch pointing at
 * metadata and bytes that are gone.
 *
 * The lock closes that: a transaction-scoped `pg_advisory_xact_lock` on a key
 * derived from the image id, taken by the delete transaction BEFORE its
 * reference check and by every intent write that references an image BEFORE the
 * insert/update. Same key ⇒ the two serialize; different images ⇒ no contention.
 * The lock releases at COMMIT/ROLLBACK, so no path can leak it.
 *
 * RESIDUAL GAP, stated honestly: this suite mocks the `pg` client, so these are
 * SQL-SHAPE pins — they prove the statement is issued, with the right key, in
 * the right order. They cannot prove Postgres actually blocks a concurrent
 * transaction; that needs a real database with two connections, and this repo
 * has no such harness. The mechanism itself is Postgres-standard and already
 * used by `mission_results` seq_no minting.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type PoolQueryOneMock = Mock<
  (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;
type PoolQueryMock = Mock<
  (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
>;
let mockQueryOne: PoolQueryOneMock;
let mockQuery: PoolQueryMock;

function resetMocks(): void {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockQuery = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

const writers = await import("@vex-agent/db/repos/token-launch-intents.js");
const lock = await import("@vex-agent/db/repos/launch-image-lock.js");

beforeEach(() => resetMocks());

const IMAGE_ID = "img_0123456789abcdef0123456789abcdef";
const INTENT_ID = "launch-intent-001";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const WALLET = "0xabcdef1234567890abcdef1234567890abcdef12";

function fakeClient(rows: Record<string, unknown>[] = [{ intent_id: INTENT_ID }]) {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

/**
 * The DELETE-FIRST loser: by the time this writer's lock is granted, the delete
 * transaction has already committed and the `launch_images` row is gone.
 */
function fakeClientAfterImageDeleted() {
  return {
    query: vi.fn().mockImplementation((sql: string) =>
      /FROM launch_images/i.test(sql)
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : Promise.resolve({ rows: [{ intent_id: INTENT_ID }], rowCount: 1 }),
    ),
  };
}

const AUTHORIZE_INPUT = {
  authorizationId: "auth-1",
  authorizationKind: "user_submit" as const,
  // The token as the USER finally confirmed it — every field in the dialog is
  // editable, so authorize moves all of them in the same CAS as the consent
  // record built from them.
  name: "Moon",
  symbol: "MOON",
  description: "to the moon",
  links: { urls: ["https://moon.example"] },
  imageId: IMAGE_ID,
  prebuyRaw: "1000000000000000",
  prebuyDecimals: 18,
};

/** Every `[sql, params]` the fake client saw, whitespace-collapsed. */
function calls(client: ReturnType<typeof fakeClient>): [string, unknown[]][] {
  return client.query.mock.calls.map(
    (c: unknown[]) => [String(c[0]).replace(/\s+/g, " "), c[1] as unknown[]] as [string, unknown[]],
  );
}

function createInput(imageId: string | null) {
  return {
    intentId: INTENT_ID,
    sessionId: SESSION_ID,
    origin: "agent_requested_form" as const,
    status: "awaiting_user_form" as const,
    chainId: 4663,
    walletAddress: WALLET,
    name: "Test Coin",
    symbol: "TEST",
    ...(imageId === null ? {} : { imageId }),
    expiresAt: "2026-08-03T10:00:00.000Z",
  };
}

describe("the lock key is stable and image-scoped", () => {
  it("derives one deterministic namespaced key per image id", () => {
    expect(lock.launchImageLockKey(IMAGE_ID)).toBe(`launch_image:${IMAGE_ID}`);
    expect(lock.launchImageLockKey(IMAGE_ID)).toBe(lock.launchImageLockKey(IMAGE_ID));
    expect(lock.launchImageLockKey("img_other")).not.toBe(lock.launchImageLockKey(IMAGE_ID));
  });

  it("takes a TRANSACTION-scoped lock — it cannot be leaked past COMMIT", async () => {
    const client = fakeClient();
    await lock.lockLaunchImageWith(client as never, IMAGE_ID);
    const [[sql, params]] = calls(client);
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("hashtextextended");
    expect(params).toEqual([lock.launchImageLockKey(IMAGE_ID)]);
  });
});

describe("intent writers serialize on the image they capture", () => {
  it("createWith locks, re-reads the image, THEN inserts", async () => {
    const client = fakeClient();
    await writers.createWith(client as never, createInput(IMAGE_ID));
    const seen = calls(client);
    expect(seen).toHaveLength(3);
    expect(seen[0]![0]).toContain("pg_advisory_xact_lock");
    expect(seen[0]![1]).toEqual([lock.launchImageLockKey(IMAGE_ID)]);
    expect(seen[1]![0]).toContain("FROM launch_images");
    expect(seen[1]![1]).toEqual([IMAGE_ID]);
    expect(seen[2]![0]).toContain("INSERT INTO token_launch_intents");
  });

  it("createWith takes NO lock when the intent references no image", async () => {
    const client = fakeClient();
    await writers.createWith(client as never, createInput(null));
    const seen = calls(client);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toContain("INSERT INTO token_launch_intents");
  });

  it("authorizeWith locks, re-reads the image, THEN CAS-updates", async () => {
    const client = fakeClient();
    await writers.authorizeWith(client as never, INTENT_ID, SESSION_ID, AUTHORIZE_INPUT);
    const seen = calls(client);
    expect(seen).toHaveLength(3);
    expect(seen[0]![0]).toContain("pg_advisory_xact_lock");
    expect(seen[0]![1]).toEqual([lock.launchImageLockKey(IMAGE_ID)]);
    expect(seen[1]![0]).toContain("FROM launch_images");
    expect(seen[2]![0]).toContain("UPDATE token_launch_intents");
  });

  it("a writer that cannot change the image reference takes no lock", async () => {
    const client = fakeClient();
    await writers.consumeIfAuthorizedWith(client as never, INTENT_ID, SESSION_ID);
    expect(calls(client)).toHaveLength(1);
  });
});

/**
 * Ordering alone is not the guarantee. The lock also serializes the DELETE-FIRST
 * interleaving: the deletion wins the lock, finds no live intent, deletes, and
 * commits; the writer's lock is then granted over an image that no longer
 * exists. Locking without re-reading would capture that missing id and leave a
 * launch pointing at nothing — the same failure from the other side.
 *
 * So the re-read is the gate, not a diagnostic: a writer that loses the race
 * REFUSES BY NAME and its transaction rolls back. Silently inserting a dangling
 * `image_id` would let a launch reach signing with no bytes behind it.
 */
/**
 * The C0 consent snapshot rides through the writers UNINTERPRETED.
 *
 * Deliberate division of labour: the writer has no business deciding what a
 * valid authorization looks like, so it serialises whatever it is handed and the
 * READER schema-validates it as untrusted input. A writer that validated would
 * either duplicate the reader's rules or — worse — let a reader trust a stored
 * row nobody checked. Absent must persist as SQL NULL, not the string "null".
 */
describe("authorization_json is persisted as-is on both write paths", () => {
  const SNAPSHOT = { kind: "user_submit", acceptedTotalWei: "1000", at: "2026-08-02T10:00:00Z" };

  it("createWith writes the snapshot as JSONB", async () => {
    const client = fakeClient();
    await writers.createWith(client as never, {
      ...createInput(null),
      authorizationJson: SNAPSHOT,
    } as never);
    expect(calls(client).at(-1)![1]![15]).toBe(JSON.stringify(SNAPSHOT));
  });

  it("createWith persists NULL — not the string \"null\" — when there is none", async () => {
    const client = fakeClient();
    await writers.createWith(client as never, createInput(null));
    expect(calls(client).at(-1)![1]![15]).toBeNull();
  });

  it("authorizeWith writes the user_submit snapshot as JSONB", async () => {
    const client = fakeClient();
    await writers.authorizeWith(client as never, INTENT_ID, SESSION_ID, {
      ...AUTHORIZE_INPUT,
      authorizationJson: SNAPSHOT,
    });
    const [sql, params] = calls(client).at(-1)!;
    expect(sql).toContain("authorization_json = $8::jsonb");
    expect(params![7]).toBe(JSON.stringify(SNAPSHOT));
  });

  it("authorizeWith persists NULL when the caller supplies none", async () => {
    const client = fakeClient();
    await writers.authorizeWith(client as never, INTENT_ID, SESSION_ID, AUTHORIZE_INPUT);
    expect(calls(client).at(-1)![1]![7]).toBeNull();
  });

  /**
   * NO JSONB PARAM MAY EVER BE `undefined`.
   *
   * `assertJsonSerializable` throws on `undefined` by design, and a throw inside
   * `authorizeWith` refuses an HONEST launch at the write — it reads to the user
   * as an outage on a spend path. Both JSONB params are pinned as a pair:
   * `authorization_json` coalesces to SQL NULL, `links` to an empty object.
   */
  it("never hands a JSONB param `undefined`, even from a sparse caller", async () => {
    const client = fakeClient();
    const sparse = { ...AUTHORIZE_INPUT } as Record<string, unknown>;
    // A caller that forgot both blobs. TypeScript forbids it; this pins the
    // runtime behaviour anyway, because that is the shape that reached us.
    delete sparse.links;
    delete sparse.authorizationJson;

    await expect(
      writers.authorizeWith(client as never, INTENT_ID, SESSION_ID, sparse as never),
    ).resolves.not.toThrow();

    const params = calls(client).at(-1)![1]!;
    expect(params[7]).toBeNull();
    expect(params[11]).toBe("{}");
    for (const [index, value] of params.entries()) {
      expect(value, `param $${index + 1} must never be undefined`).not.toBeUndefined();
    }
  });
});

describe("DELETE-FIRST — a writer that locks after a completed delete refuses", () => {
  it("createWith refuses by name instead of capturing a missing image", async () => {
    const client = fakeClientAfterImageDeleted();
    await expect(
      writers.createWith(client as never, createInput(IMAGE_ID)),
    ).rejects.toThrow(lock.LaunchImageMissingError);
    expect(calls(client).some(([sql]) => /INSERT INTO token_launch_intents/.test(sql))).toBe(false);
  });

  it("authorizeWith refuses by name instead of authorizing against a missing image", async () => {
    const client = fakeClientAfterImageDeleted();
    await expect(
      writers.authorizeWith(client as never, INTENT_ID, SESSION_ID, AUTHORIZE_INPUT),
    ).rejects.toThrow(lock.LaunchImageMissingError);
    expect(calls(client).some(([sql]) => /UPDATE token_launch_intents/.test(sql))).toBe(false);
  });

  it("the refusal names the image and carries a stable code", async () => {
    const client = fakeClientAfterImageDeleted();
    const err = await writers
      .createWith(client as never, createInput(IMAGE_ID))
      .then(
        () => { throw new Error("expected the writer to refuse"); },
        (thrown: unknown) => thrown,
      );
    expect(err).toBeInstanceOf(lock.LaunchImageMissingError);
    if (!(err instanceof lock.LaunchImageMissingError)) throw new Error("unreachable");
    expect(err.code).toBe("image_not_found");
    expect(err.imageId).toBe(IMAGE_ID);
    expect(err.message).toContain(IMAGE_ID);
  });
});
