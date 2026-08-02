/**
 * `token_launch_intents` repo — the C1 launch state machine (mocked pool).
 *
 * The invariants pinned here are the ones a launch's safety rests on, and each
 * has a concrete failure it prevents:
 *
 *   - EVERY writer and EVERY read carries `session_id` in its predicate. Without
 *     it, another session that learns an intent id could consume, cancel or read
 *     a launch it does not own.
 *   - `consumeIfAuthorizedWith` is the exactly-once gate: `status='authorized'`
 *     AND `expires_at > NOW()`. A `null` return means the race was LOST and the
 *     caller must not sign — pinned because ignoring it spends real funds twice.
 *   - `markBroadcastPendingWith` requires `tx_hash IS NULL`, so a retry can never
 *     overwrite a staged hash and lose the evidence of a create in flight.
 *   - `cancelIfAwaitingWith` / `expireIfAwaitingWith` only ever leave
 *     `awaiting_user_form`, so neither can race an in-flight signature.
 *   - `failWith` is NOT reachable from `awaiting_user_form` (nothing to fail
 *     yet) and IS reachable from `broadcast_pending` (a definitive mined revert).
 *   - `rowCount = 0` returns `null`, never a silent success.
 *
 * The WRITERS are client-bound by design — they must run inside the caller's
 * session-control-locked transaction — so their SQL is asserted against a fake
 * `PoolClient`. The READS stay pool-level and use the mocked client module.
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

/** Stand-in for the `PoolClient` a session-control-locked transaction yields. */
function fakeClient(rows: Record<string, unknown>[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/token-launch-intents.js");

beforeEach(() => {
  resetMocks();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const INTENT_ID = "launch-intent-001";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-0000000000ff";
const WALLET = "0xabcdef1234567890abcdef1234567890abcdef12";
const TOKEN = "0x58659Ef9B4E4Fd0b0C0dE0b0c0de0B0c0De0b91A";
const TX_HASH = "0xfeed0000000000000000000000000000000000000000000000000000000beef";
const EXPIRES_AT = "2026-08-03T10:00:00.000Z";

function dbRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent_id: INTENT_ID,
    session_id: SESSION_ID,
    origin: "agent_requested_form",
    status: "awaiting_user_form",
    chain_id: "4663",
    wallet_address: WALLET,
    name: "Test Coin",
    symbol: "TEST",
    description: null,
    links: {},
    image_id: null,
    prebuy_raw: null,
    prebuy_decimals: null,
    authorization_id: null,
    authorization_kind: null,
    authorized_at: null,
    tool_call_id: "call_abc123",
    mission_run_id: null,
    result_message_id: null,
    tx_hash: null,
    token_address: null,
    failure_reason: null,
    expires_at: new Date(EXPIRES_AT),
    consumed_at: null,
    cancelled_at: null,
    broadcast_at: null,
    confirmed_at: null,
    created_at: new Date("2026-08-02T10:00:00.000Z"),
    ...over,
  };
}

/**
 * The STATE-TRANSITION statement the fake client was handed, whitespace-collapsed.
 *
 * The LAST call, not the first: a writer that binds an image takes that image's
 * advisory lock first (`launch-image-lock.ts`), and the lock is pinned by
 * `launch-image-lock.test.ts` rather than here. Every writer issues exactly one
 * transition statement, and it is always the last.
 */
function sqlOf(client: ReturnType<typeof fakeClient>): string {
  return String(client.query.mock.calls.at(-1)![0]).replace(/\s+/g, " ");
}

function paramsOf(client: ReturnType<typeof fakeClient>): unknown[] {
  return client.query.mock.calls.at(-1)![1] as unknown[];
}

// ── create ──────────────────────────────────────────────────────────────────

describe("createWith — the entry state is explicit per path", () => {
  it("Path 1 enters at awaiting_user_form with no authorization", async () => {
    const client = fakeClient([dbRow()]);
    const created = await repo.createWith(client as never, {
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      origin: "agent_requested_form",
      status: "awaiting_user_form",
      chainId: 4663,
      walletAddress: WALLET,
      name: "Test Coin",
      symbol: "TEST",
      toolCallId: "call_abc123",
      expiresAt: EXPIRES_AT,
    });
    expect(created.status).toBe("awaiting_user_form");
    expect(created.authorizationId).toBeNull();
    expect(paramsOf(client)[3]).toBe("awaiting_user_form");
    expect(paramsOf(client)[13]).toBeNull();
  });

  it("Path 1 carries the ORIGINAL parked tool-call id — the turn's only anchor", async () => {
    const client = fakeClient([dbRow()]);
    const created = await repo.createWith(client as never, {
      intentId: INTENT_ID, sessionId: SESSION_ID, origin: "agent_requested_form",
      status: "awaiting_user_form", chainId: 4663, walletAddress: WALLET,
      name: "Test Coin", symbol: "TEST",
      toolCallId: "call_abc123", missionRunId: "run-1", expiresAt: EXPIRES_AT,
    });
    expect(created.toolCallId).toBe("call_abc123");
    // SQL `$17`/`$18` are 1-indexed placeholders; the bound array is 0-indexed,
    // so tool_call_id is [16] and mission_run_id is [17]. `authorized_at` is a
    // CASE expression, not a parameter, so it consumes no slot. Both shifted by
    // one when `authorization_json` was added at $16 (the C0 consent snapshot).
    expect(paramsOf(client)[16]).toBe("call_abc123");
    expect(paramsOf(client)[17]).toBe("run-1");
  });

  it("Path 2 enters at authorized carrying its C0 record", async () => {
    const client = fakeClient([
      dbRow({
        status: "authorized",
        origin: "agent",
        authorization_id: "auth-1",
        authorization_kind: "full_autonomy",
        authorized_at: new Date("2026-08-02T10:00:01.000Z"),
      }),
    ]);
    const created = await repo.createWith(client as never, {
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      origin: "agent",
      status: "authorized",
      chainId: 4663,
      walletAddress: WALLET,
      name: "Test Coin",
      symbol: "TEST",
      authorizationId: "auth-1",
      authorizationKind: "full_autonomy",
      expiresAt: EXPIRES_AT,
    });
    expect(created.status).toBe("authorized");
    expect(created.authorizationKind).toBe("full_autonomy");
    // The timestamp is stamped BY THE DATABASE iff an authorization id is
    // present, so an authorization can never exist without its time.
    expect(sqlOf(client)).toContain("CASE WHEN $14::text IS NULL THEN NULL ELSE NOW() END");
    expect(created.authorizedAt).toBe("2026-08-02T10:00:01.000Z");
  });

  it("chain_id survives node-pg's BIGINT-as-string round trip", async () => {
    const client = fakeClient([dbRow({ chain_id: "4663" })]);
    const created = await repo.createWith(client as never, {
      intentId: INTENT_ID, sessionId: SESSION_ID, origin: "user",
      status: "awaiting_user_form", chainId: 4663, walletAddress: WALLET,
      name: "Test Coin", symbol: "TEST", expiresAt: EXPIRES_AT,
    });
    expect(created.chainId).toBe(4663);
  });
});

// ── the exactly-once gate ───────────────────────────────────────────────────

describe("consumeIfAuthorizedWith — the exactly-once signing gate", () => {
  it("claims only an authorized, unexpired intent of THIS session", async () => {
    const client = fakeClient([dbRow({ status: "consuming", authorization_id: "auth-1", authorization_kind: "user_submit" })]);
    await repo.consumeIfAuthorizedWith(client as never, INTENT_ID, SESSION_ID);
    const sql = sqlOf(client);
    expect(sql).toContain("SET status = 'consuming'");
    expect(sql).toContain("AND session_id = $2");
    expect(sql).toContain("AND status = 'authorized'");
    expect(sql).toContain("AND expires_at > NOW()");
    expect(paramsOf(client)).toEqual([INTENT_ID, SESSION_ID]);
  });

  it("returns null when the CAS misses — a LOST race, never a silent success", async () => {
    const client = fakeClient([]);
    expect(await repo.consumeIfAuthorizedWith(client as never, INTENT_ID, SESSION_ID)).toBeNull();
  });

  it("another session cannot claim a known intent id", async () => {
    const client = fakeClient([]);
    const claimed = await repo.consumeIfAuthorizedWith(client as never, INTENT_ID, OTHER_SESSION);
    expect(claimed).toBeNull();
    expect(paramsOf(client)[1]).toBe(OTHER_SESSION);
  });
});

// ── authorize ───────────────────────────────────────────────────────────────

describe("authorizeWith — a lapsed form window cannot authorize a spend", () => {
  it("requires awaiting_user_form AND an unexpired window", async () => {
    const client = fakeClient([dbRow({ status: "authorized" })]);
    await repo.authorizeWith(client as never, INTENT_ID, SESSION_ID, {
      authorizationId: "auth-1",
      authorizationKind: "user_submit",
      name: "Moon",
      symbol: "MOON",
      description: "to the moon",
      links: { urls: ["https://moon.example"] },
      imageId: "img_abc",
      prebuyRaw: "1000000000000000",
      prebuyDecimals: 18,
    });
    const sql = sqlOf(client);
    expect(sql).toContain("AND status = 'awaiting_user_form'");
    expect(sql).toContain("AND expires_at > NOW()");
    expect(sql).toContain("AND session_id = $2");
  });

  it("binds the prebuy raw amount together with its decimals", async () => {
    const client = fakeClient([dbRow()]);
    await repo.authorizeWith(client as never, INTENT_ID, SESSION_ID, {
      authorizationId: "auth-1", authorizationKind: "user_submit",
      name: "Moon", symbol: "MOON", description: "to the moon",
      links: { urls: ["https://moon.example"] },
      imageId: "img_abc", prebuyRaw: "1000000000000000", prebuyDecimals: 18,
    });
    const params = paramsOf(client);
    expect(params[5]).toBe("1000000000000000");
    expect(params[6]).toBe(18);
  });

  /**
   * THE EDITED-FORM DEFECT.
   *
   * The dialog opens on the agent's draft with every field EDITABLE. The consent
   * snapshot is built from the values the user finally submitted, and
   * `execute-user-submit.ts` cross-checks that snapshot against the intent row's
   * own columns before signing. So a writer that updated only image/prebuy left
   * an edited name or symbol disagreeing with the record — which REFUSES the
   * launch at the gate — while an edited description or links executed against
   * stale row metadata. Every editable field moves in the same CAS.
   */
  it("writes ALL editable token fields, so an edited form cannot drift from its consent record", async () => {
    const client = fakeClient([dbRow()]);
    await repo.authorizeWith(client as never, INTENT_ID, SESSION_ID, {
      authorizationId: "auth-1", authorizationKind: "user_submit",
      name: "Rocket", symbol: "RKT", description: "renamed by the user",
      links: { urls: ["https://rocket.example"] },
      imageId: "img_edited", prebuyRaw: "2000000000000000", prebuyDecimals: 18,
    });
    const sql = sqlOf(client);
    expect(sql).toContain("name = $9");
    expect(sql).toContain("symbol = $10");
    expect(sql).toContain("description = $11");
    expect(sql).toContain("links = $12::jsonb");

    const params = paramsOf(client);
    expect(params[8]).toBe("Rocket");
    expect(params[9]).toBe("RKT");
    expect(params[10]).toBe("renamed by the user");
    expect(params[11]).toBe(JSON.stringify({ urls: ["https://rocket.example"] }));
  });

  it("NEVER writes origin, tool_call_id or mission_run_id — the parked call must survive", async () => {
    const client = fakeClient([dbRow()]);
    await repo.authorizeWith(client as never, INTENT_ID, SESSION_ID, {
      authorizationId: "auth-1", authorizationKind: "user_submit",
      name: "Rocket", symbol: "RKT", description: null, links: {},
      imageId: "img_abc", prebuyRaw: "1000000000000000", prebuyDecimals: 18,
    });
    const sql = sqlOf(client);
    // Those three columns are how `resumeAgentAfterUserForm` finds the turn to
    // answer. Rewriting any of them orphans the agent's parked call.
    expect(sql).not.toContain("origin =");
    expect(sql).not.toContain("tool_call_id =");
    expect(sql).not.toContain("mission_run_id =");
    // And the CAS predicate is untouched by the widened SET list.
    expect(sql).toContain("AND status = 'awaiting_user_form'");
    expect(sql).toContain("AND expires_at > NOW()");
    expect(sql).toContain("AND session_id = $2");
  });
});

// ── broadcast ───────────────────────────────────────────────────────────────

describe("markBroadcastPendingWith — a staged hash is never overwritten", () => {
  it("requires consuming AND tx_hash IS NULL", async () => {
    const client = fakeClient([dbRow({ status: "broadcast_pending", tx_hash: TX_HASH })]);
    const row = await repo.markBroadcastPendingWith(client as never, INTENT_ID, SESSION_ID, TX_HASH);
    const sql = sqlOf(client);
    expect(sql).toContain("AND status = 'consuming'");
    expect(sql).toContain("AND tx_hash IS NULL");
    expect(row?.txHash).toBe(TX_HASH);
  });

  it("a duplicate call misses instead of losing the first hash", async () => {
    const client = fakeClient([]);
    expect(
      await repo.markBroadcastPendingWith(client as never, INTENT_ID, SESSION_ID, "0xsecond"),
    ).toBeNull();
  });
});

// ── terminal transitions ────────────────────────────────────────────────────

describe("confirmWith — confirmed means we know WHICH token exists", () => {
  it("only from broadcast_pending, and records the decoded address", async () => {
    const client = fakeClient([
      dbRow({ status: "confirmed", tx_hash: TX_HASH, token_address: TOKEN }),
    ]);
    const row = await repo.confirmWith(client as never, INTENT_ID, SESSION_ID, TOKEN);
    const sql = sqlOf(client);
    expect(sql).toContain("AND status = 'broadcast_pending'");
    expect(sql).toContain("token_address = $3");
    expect(row?.tokenAddress).toBe(TOKEN);
  });
});

describe("failWith — reachable only where something could actually fail", () => {
  it("covers authorized, consuming and broadcast_pending, and NOT awaiting_user_form", async () => {
    const client = fakeClient([dbRow({ status: "terminal_failure" })]);
    await repo.failWith(client as never, INTENT_ID, SESSION_ID, "LaunchRefused:abc123");
    const sql = sqlOf(client);
    expect(sql).toContain("AND status IN ('authorized', 'consuming', 'broadcast_pending')");
    expect(sql).not.toContain("'awaiting_user_form'");
  });

  it("stores the structural label verbatim and nothing else", async () => {
    const client = fakeClient([dbRow({ status: "terminal_failure", failure_reason: "LaunchRefused:abc123" })]);
    const row = await repo.failWith(client as never, INTENT_ID, SESSION_ID, "LaunchRefused:abc123");
    // The contract is `ErrorKind:errorHash` — no raw provider message may ever
    // reach this column. The repo passes it through; the caller builds it.
    expect(row?.failureReason).toMatch(/^[A-Za-z]+:[0-9a-f]+$/);
  });
});

describe("cancel / expire — pre-authorization exits only", () => {
  it("cancel leaves only awaiting_user_form", async () => {
    const client = fakeClient([dbRow({ status: "cancelled" })]);
    await repo.cancelIfAwaitingWith(client as never, INTENT_ID, SESSION_ID);
    const sql = sqlOf(client);
    expect(sql).toContain("AND status = 'awaiting_user_form'");
    expect(sql).toContain("AND session_id = $2");
    // Never from a state where a signature may be in flight.
    expect(sql).not.toContain("consuming");
    expect(sql).not.toContain("broadcast_pending");
  });

  it("expire additionally requires the window to have ACTUALLY lapsed", async () => {
    const client = fakeClient([dbRow({ status: "expired" })]);
    await repo.expireIfAwaitingWith(client as never, INTENT_ID, SESSION_ID);
    const sql = sqlOf(client);
    expect(sql).toContain("AND status = 'awaiting_user_form'");
    // Not a back door for cancelling a live form.
    expect(sql).toContain("AND expires_at <= NOW()");
  });
});

// ── reads ───────────────────────────────────────────────────────────────────

describe("reads", () => {
  it("getById is session-scoped — a known id from another session misses", async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await repo.getById(INTENT_ID, OTHER_SESSION)).toBeNull();
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql.replace(/\s+/g, " ")).toContain("WHERE intent_id = $1 AND session_id = $2");
    expect(params).toEqual([INTENT_ID, OTHER_SESSION]);
  });

  it("getAwaitingForSession returns only the pre-authorization state, newest first", async () => {
    mockQuery.mockResolvedValue([dbRow()]);
    const rows = await repo.getAwaitingForSession(SESSION_ID);
    expect(rows).toHaveLength(1);
    const sql = mockQuery.mock.calls[0]![0].replace(/\s+/g, " ");
    expect(sql).toContain("WHERE session_id = $1 AND status = 'awaiting_user_form'");
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  // MOVED + RENAMED (fix wave): the identity-sweep candidate set is now
  // `claimBroadcastPendingForSweep` in `./token-launch-intents/sweep-claim.ts`.
  // It became a CLAIM — serving a row stamps `last_checked_at` so an ambiguous
  // row rotates to the back — because `ORDER BY created_at ASC LIMIT 25` over a
  // set the sweep may leave unchanged let 25 permanently-ambiguous launches
  // starve row 26 forever. Its SQL is pinned in `launch-sweep-claim.test.ts`;
  // the reads module no longer owns it, and nothing here should re-pin it.

  it("TIMESTAMPTZ Date values normalise to ISO strings", async () => {
    mockQueryOne.mockResolvedValue(dbRow());
    const row = await repo.getById(INTENT_ID, SESSION_ID);
    expect(row?.expiresAt).toBe(EXPIRES_AT);
    expect(row?.createdAt).toBe("2026-08-02T10:00:00.000Z");
  });

  it("prebuy decimals of 0 survive mapping — NOT NULL, never truthiness", async () => {
    mockQueryOne.mockResolvedValue(dbRow({ prebuy_raw: "5", prebuy_decimals: 0 }));
    const row = await repo.getById(INTENT_ID, SESSION_ID);
    expect(row?.prebuyDecimals).toBe(0);
  });
});

describe("LIVE_TOKEN_LAUNCH_INTENT_STATUSES", () => {
  it("names every state that may still sign or is awaiting settlement", () => {
    expect([...repo.LIVE_TOKEN_LAUNCH_INTENT_STATUSES].sort()).toEqual([
      "authorized", "awaiting_user_form", "broadcast_pending", "consuming",
    ]);
  });

  it("excludes every terminal state — a terminal intent blocks no image deletion", () => {
    for (const terminal of ["confirmed", "terminal_failure", "cancelled", "expired"]) {
      expect(repo.LIVE_TOKEN_LAUNCH_INTENT_STATUSES).not.toContain(terminal);
    }
  });
});
