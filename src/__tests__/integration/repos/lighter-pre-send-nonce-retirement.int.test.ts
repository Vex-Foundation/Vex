import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { execute, getPool, queryOne } from "@vex-agent/db/client.js";
import * as lifecycle from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import * as nonces from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as oco from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as orders from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import { requireValue } from "../../helpers/require-value.js";
import { makeSession } from "../setup/fixtures.js";

const SCOPE = { environment: "rhc" as const, accountIndex: 4242, apiKeyIndex: 7 };
const OWNERS = ["create", "oco", "lifecycle"] as const;
type Owner = typeof OWNERS[number];
type RetirementIdentity = Omit<Parameters<typeof orders.expirePreSendNonceReservation>[0], "expectedState">;
interface Fixture {
  readonly kind: Owner;
  readonly table: string;
  readonly signed: boolean;
  readonly input: RetirementIdentity;
}

let sessionId: string;

beforeEach(async () => {
  expect(process.env.VEX_DB_URL).toBeTruthy();
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name"))
    .toEqual({ name: "vex_test" });
  await execute("TRUNCATE sessions RESTART IDENTITY CASCADE");
  await execute("TRUNCATE lighter_nonce_state");
  sessionId = await makeSession();
});

/** All identifiers and values here are local test fixtures, not provider observations. */
async function insertFixture(table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await execute(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`, Object.values(values));
}

async function seedPreview(matchHash: string) {
  const previewId = `lighter-preview-${randomUUID()}`;
  await insertFixture("lighter_order_previews", {
    preview_id: previewId,
    session_id: sessionId,
    match_hash: matchHash,
    environment: SCOPE.environment,
    account_index: SCOPE.accountIndex,
    api_key_index: SCOPE.apiKeyIndex,
    market_index: 0,
    side: "sell",
    base_amount_integer: "1000",
    price_integer: "200000",
    order_type: "limit",
    time_in_force: "good-till-time",
    reduce_only: true,
    order_expiry_ms: Date.now() + 3_600_000,
    client_order_index_policy: "vex_assigned_uint48",
    provider_version: "integration-fixture",
    preview_json: {},
    live_source_json: { source: "integration_fixture" },
    expires_at: new Date(Date.now() + 3_600_000),
  });
  return previewId;
}

/** Seed the durable checkpoint left by an interrupted local execution. */
async function seedOwner(kind: Owner, signed: boolean, expired = true): Promise<Fixture> {
  const intentId = `lighter-${kind}-${randomUUID()}`;
  const reservationId = `lighter-${kind}:${intentId}`;
  const signerTxHash = signed ? `fixture-hash-${randomUUID()}` : null;
  const table = kind === "create" ? "lighter_order_execution_intents"
    : kind === "oco" ? "lighter_oco_execution_intents" : "lighter_order_lifecycle_intents";
  const fields: Record<string, unknown> = {
    intent_id: intentId,
    session_id: sessionId,
    match_hash: "c".repeat(64),
    environment: SCOPE.environment,
    account_index: SCOPE.accountIndex,
    api_key_index: SCOPE.apiKeyIndex,
    market_index: 0,
    credential_ref_json: {
      kind: "encrypted_vault_reference", ...SCOPE,
      vaultCredentialId: "lighter/rhc/account-4242/api-key-7",
    },
    approval_status: "approved",
    decided_at: new Date(Date.now() - 120_000),
    decision_reason: "full_permission",
    execution_state: signed ? "signed" : kind === "lifecycle" ? "nonce_reserved" : "approval_pending",
    pre_submit_revalidation_json: { checked: true },
    pre_submit_revalidated_at: new Date(Date.now() - 90_000),
    nonce_reservation_id: reservationId,
    nonce_value: "12",
    signer_tx_hash: signerTxHash,
    expires_at: new Date(Date.now() + (expired ? -60_000 : 3_600_000)),
  };
  if (kind === "lifecycle") {
    Object.assign(fields, {
      action_type: "close_position",
      requested_base_amount_integer: "1000",
      requested_price_integer: "200000",
      requested_side: "sell",
      reduce_only: true,
      provider_snapshot_json: { source: "integration_fixture" },
      signer_expiry_ms: signed ? Date.now() + 3_600_000 : null,
    });
  } else {
    Object.assign(fields, {
      side: "sell",
      base_amount_integer: "1000",
      order_expiry_ms: Date.now() + 3_600_000,
      client_order_index_policy: "vex_assigned_uint48",
      provider_version: "integration-fixture",
    });
    if (kind === "create") {
      Object.assign(fields, {
        preview_id: await seedPreview("a".repeat(64)),
        price_integer: "200000",
        order_type: "limit",
        time_in_force: "good-till-time",
        reduce_only: true,
        signed_at: signed ? new Date(Date.now() - 75_000) : null,
        client_order_index: signed ? "1001" : null,
      });
    } else {
      Object.assign(fields, {
        stop_loss_preview_id: await seedPreview("a".repeat(64)),
        stop_loss_match_hash: "a".repeat(64),
        stop_loss_price_integer: "190000",
        stop_loss_trigger_price_integer: "190000",
        take_profit_preview_id: await seedPreview("b".repeat(64)),
        take_profit_match_hash: "b".repeat(64),
        take_profit_price_integer: "210000",
        take_profit_trigger_price_integer: "210000",
        preview_json: {},
        live_source_json: { source: "integration_fixture" },
        stop_loss_client_order_index: signed ? "1001" : null,
        take_profit_client_order_index: signed ? "1002" : null,
      });
    }
  }
  await insertFixture(table, fields);
  await insertFixture("lighter_nonce_state", {
    environment: SCOPE.environment,
    account_index: SCOPE.accountIndex,
    api_key_index: SCOPE.apiKeyIndex,
    provider_nonce: "12",
    public_key: "integration-fixture-public-key",
    source: "integration_fixture",
  });
  expect(await nonces.reserveObserved({ ...SCOPE, reservationId })).toMatchObject({
    status: "reserved", reservationId, reservedNonce: "12",
  });
  return {
    kind, table, signed,
    input: { intentId, sessionId, ...SCOPE, reservationId, nonceValue: "12", signerTxHash },
  };
}

function retire(fixture: Fixture, overrides: Partial<RetirementIdentity> = {}) {
  const input = { ...fixture.input, ...overrides };
  if (fixture.kind === "lifecycle") {
    return lifecycle.expirePreSendNonceReservation({ ...input, expectedState: fixture.signed ? "signed" : "nonce_reserved" });
  }
  return (fixture.kind === "create" ? orders : oco).expirePreSendNonceReservation({
    ...input, expectedState: fixture.signed ? "signed" : "approval_pending",
  });
}

function readOwner(fixture: Fixture) {
  return queryOne<Record<string, unknown>>(`SELECT * FROM ${fixture.table} WHERE intent_id=$1`, [fixture.input.intentId]);
}

function readNonce() {
  return nonces.find(SCOPE.environment, SCOPE.accountIndex, SCOPE.apiKeyIndex);
}

async function expectBlockedBy(blockerPid: number, table: string) {
  await expect.poll(async () => {
    const row = await queryOne<{ blocked: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND query LIKE $2
      ) AS blocked`,
      [blockerPid, `%${table}%`],
    );
    return row?.blocked;
  }, { timeout: 5000, interval: 10 }).toBe(true);
}

