/**
 * OD-3's read, against a REAL Postgres — because every guarantee it makes is a
 * SQL predicate, and one of them is an ownership boundary.
 *
 * Three properties that only a real database can demonstrate:
 *
 * 1. **Wallet scoping is case-insensitive.** EVM addresses are persisted in
 *    mixed checksum case by different writers, so a case-sensitive `= ANY(...)`
 *    would silently show a user NOTHING — the exact symptom this feature exists
 *    to remove, reintroduced by a comparison bug.
 * 2. **A wallet outside the caller's set MISSES**, even though its row is
 *    perfectly valid. The read is wallet-scoped by contract, like every sibling.
 * 3. **Only `broadcast_pending` is in flight.** An `authorized` intent is not a
 *    launch: nothing was signed and nothing was spent, and listing it would turn
 *    a form the user abandoned into a launch they appear to have made.
 */
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { execute, getPool, queryOne } from "@vex-agent/db/client.js";
import {
  createWith,
  listInFlightForWallets,
} from "@vex-agent/db/repos/token-launch-intents.js";

const CHAIN_ID = 4663;
const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const OTHER_WALLET = "0x99aA1234567890abcdef1234567890ABCDEF9999";

const createdIntentIds: string[] = [];
const createdSessionIds: string[] = [];

afterEach(async () => {
  if (createdIntentIds.length > 0) {
    const ids = createdIntentIds.splice(0, createdIntentIds.length);
    await execute(`DELETE FROM token_launch_intents WHERE intent_id = ANY($1::text[])`, [ids]);
  }
  if (createdSessionIds.length > 0) {
    const ids = createdSessionIds.splice(0, createdSessionIds.length);
    await execute(`DELETE FROM sessions WHERE id = ANY($1::text[])`, [ids]);
  }
});

/** A real `sessions` row — the intent's FK requires one. */
async function seedSession(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (id) VALUES (gen_random_uuid()::text) RETURNING id`,
  );
  if (!row) throw new Error("failed to seed a session");
  createdSessionIds.push(row.id);
  return row.id;
}

/** Seed one intent, optionally advanced to `broadcast_pending` with a hash. */
async function seedIntent(input: {
  walletAddress: string;
  broadcast: boolean;
  txHash?: string | null;
  prebuyRaw?: string | null;
}): Promise<string> {
  const intentId = `il-${randomUUID()}`;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await createWith(client, {
      intentId,
      sessionId: await seedSession(),
      origin: "user",
      status: "authorized",
      chainId: CHAIN_ID,
      walletAddress: input.walletAddress,
      name: "Waiting",
      symbol: "WAIT",
      prebuyRaw: input.prebuyRaw ?? null,
      prebuyDecimals: input.prebuyRaw == null ? null : 18,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      // A LIVE intent must carry its authorization — the DB enforces it
      // (`token_launch_intents_live_has_authorization`), which is exactly the
      // kind of guard a mocked client would have let this fixture skip.
      authorizationId: randomUUID(),
      authorizationKind: "user_submit",
    });
  } finally {
    client.release();
  }
  createdIntentIds.push(intentId);

  if (input.broadcast) {
    await execute(
      `UPDATE token_launch_intents
          SET status = 'broadcast_pending', tx_hash = $2, broadcast_at = NOW()
        WHERE intent_id = $1`,
      [intentId, input.txHash ?? `0x${randomUUID().replace(/-/g, "")}`],
    );
  }
  return intentId;
}

async function inFlightIds(wallets: readonly string[]): Promise<string[]> {
  const rows = await listInFlightForWallets({
    walletAddresses: wallets,
    chainId: CHAIN_ID,
    limit: 25,
  });
  return rows.map((row) => row.intentId);
}

describe("in-flight launches for a wallet set", () => {
  it("returns a broadcast launch whose token identity is not proven yet", async () => {
    const intentId = await seedIntent({ walletAddress: WALLET, broadcast: true });

    expect(await inFlightIds([WALLET])).toContain(intentId);
  });

  it("matches the wallet CASE-INSENSITIVELY — checksum case must not hide a launch", async () => {
    const intentId = await seedIntent({ walletAddress: WALLET, broadcast: true });

    // The same address, lower-cased, as a caller's resolved set may well hold it.
    expect(await inFlightIds([WALLET.toLowerCase()])).toContain(intentId);
    expect(await inFlightIds([WALLET.toUpperCase().replace("0X", "0x")])).toContain(intentId);
  });

  it("MISSES a wallet outside the caller's set — the ownership boundary", async () => {
    const intentId = await seedIntent({ walletAddress: OTHER_WALLET, broadcast: true });

    expect(await inFlightIds([WALLET])).not.toContain(intentId);
  });

  it("excludes an intent that was never broadcast — nothing signed, nothing spent", async () => {
    const intentId = await seedIntent({ walletAddress: WALLET, broadcast: false });

    expect(await inFlightIds([WALLET])).not.toContain(intentId);
  });

  it("carries the prebuy WITH its decimals, or neither", async () => {
    await seedIntent({ walletAddress: WALLET, broadcast: true, prebuyRaw: "300000000000000" });

    const [row] = await listInFlightForWallets({
      walletAddresses: [WALLET],
      chainId: CHAIN_ID,
      limit: 25,
    });

    expect(row?.prebuyRaw).toBe("300000000000000");
    expect(row?.prebuyDecimals).toBe(18);
  });

  it("returns nothing for an empty wallet set rather than every launch in the table", async () => {
    await seedIntent({ walletAddress: WALLET, broadcast: true });

    expect(await inFlightIds([])).toEqual([]);
  });
});
