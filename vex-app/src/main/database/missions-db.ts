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
import { getMissingDraftFields } from "@vex-agent/engine/mission/validator.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";
import {
  MISSION_ROW_COLUMNS,
  normaliseConstraints,
  normalisePgArray,
  normaliseStatus,
  normaliseDeployedCapital,
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

/** `contract_hash_version` value historically used while Hyperliquid mutations were live. */
const LEGACY_V2_CONTRACT_HASH_VERSION = 2;

function toDraftDto(row: MissionRow): MissionDraftDto {
  const acceptance = projectAcceptance(row);
  const status = normaliseStatus(row.status);
  const successCriteria = normaliseStringList(
    row.success_criteria_json,
    "success_criteria_json",
  );
  const stopConditions = normaliseStringList(
    row.stop_conditions_json,
    "stop_conditions_json",
  );
  const allowedChains = normalisePgArray(row.allowed_chains, "allowed_chains", 64);
  const allowedProtocols = normalisePgArray(
    row.allowed_protocols,
    "allowed_protocols",
    64,
  );
  const allowedWallets = normalisePgArray(row.allowed_wallets, "allowed_wallets", 128);
  // THE engine predicate, CALLED - not mirrored. `missions-db-normalize.ts`
  // hand-copies `DEPLOYED_CAPITAL_BOUNDS` because those values are frozen into
  // acceptance hashes, where a drift is unfixable. Readiness is the opposite
  // case: a live decision that must never disagree with the engine's own
  // `draft → ready` transition, so it is imported rather than restated.
  const missingFields = getMissingDraftFields({
    title: row.title,
    goal: row.goal,
    capitalSourceJson: (row.capital_source_json ?? null) as Record<string, unknown> | null,
    allowedWallets,
    allowedChains,
    allowedProtocols,
    riskProfile: row.risk_profile,
    successCriteria,
    stopConditions,
  });
  return {
    missionId: row.id,
    sessionId: row.root_session_id,
    status,
    title: row.title,
    goal: row.goal,
    constraints: normaliseConstraints(row.constraints_json),
    // HISTORICAL ONLY (Hyperliquid removed, Agent Scan Phase 3): projected
    // ONLY for a mission that is ACTUALLY ACCEPTED at the frozen v2 contract
    // version (see `normaliseHyperliquidMissionRisk`'s own doc comment). Any
    // v1/v3 or unaccepted draft OMITS the property entirely (the shared
    // draft schema's "omitted for v1/v3" contract) regardless of what a
    // stale `constraints_json.hyperliquidRisk` key might still contain —
    // e.g. a fresh draft renewed from a v2-accepted mission is unaccepted
    // (v3-to-be) and must never resurface the source's historical risk
    // envelope. An accepted v2 row WITHOUT a risk envelope keeps an
    // explicit `hyperliquidRisk: null` (populated-vs-absent stays
    // distinguishable for the one cohort that legitimately carries it).
    ...(acceptance !== null && acceptance.contractHashVersion === LEGACY_V2_CONTRACT_HASH_VERSION
      ? { hyperliquidRisk: normaliseHyperliquidMissionRisk(row.constraints_json) }
      : {}),
    successCriteria,
    stopConditions,
    riskProfile: row.risk_profile,
    allowedChains,
    allowedProtocols,
    allowedWallets,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    approvedAt: toIsoOrNull(row.approved_at),
    acceptance,
    // C3 - hash-bound measurement base, projected so the contract card can show
    // the host what the acceptance actually covers. Null means "not declared",
    // which is itself meaningful (it is what suppresses measurability warnings).
    deployedCapital: normaliseDeployedCapital(row.capital_source_json),
    renewedFromMissionId: row.renewed_from_mission_id ?? null,
    missingFields,
    // The capability answer, decided HERE so no renderer surface re-derives it.
    // `ready` is exactly the status `commit-start.ts` requires: accepting a
    // `draft`-status contract is permitted by `engine/mission/acceptance.ts` but
    // then refused at start with `not_ready`, which would only relocate the dead
    // end this projection exists to remove.
    canAcceptContract: status === "ready",
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
 * Pending-draft exclusion: a source is ALSO suppressed while the session
 * still holds a `draft`/`ready` mission. Renewal clones a finished mission
 * into a fresh draft, but the source keeps satisfying every predicate above,
 * so without this the Renew control lingered and repeat clicks cloned
 * duplicate drafts. While a draft is pending, `getDraftForSession` surfaces
 * it instead — the two resolvers are mutually exclusive, so a renderer that
 * shows one never simultaneously shows the other.
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
            -- Suppress the source once a fresh draft already exists for the
            -- session. Otherwise the OLD terminal accepted mission keeps
            -- satisfying every predicate above even after mission.renew
            -- clones a draft from it, so the Renew control lingers and each
            -- extra click clones ANOTHER duplicate draft. A finished mission
            -- is renewable only when nothing is pending: while a draft/ready
            -- mission exists, getDraftForSession surfaces it instead. Keeps
            -- the two resolvers mutually exclusive at the source.
            AND NOT EXISTS (
              SELECT 1
                FROM missions d
               WHERE d.root_session_id = m.root_session_id
                 AND d.status IN ('draft', 'ready')
            )
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