for (const kind of OWNERS) {
  describe(`${kind} pre-send nonce retirement against isolated PostgreSQL`, () => {
    it.each([false, true])("atomically retires the expired exact owner (signed=%s) and keeps its audit evidence", async (signed) => {
      const fixture = await seedOwner(kind, signed);
      const beforeOwner = requireValue(await readOwner(fixture));
      const beforeNonce = requireValue(await readNonce());
      const terminal = signed ? "expired_unsubmitted" : "rejected";

      expect(await retire(fixture)).toMatchObject({
        intentId: fixture.input.intentId,
        approvalStatus: "approved",
        approvalId: null,
        executionState: terminal,
        nonceReservationId: fixture.input.reservationId,
        nonceValue: "12",
        signerTxHash: fixture.input.signerTxHash,
        sendAttemptStartedAt: null,
        submittedTxHash: null,
      });
      const afterOwner = requireValue(await readOwner(fixture));
      expect(afterOwner).toEqual({
        ...beforeOwner,
        execution_state: terminal,
        ambiguous_reason: "consent_expired_before_submission",
        updated_at: afterOwner.updated_at,
      });
      const afterNonce = requireValue(await readNonce());
      expect(afterNonce).toEqual({
        ...beforeNonce,
        status: "observed",
        reservationId: null,
        reservedNonce: null,
        updatedAt: afterNonce.updatedAt,
      });
      expect(await retire(fixture)).toBeNull();
      expect(await readOwner(fixture)).toEqual(afterOwner);
      expect(await readNonce()).toEqual(afterNonce);
    });

    it.each([false, true])("preserves unexpired ownership (signed=%s)", async (signed) => {
      const fixture = await seedOwner(kind, signed, false);
      const owner = await readOwner(fixture);
      const nonce = await readNonce();
      expect(await retire(fixture)).toBeNull();
      expect(await readOwner(fixture)).toEqual(owner);
      expect(await readNonce()).toEqual(nonce);
    });

    it.each([
      ["send_attempt_started_at", new Date("2026-01-01T00:00:00.000Z")],
      ["submitted_tx_hash", "fixture-submitted-hash"],
      ["submit_code", 200],
      ["provider_outcome_json", { source: "integration_fixture", orderId: "1001" }],
      ["ambiguous_reason", "submission_uncertain"],
    ] as const)("preserves ownership with %s evidence", async (column, value) => {
      const fixture = await seedOwner(kind, true);
      await execute(`UPDATE ${fixture.table} SET ${column}=$2 WHERE intent_id=$1`, [fixture.input.intentId, value]);
      const owner = await readOwner(fixture);
      const nonce = await readNonce();
      expect(await retire(fixture)).toBeNull();
      expect(await readOwner(fixture)).toEqual(owner);
      expect(await readNonce()).toEqual(nonce);
    });

    it("requires the exact caller identity, attached nonce and saved signing hash", async () => {
      const fixture = await seedOwner(kind, true);
      const owner = await readOwner(fixture);
      const nonce = await readNonce();
      const mismatches: Partial<RetirementIdentity>[] = [
        { intentId: "missing-intent" },
        { sessionId: "other-session" },
        { environment: "core" },
        { accountIndex: 4243 },
        { apiKeyIndex: 8 },
        { reservationId: "other-reservation" },
        { nonceValue: "13" },
        { signerTxHash: "other-signing-hash" },
        { signerTxHash: null },
      ];
      for (const mismatch of mismatches) expect(await retire(fixture, mismatch)).toBeNull();
      expect(await readOwner(fixture)).toEqual(owner);
      expect(await readNonce()).toEqual(nonce);
    });

    it.each([
      ["reservation_id", "replacement-reservation"],
      ["reserved_nonce", "13"],
      ["status", "submitted"],
    ] as const)("refuses a nonce row with different %s", async (column, value) => {
      const fixture = await seedOwner(kind, true);
      await execute(`UPDATE lighter_nonce_state SET ${column}=$1`, [value]);
      const owner = await readOwner(fixture);
      const nonce = await readNonce();
      expect(await retire(fixture)).toBeNull();
      expect(await readOwner(fixture)).toEqual(owner);
      expect(await readNonce()).toEqual(nonce);
    });

    it("refuses retirement when its nonce reservation no longer exists", async () => {
      const fixture = await seedOwner(kind, false);
      await execute("DELETE FROM lighter_nonce_state");
      const owner = await readOwner(fixture);
      expect(await retire(fixture)).toBeNull();
      expect(await readOwner(fixture)).toEqual(owner);
      expect(await readNonce()).toBeNull();
    });

    it("rolls back owner retirement if the same statement cannot release its nonce", async () => {
      const fixture = await seedOwner(kind, true);
      const owner = await readOwner(fixture);
      const nonce = await readNonce();
      // Force the second write to fail in PostgreSQL, after the owner UPDATE.
      await execute("ALTER TABLE lighter_nonce_state ADD CONSTRAINT test_refuse_nonce_release CHECK (status <> 'observed') NOT VALID");
      try {
        await expect(retire(fixture)).rejects.toMatchObject({ code: "23514", constraint: "test_refuse_nonce_release" });
        expect(await readOwner(fixture)).toEqual(owner);
        expect(await readNonce()).toEqual(nonce);
      } finally {
        await execute("ALTER TABLE lighter_nonce_state DROP CONSTRAINT test_refuse_nonce_release");
      }
    });

    it("refuses a concurrent advance to the submitted or staged checkpoint", async () => {
      const fixture = await seedOwner(kind, true);
      const nonce = await readNonce();
      const writer = await getPool().connect();
      let retirement: ReturnType<typeof retire> | undefined;
      try {
        const pid = requireValue((await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]).pid;
        await writer.query("BEGIN");
        const nextState = kind === "lifecycle" ? "submission_staged" : "submitted";
        const submittedAt = kind === "create" ? ", submitted_at=clock_timestamp()" : "";
        await writer.query(`UPDATE ${fixture.table} SET execution_state=$2${submittedAt} WHERE intent_id=$1`, [fixture.input.intentId, nextState]);
        retirement = retire(fixture);
        await expectBlockedBy(pid, fixture.table);
        await writer.query("COMMIT");
        expect(await retirement).toBeNull();
        expect(await readOwner(fixture)).toMatchObject({ execution_state: nextState, ambiguous_reason: null });
        expect(await readNonce()).toEqual(nonce);
      } finally {
        try {
          await writer.query("ROLLBACK");
          await retirement;
        } finally {
          writer.release();
        }
      }
    });

    it("rechecks exact nonce ownership after waiting for a concurrent replacement", async () => {
      const fixture = await seedOwner(kind, true);
      const owner = await readOwner(fixture);
      const writer = await getPool().connect();
      let retirement: ReturnType<typeof retire> | undefined;
      try {
        const pid = requireValue((await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]).pid;
        await writer.query("BEGIN");
        await writer.query("UPDATE lighter_nonce_state SET reservation_id='new-reservation', reserved_nonce='13'");
        retirement = retire(fixture);
        await expectBlockedBy(pid, fixture.table);
        await writer.query("COMMIT");
        expect(await retirement).toBeNull();
        expect(await readOwner(fixture)).toEqual(owner);
        expect(await readNonce()).toMatchObject({ status: "reserved", reservationId: "new-reservation", reservedNonce: "13" });
      } finally {
        try {
          await writer.query("ROLLBACK");
          await retirement;
        } finally {
          writer.release();
        }
      }
    });
  });
}

