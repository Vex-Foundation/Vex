/**
 * Missions DB helpers for `mission.getDraft` + `mission.getRenewableSource`.
 *
 * Mirrors `sessions-db.ts` decoupling: own `pg.Client` per call. JSONB
 * column normalisation lives in `missions-db-normalize.ts`; this file
 * owns the query surface plus the per-call connection lifecycle.
 *
 *   missions(
 *     id TEXT PK, root_session_id, status, title, goal,
 *     constraints_json JSONB, success_criteria_json JSONB,
 *     stop_conditions_json JSONB, risk_profile,
 *     capital_source_json JSONB, allowed_protocols TEXT[],
 *     allowed_chains TEXT[], allowed_wallets TEXT[],
 *     created_at, updated_at, approved_at,
 *     accepted_contract_hash, accepted_contract_at, accepted_contract_by,
 *     contract_hash_version, renewed_from_mission_id
 *   )
 *
 * Phase 7 changes:
 *   - `getDraftForSession` now accepts `status IN ('draft', 'ready')`
 *     so the contract card stays mounted right through host acceptance
 *     (codex phase 7 review #1).
 *   - New `getRenewableSourceForSession` resolves the most recent
 *     terminal accepted mission so `/mission-renew` has an explicit
 *     `previousMissionId` (codex phase 7 review #3, LATERAL JOIN
 *     against latest mission_run).
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  MissionDraftDto,
  MissionGetDraftResult,
  MissionGetRenewableSourceResult,
} from "@shared/schemas/mission.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";
import {
  MISSION_ROW_COLUMNS,
  normaliseConstraints,
  normalisePgArray,
  normaliseStatus,
  normaliseHyperliquidMissionRisk,
  normaliseStringList,
  projectAcceptance,
  toIso,
  toIsoOrNull,
  type MissionRow,
} from "./missions-db-normalize.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

// `correlationId` intentionally omitted; `registerHandler` stamps
// `ctx.requestId` downstream. See `messages-db.ts` for full rationale.
function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "mission",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[missions-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "mission",
    message: "Unable to load mission draft.",
    retryable: true,
    userActionable: false,
    redacted: true,
  });
}

async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[missions-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  const clientConfig: ClientConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[missions-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[missions-db] client.end failed (non-fatal)", cause);
    }
  }
}

function toDraftDto(row: MissionRow): MissionDraftDto {
  return {
    missionId: row.id,
    sessionId: row.root_session_id,
    status: normaliseStatus(row.status),
    title: row.title,
    goal: row.goal,
    constraints: normaliseConstraints(row.constraints_json),
    hyperliquidRisk: normaliseHyperliquidMissionRisk(row.constraints_json),
    successCriteria: normaliseStringList(
      row.success_criteria_json,
      "success_criteria_json",
    ),
    stopConditions: normaliseStringList(
      row.stop_conditions_json,
      "stop_conditions_json",
    ),
    riskProfile: row.risk_profile,
    allowedChains: normalisePgArray(row.allowed_chains, "allowed_chains", 64),
    allowedProtocols: normalisePgArray(
      row.allowed_protocols,
      "allowed_protocols",
      64,
    ),
    allowedWallets: normalisePgArray(
      row.allowed_wallets,
      "allowed_wallets",
      128,
    ),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    approvedAt: toIsoOrNull(row.approved_at),
    acceptance: projectAcceptance(row),
    renewedFromMissionId: row.renewed_from_mission_id ?? null,
  };
}

export async function getDraftForSession(
  sessionId: string,
): Promise<Result<MissionGetDraftResult, VexError>> {
  return withClient(async (client) => {
    try {
      // `status IN ('draft', 'ready')` so the contract card survives
      // the draft→ready transition that lands on host acceptance.
      // Anything past `ready` (running/completed/failed/cancelled) is
      // intentionally excluded — those go through `getRenewableSource`
      // for `/mission-renew` lineage instead.
      const result = await client.query<MissionRow>(
        `SELECT ${MISSION_ROW_COLUMNS}
           FROM missions
          WHERE root_session_id = $1
            AND status IN ('draft', 'ready')
          ORDER BY created_at DESC
          LIMIT 1`,
        [sessionId],
      );
      const row = result.rows[0];
      return ok(row ? toDraftDto(row) : null);
    } catch (cause) {
      return dbError("getDraftForSession query failed", cause);
    }
  });
}

/**
 * Resolve the latest terminal accepted mission for `/mission-renew`.
 *
 * Latest-run semantics (codex phase 7 review §Q1): a mission counts as
 * renewable iff its acceptance four-tuple is complete AND its NEWEST
 * `mission_runs` row sits in a terminal status. An older terminal run
 * with a newer active run on top does NOT qualify — only the truly
 * finished missions surface.
 *
 * Returns `null` when no eligible mission exists; the renderer maps
 * that to the friendly "No completed mission to renew" notice without
 * round-tripping through the engine's `previous_mission_not_found`
 * outcome.
 */
export async function getRenewableSourceForSession(
  sessionId: string,
): Promise<Result<MissionGetRenewableSourceResult, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<{ readonly mission_id: string }>(
        `SELECT m.id AS mission_id
           FROM missions m
           JOIN LATERAL (
             SELECT r.status, r.started_at, r.ended_at
               FROM mission_runs r
              WHERE r.mission_id = m.id
              ORDER BY r.started_at DESC
              LIMIT 1
           ) latest ON true
          WHERE m.root_session_id = $1
            AND m.accepted_contract_hash IS NOT NULL
            AND m.accepted_contract_at IS NOT NULL
            AND m.accepted_contract_by IS NOT NULL
            AND m.contract_hash_version IS NOT NULL
            AND latest.status IN ('completed', 'failed', 'stopped', 'cancelled')
          ORDER BY COALESCE(latest.ended_at, latest.started_at) DESC,
                   m.updated_at DESC
          LIMIT 1`,
        [sessionId],
      );
      const row = result.rows[0];
      return ok(row ? { missionId: row.mission_id } : null);
    } catch (cause) {
      log.warn("[missions-db] getRenewableSourceForSession failed", cause);
      return err({
        code: "internal.unexpected",
        domain: "mission",
        message: "Unable to resolve renewable mission source.",
        retryable: true,
        userActionable: false,
        redacted: true,
      });
    }
  });
}
