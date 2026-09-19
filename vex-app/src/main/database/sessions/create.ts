/**
 * Session creation.
 *
 * Mission creation pipeline:
 *   1. INSERT sessions (mode='mission', permission, initial_goal=NULL)
 *   2. INSERT missions (id, root_session_id=session.id, status='draft')
 *   3. Do NOT create mission_runs here — that happens later via startMission()
 *      after the conversational setup flow refines the contract.
 * Steps 1+2 run inside a single BEGIN/COMMIT — a crash after step 1 must NOT
 * leave a mission session without its missions row.
 */

import type { Client } from "pg";
import { randomUUID } from "node:crypto";
import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  VEX_APP_SESSION_SCOPE,
  type SessionCreateInput,
  type SessionListItem,
  type SessionMode,
  type SessionPermission,
} from "@shared/schemas/sessions.js";
import { log } from "../../logger/index.js";
import type { WalletRef } from "../../ipc/_wallet-refs.js";
import { dbError, withClient } from "./connection.js";
import { SESSION_ROW_COLUMNS, type SessionRow, toListItem } from "./mappers.js";

/**
 * Create a session. For `mode === "mission"` this also inserts the
 * companion `missions` draft row in the same transaction. Returns the
 * newly persisted list-item shape so the renderer can update its query
 * cache without a follow-up `vex.sessions.list` roundtrip.
 *
 * Side effects:
 *   - INSERT into sessions (always)
 *   - INSERT into missions (mission mode only — status='draft', goal=NULL)
 *
 * NO LLM calls. The first turn of the mission setup flow runs later, when
 * the renderer opens the session and the engine's `processMissionSetupTurn`
 * picks up.
 */
export async function createSessionWithClient(
  client: Client,
  id: string,
  input: SessionCreateInput,
  walletRefs: { evm: WalletRef | null; solana: WalletRef | null },
): Promise<Result<SessionListItem, VexError>> {
  const mode: SessionMode = input.mode;
  const permission: SessionPermission = input.permission;
  const title: string = input.name;
  const initialGoal: string | null = null;
  const workspace = input.mode === "agent" ? (input.workspace ?? null) : null;
  const { evm, solana } = walletRefs;
  // Mission draft allowed_wallets is a deterministic projection of the
  // session's selected wallet ADDRESSES — 5B mission policy reads this, frozen
  // at run start. Agent sessions have no missions row.
  const allowedWallets = [evm?.address, solana?.address].filter(
    (a): a is string => typeof a === "string",
  );

  await client.query("BEGIN");
  await client.query(
    `INSERT INTO sessions
       (id, scope, mode, permission, initial_goal, title,
        selected_evm_wallet_id, selected_evm_wallet_address,
        selected_solana_wallet_id, selected_solana_wallet_address, workspace)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id, VEX_APP_SESSION_SCOPE, mode, permission, initialGoal, title,
      evm?.id ?? null, evm?.address ?? null,
      solana?.id ?? null, solana?.address ?? null, workspace,
    ],
  );
  if (mode === "mission") {
    const missionId = randomUUID();
    await client.query(
      "INSERT INTO missions (id, root_session_id, status, allowed_wallets) VALUES ($1, $2, 'draft', $3)",
      [missionId, id, allowedWallets],
    );
  }
  const sessionResult = await client.query<SessionRow>(
    `SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE id = $1 AND scope = $2`,
    [id, VEX_APP_SESSION_SCOPE],
  );
  await client.query("COMMIT");
  const row = sessionResult.rows[0];
  if (!row) {
    return dbError(`createSession lost row id=${id} after INSERT`);
  }
  // Freshly created mission sessions have no mission_run yet — that record
  // only appears once startMission() is called downstream.
  return ok(toListItem(row, null));
}

export async function createSession(
  input: SessionCreateInput,
  walletRefs: { evm: WalletRef | null; solana: WalletRef | null } = { evm: null, solana: null },
): Promise<Result<SessionListItem, VexError>> {
  const id = randomUUID();
  return withClient(async (client) => {
    try {
      return await createSessionWithClient(client, id, input, walletRefs);
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch (rbCause) {
        log.warn("[sessions-db] ROLLBACK after createSession failure failed", rbCause);
      }
      return dbError("createSession transaction failed", cause);
    }
  });
}