describe("blocked nonce slots by reservation owner", () => {
  async function reserve(apiKeyIndex: number, reservationId: string) {
    await insertFixture("lighter_nonce_state", {
      environment: SCOPE.environment,
      account_index: SCOPE.accountIndex,
      api_key_index: apiKeyIndex,
      provider_nonce: "12",
      public_key: "integration-fixture-public-key",
      source: "integration_fixture",
    });
    await nonces.reserveObserved({ ...SCOPE, apiKeyIndex, reservationId });
  }

  it("lists only reserved slots owned by a leverage change or fee authorization", async () => {
    await reserve(1, "lighter-leverage:lever-1");
    await reserve(2, "lighter-fees:fee-1");
    await reserve(3, "lighter-order:order-1");
    await reserve(4, "lighter-leverage-lookalike:x");
    await insertFixture("lighter_nonce_state", {
      environment: SCOPE.environment,
      account_index: SCOPE.accountIndex,
      api_key_index: 5,
      provider_nonce: "12",
      public_key: "integration-fixture-public-key",
      source: "integration_fixture",
    });

    const rows = await nonces.listBlockedWithReservationPrefixes(["lighter-leverage:", "lighter-fees:"], 5);

    expect(rows.map((row) => row.reservationId).sort()).toEqual(["lighter-fees:fee-1", "lighter-leverage:lever-1"]);
    expect(rows.every((row) => row.status === "reserved")).toBe(true);
  });

  it("refuses a prefix that could widen the match", async () => {
    await expect(nonces.listBlockedWithReservationPrefixes(["%"], 5)).rejects.toThrow(/owner tags/);
    await expect(nonces.listBlockedWithReservationPrefixes(["lighter-fees"], 5)).rejects.toThrow(/owner tags/);
  });
});

