/**
 * Main-owned Hyperliquid projection and risk-proposal access.
 *
 * Every renderer read resolves the session's selected EVM wallet in main and
 * binds it into SQL. Raw projection JSONB and wallet addresses never cross the
 * IPC boundary. This module deliberately owns its own pg.Client, matching the
 * other vex-app database facades rather than importing engine repositories.
 */

import { Decimal } from "decimal.js";
import { Client, type ClientConfig } from "pg";

import {
  hyperliquidMissionRiskSchema,
  hyperliquidPolicySchema,
  type HyperliquidMissionRisk,
  type HyperliquidPolicy,
} from "@vex-lib/hyperliquid-policy.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  hyperliquidPositionDtoSchema,
  hyperliquidPositionsDtoSchema,
  hyperliquidRiskProposalDtoSchema,
  type HyperliquidAccountDto,
  type HyperliquidPositionDto,
  type HyperliquidPositionsDto,
  type HyperliquidRiskProposalDto,
  type HyperliquidRiskAdjustment,
  hyperliquidSessionRiskPolicyDtoSchema,
  type HyperliquidSessionRiskPolicyDto,
  type HyperliquidSessionRiskPolicySetInput,
  type HyperliquidWatchlistItemDto,
} from "@shared/schemas/hyperliquid.js";
import { log } from "../logger/index.js";
import { buildPoolConfig } from "./db-config.js";
import { getSessionWalletScope } from "./sessions-db.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;
const HYPERLIQUID_DB_CORRELATION_ID = "hyperliquid-db";

interface HyperliquidPositionRow {
  readonly contracts: string | number | null;
  readonly entry_price_usd: string | number | null;
  readonly unrealized_pnl_usd: string | number | null;
  readonly data: unknown;
  readonly last_refresh_at: string | Date | null;
  readonly synced_at: string | Date | null;
  readonly opened_at: string | Date | null;
}

interface HyperliquidPolicyRow {
  readonly proposal_id: string;
  readonly session_id: string;
  readonly wallet_address: string;
  readonly coin: string;
  readonly policy_json: unknown;
  readonly proposed_by: string;
  readonly status: string;
  readonly confirmed_at: string | Date | null;
  readonly expires_at: string | Date | null;
  readonly created_at: string | Date;
}

export interface ActiveHyperliquidPolicyOverlay {
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly proposalId: string;
  readonly policy: HyperliquidPolicy;
  readonly expiresAt: string | null;
}

export interface ActiveHyperliquidMissionPolicyOverlay {
  readonly missionId: string;
  readonly contractHash: string;
  readonly risk: HyperliquidMissionRisk;
}

function databaseUnavailable(correlationId: string): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "hyperliquid",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function databaseError(
  reason: string,
  cause: unknown,
  correlationId: string,
): Result<never, VexError> {
  log.warn(`[hyperliquid-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "hyperliquid",
    message: "Unable to load Hyperliquid data.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

async function withClient<T>(
  operation: (client: Client) => Promise<Result<T, VexError>>,
  correlationId: string,
): Promise<Result<T, VexError>> {
  let config: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    config = await buildPoolConfig();
  } catch (cause) {
    log.warn("[hyperliquid-db] buildPoolConfig failed", cause);
    return databaseUnavailable(correlationId);
  }
  if (config === null) return databaseUnavailable(correlationId);

  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  } satisfies ClientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[hyperliquid-db] client.connect failed", cause);
    return databaseUnavailable(correlationId);
  }
  try {
    return await operation(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[hyperliquid-db] client.end failed", cause);
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function canonicalDecimal(value: unknown, signed: boolean): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || (!signed && decimal.isNegative())) return null;
    const normalized = decimal.toFixed();
    return normalized === "-0" ? "0" : normalized;
  } catch {
    return null;
  }
}

function requiredDecimal(value: unknown, signed: boolean): string | null {
  const normalized = canonicalDecimal(value, signed);
  if (normalized === null) return null;
  if (!signed && new Decimal(normalized).lte(0)) return null;
  return normalized;
}

function stringAt(data: Record<string, unknown>, key: string): string | null {
  return typeof data[key] === "string" ? data[key] : null;
}

function protectionState(data: Record<string, unknown>): HyperliquidPositionDto["protectionState"] | null {
  const value = data["protectionState"];
  return value === "FLAT" || value === "OPENING" || value === "CONSOLIDATING"
    || value === "PROTECTED" || value === "PARTIAL" || value === "UNPROTECTED"
    || value === "unprotected_by_user_choice"
    ? value
    : null;
}

function positionFromRow(row: HyperliquidPositionRow): HyperliquidPositionDto | null {
  const data = record(row.data);
  if (data === null) return null;
  const coin = stringAt(data, "coin");
  const signedSize = canonicalDecimal(data["signedSize"], true);
  let side: HyperliquidPositionDto["side"] | null;
  if (signedSize !== null) {
    side = new Decimal(signedSize).gt(0) ? "long" : "short";
  } else {
    const reportedSide = stringAt(data, "side");
    side = reportedSide === "long" || reportedSide === "short" ? reportedSide : null;
  }
  const size = requiredDecimal(row.contracts ?? data["contracts"], false);
  const entryPx = requiredDecimal(row.entry_price_usd ?? data["entryPx"], false);
  const markPx = requiredDecimal(data["markPx"], false);
  const unrealizedPnl = canonicalDecimal(row.unrealized_pnl_usd ?? data["unrealizedPnlUsd"], true);
  const fundingAccrued = canonicalDecimal(data["cumFundingSinceOpen"], true);
  const state = protectionState(data);
  const confirmedAt = iso(stringAt(data, "confirmedAt"));
  const updatedAt = iso(row.synced_at) ?? iso(row.last_refresh_at) ?? iso(row.opened_at);
  if (
    coin === null || side === null || size === null || entryPx === null || markPx === null
    || unrealizedPnl === null || fundingAccrued === null || state === null
    || confirmedAt === null || updatedAt === null
  ) return null;

  const candidate: HyperliquidPositionDto = {
    coin,
    side,
    size,
    entryPx,
    markPx,
    leverage: canonicalDecimal(data["leverage"], false),
    marginMode: stringAt(data, "marginMode") === "cross"
      ? "cross"
      : stringAt(data, "marginMode") === "isolated"
        ? "isolated"
        : "unknown",
    liquidationPx: canonicalDecimal(data["liquidationPx"], false),
    unrealizedPnl,
    fundingAccrued,
    slPrice: canonicalDecimal(data["slPrice"], false),
    tpPrice: canonicalDecimal(data["tpPrice"], false),
    protectionState: state,
    confirmedAt,
    updatedAt,
  };
  return hyperliquidPositionDtoSchema.safeParse(candidate).success
    ? candidate
    : null;
}

function emptyAccount(): HyperliquidAccountDto {
  return { equityUsd: null, withdrawableUsd: null, totalUnrealizedPnlUsd: null };
}

/** Account fields are repeated in each reconciler capture for its wallet. */
function accountFromRows(rows: readonly HyperliquidPositionRow[]): HyperliquidAccountDto {
  for (const row of rows) {
    const data = record(row.data);
    if (data === null) continue;
    const candidate: HyperliquidAccountDto = {
      equityUsd: canonicalDecimal(data["accountEquityUsd"], false),
      withdrawableUsd: canonicalDecimal(data["accountWithdrawableUsd"], false),
      totalUnrealizedPnlUsd: canonicalDecimal(data["accountTotalUnrealizedPnlUsd"], true),
    };
    if (candidate.equityUsd !== null || candidate.withdrawableUsd !== null || candidate.totalUnrealizedPnlUsd !== null) {
      return candidate;
    }
  }
  return emptyAccount();
}

/** Market slice is reconciler-owned; reject malformed JSONB rows rather than exposing them. */
function watchlistFromRows(rows: readonly HyperliquidPositionRow[]): readonly HyperliquidWatchlistItemDto[] {
  for (const row of rows) {
    const data = record(row.data);
    const rawWatchlist = data === null ? undefined : data["marketWatchlist"];
    if (!Array.isArray(rawWatchlist)) continue;
    const items: HyperliquidWatchlistItemDto[] = [];
    for (const rawItem of rawWatchlist) {
      const item = record(rawItem);
      if (item === null) continue;
      const coin = stringAt(item, "coin");
      const midPx = requiredDecimal(item["midPx"], false);
      if (coin === null || midPx === null) continue;
      items.push({
        coin,
        midPx,
        change24hPct: canonicalDecimal(item["change24hPct"], true),
        openInterestUsd: canonicalDecimal(item["openInterestUsd"], false),
      });
      if (items.length === 16) break;
    }
    return items;
  }
  return [];
}

// W6 diagnostic (incident 2026-07-13): a session whose selected wallet has an
// OPEN perp capture in proj_activity but zero rows in proj_open_positions is the
// signature of the W7 projection-write defect. Warn once per (session,wallet)
// per 10 min, via a bounded expiring map — the main process is long-lived and
// must not grow this unbounded. The warn is redacted (6-char fingerprint only).
const MISSING_PROJECTION_WARN_TTL_MS = 10 * 60_000;
const MISSING_PROJECTION_WARN_MAX = 500;
const missingProjectionWarnedAt = new Map<string, number>();

function pruneMissingProjectionWarnMap(now: number): void {
  if (missingProjectionWarnedAt.size < MISSING_PROJECTION_WARN_MAX) return;
  for (const [key, expiry] of missingProjectionWarnedAt) {
    if (expiry <= now) missingProjectionWarnedAt.delete(key);
  }
  if (missingProjectionWarnedAt.size >= MISSING_PROJECTION_WARN_MAX) {
    const oldest = missingProjectionWarnedAt.keys().next().value;
    if (oldest !== undefined) missingProjectionWarnedAt.delete(oldest);
  }
}

async function warnOnMissingHyperliquidProjection(
  client: Client,
  sessionId: string,
  walletAddress: string,
  correlationId: string,
): Promise<void> {
  const key = `${sessionId} ${walletAddress}`;
  const now = Date.now();
  const existing = missingProjectionWarnedAt.get(key);
  if (existing !== undefined && existing > now) return;
  try {
    const probe = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM (
           SELECT DISTINCT ON (position_key) capture_status
           FROM proj_activity
           WHERE namespace = 'hyperliquid' AND product_type = 'perps'
             AND wallet_address = $1 AND position_key IS NOT NULL
           ORDER BY position_key, created_at DESC, id DESC
         ) latest
         WHERE capture_status = 'open'
       ) AS exists`,
      [walletAddress],
    );
    if (probe.rows[0]?.exists !== true) return;
  } catch (cause) {
    log.warn("[hyperliquid-db] missing-projection probe failed", cause);
    return;
  }
  pruneMissingProjectionWarnMap(now);
  missingProjectionWarnedAt.set(key, now + MISSING_PROJECTION_WARN_TTL_MS);
  log.warn(
    `[hyperliquid-db] open perp capture present but projection empty wallet=${walletAddress.slice(0, 6)} correlationId=${correlationId}`,
  );
}

/** Session-scoped positions. An absent EVM selection returns an empty DTO before SQL. */
export async function getHyperliquidPositions(
  sessionId: string,
  correlationId = HYPERLIQUID_DB_CORRELATION_ID,
): Promise<Result<HyperliquidPositionsDto, VexError>> {
  const scope = await getSessionWalletScope(sessionId);
  if (!scope.ok) return scope;
  const walletAddress = scope.data.evm?.address;
  const now = new Date().toISOString();
  if (walletAddress === undefined) return ok({
    sessionId,
    positions: [],
    account: emptyAccount(),
    watchlist: [],
    updatedAt: now,
  });

  return withClient(async (client) => {
    try {
      const result = await client.query<HyperliquidPositionRow>(
        `SELECT contracts, entry_price_usd, unrealized_pnl_usd, data,
                last_refresh_at, synced_at, opened_at
         FROM proj_open_positions
         WHERE namespace = 'hyperliquid'
           AND position_type = 'perps'
           AND status = 'open'
           AND wallet_address = ANY($1::text[])
         ORDER BY opened_at DESC NULLS LAST, id DESC
         LIMIT 100`,
        [[walletAddress]],
      );
      const positions = result.rows
        .map(positionFromRow)
        .filter((value): value is HyperliquidPositionDto => value !== null);
      if (positions.length === 0) {
        await warnOnMissingHyperliquidProjection(client, sessionId, walletAddress, correlationId);
      }
      return ok(hyperliquidPositionsDtoSchema.parse({
        sessionId,
        positions,
        account: accountFromRows(result.rows),
        watchlist: watchlistFromRows(result.rows),
        updatedAt: now,
      }));
    } catch (cause) {
      return databaseError("getHyperliquidPositions query failed", cause, correlationId);
    }
  }, correlationId);
}

/** True only when a real HL position or a latest tracked pending order remains. */
export async function hasHyperliquidExposure(): Promise<boolean> {
  const outcome = await withClient(async (client) => {
    try {
      const result = await client.query<{ exists: boolean }>(
        `SELECT (
           EXISTS (
             SELECT 1 FROM proj_open_positions
             WHERE namespace = 'hyperliquid' AND status = 'open'
           ) OR EXISTS (
             WITH latest AS (
               SELECT DISTINCT ON (position_key) position_key, capture_status
               FROM proj_activity
               WHERE namespace = 'hyperliquid' AND product_type = 'perps'
                 AND position_key IS NOT NULL
               ORDER BY position_key, created_at DESC, id DESC
             )
             SELECT 1 FROM latest WHERE capture_status IN ('pending', 'open', 'executed')
           )
         ) AS exists`,
      );
      return ok(result.rows[0]?.exists === true);
    } catch (cause) {
      return databaseError(
        "hasHyperliquidExposure query failed",
        cause,
        HYPERLIQUID_DB_CORRELATION_ID,
      );
    }
  }, HYPERLIQUID_DB_CORRELATION_ID);
  return outcome.ok && outcome.data;
}

/** Sessions whose selected EVM wallet currently owns an open HL perp projection. */
export async function listHyperliquidPositionSessionIds(): Promise<readonly string[]> {
  const outcome = await withClient(async (client) => {
    try {
      const result = await client.query<{ id: string }>(
        `SELECT DISTINCT sessions.id
         FROM sessions
         JOIN proj_open_positions positions
           ON positions.wallet_address = sessions.selected_evm_wallet_address
         WHERE sessions.deleted_at IS NULL
           AND positions.namespace = 'hyperliquid'
           AND positions.position_type = 'perps'
           AND positions.status = 'open'
         ORDER BY sessions.id ASC
         LIMIT 100`,
      );
      return ok(result.rows.map((row) => row.id));
    } catch (cause) {
      return databaseError(
        "listHyperliquidPositionSessionIds query failed",
        cause,
        HYPERLIQUID_DB_CORRELATION_ID,
      );
    }
  }, HYPERLIQUID_DB_CORRELATION_ID);
  return outcome.ok ? outcome.data : [];
}

function proposalDto(row: HyperliquidPolicyRow): HyperliquidRiskProposalDto | null {
  const policy = hyperliquidPolicySchema.safeParse(row.policy_json);
  const proposedBy = row.proposed_by === "agent" || row.proposed_by === "user" ? row.proposed_by : null;
  const status = row.status === "proposed" || row.status === "active" || row.status === "expired" || row.status === "revoked"
    ? row.status
    : null;
  const createdAt = iso(row.created_at);
  if (!policy.success || proposedBy === null || status === null || createdAt === null) return null;
  const candidate: HyperliquidRiskProposalDto = {
    proposalId: row.proposal_id,
    sessionId: row.session_id,
    coin: row.coin,
    policy: policy.data,
    proposedBy,
    status,
    confirmedAt: iso(row.confirmed_at),
    expiresAt: iso(row.expires_at),
    createdAt,
  };
  return hyperliquidRiskProposalDtoSchema.safeParse(candidate).success ? candidate : null;
}

/** Main-only cache hydration; throws so the policy resolver can fail closed. */
export async function loadActiveHyperliquidPolicyOverlays(): Promise<readonly ActiveHyperliquidPolicyOverlay[]> {
  const config = await buildPoolConfig();
  if (config === null) throw new Error("Hyperliquid policy database is unavailable.");
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  } satisfies ClientConfig);
  try {
    await client.connect();
    const result = await client.query<HyperliquidPolicyRow>(
      `SELECT proposal_id, session_id, wallet_address, coin, policy_json,
              proposed_by, status, confirmed_at, expires_at, created_at
       FROM hyperliquid_session_policies
       WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())`,
    );
    const overlays: ActiveHyperliquidPolicyOverlay[] = [];
    for (const row of result.rows) {
      const policy = hyperliquidPolicySchema.safeParse(row.policy_json);
      if (!policy.success) throw new Error("Stored Hyperliquid policy is invalid.");
      const expiresAt = iso(row.expires_at);
      if (row.expires_at !== null && expiresAt === null) {
        throw new Error("Stored Hyperliquid policy expiry is invalid.");
      }
      overlays.push({
        sessionId: row.session_id,
        walletAddress: row.wallet_address,
        proposalId: row.proposal_id,
        policy: policy.data,
        expiresAt,
      });
    }
    return overlays;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Main-only cache hydration for accepted v2 mission contracts. Legacy v1 rows
 * cannot contain `hyperliquidRisk`, so they intentionally produce no overlay.
 */
export async function loadActiveHyperliquidMissionPolicyOverlays(): Promise<readonly ActiveHyperliquidMissionPolicyOverlay[]> {
  const config = await buildPoolConfig();
  if (config === null) throw new Error("Hyperliquid mission policy database is unavailable.");
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  } satisfies ClientConfig);
  try {
    await client.connect();
    const result = await client.query<{
      id: string;
      accepted_contract_hash: string;
      constraints_json: unknown;
    }>(
      `SELECT id, accepted_contract_hash, constraints_json
       FROM missions
       WHERE accepted_contract_hash IS NOT NULL AND contract_hash_version = 2`,
    );
    const overlays: ActiveHyperliquidMissionPolicyOverlay[] = [];
    for (const row of result.rows) {
      const constraints = record(row.constraints_json);
      const risk = hyperliquidMissionRiskSchema.safeParse(constraints?.["hyperliquidRisk"]);
      if (!risk.success) continue;
      overlays.push({ missionId: row.id, contractHash: row.accepted_contract_hash, risk: risk.data });
    }
    return overlays;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Renderer card reads only proposals belonging to the selected session wallet. */
export async function listHyperliquidRiskProposals(
  sessionId: string,
  correlationId = HYPERLIQUID_DB_CORRELATION_ID,
): Promise<Result<readonly HyperliquidRiskProposalDto[], VexError>> {
  const scope = await getSessionWalletScope(sessionId);
  if (!scope.ok) return scope;
  const walletAddress = scope.data.evm?.address;
  if (walletAddress === undefined) return ok([]);
  return withClient(async (client) => {
    try {
      const result = await client.query<HyperliquidPolicyRow>(
        `SELECT proposal_id, session_id, wallet_address, coin, policy_json,
                proposed_by, status, confirmed_at, expires_at, created_at
         FROM hyperliquid_session_policies
         WHERE session_id = $1 AND wallet_address = $2
         ORDER BY created_at DESC
         LIMIT 20`,
        [sessionId, walletAddress],
      );
      return ok(result.rows.map(proposalDto).filter((value): value is HyperliquidRiskProposalDto => value !== null));
    } catch (cause) {
      return databaseError("listHyperliquidRiskProposals query failed", cause, correlationId);
    }
  }, correlationId);
}

async function selectedEvmWalletAddress(
  sessionId: string,
): Promise<Result<string | null, VexError>> {
  const scope = await getSessionWalletScope(sessionId);
  if (!scope.ok) return scope;
  return ok(scope.data.evm?.address ?? null);
}

/**
 * A renderer adjustment is persisted as a NEW user proposal. It never edits
 * the agent row the user reviewed, and it cannot change global-only fields
 * such as stop-loss or egress policy.
 */
export async function createAdjustedHyperliquidRiskProposal(
  sessionId: string,
  proposalId: string,
  adjustments: HyperliquidRiskAdjustment,
  correlationId = HYPERLIQUID_DB_CORRELATION_ID,
): Promise<Result<HyperliquidRiskProposalDto, VexError>> {
  const wallet = await selectedEvmWalletAddress(sessionId);
  if (!wallet.ok) return wallet;
  if (wallet.data === null) {
    return err({
      code: "validation.invalid_input",
      domain: "hyperliquid",
      message: "Select an EVM wallet for this session before adjusting Hyperliquid risk.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    });
  }
  return withClient(async (client) => {
    try {
      const current = await client.query<HyperliquidPolicyRow>(
        `SELECT proposal_id, session_id, wallet_address, coin, policy_json,
                proposed_by, status, confirmed_at, expires_at, created_at
         FROM hyperliquid_session_policies
         WHERE proposal_id = $1 AND session_id = $2 AND wallet_address = $3
           AND status = 'proposed'
         LIMIT 1`,
        [proposalId, sessionId, wallet.data],
      );
      const original = current.rows[0];
      if (original === undefined) {
        return err({
          code: "validation.invalid_input",
          domain: "hyperliquid",
          message: "That Hyperliquid risk proposal is no longer available.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId,
        });
      }
      const parsed = hyperliquidPolicySchema.safeParse(original.policy_json);
      if (!parsed.success) return databaseError("stored risk proposal is invalid", undefined, correlationId);
      const policy = hyperliquidPolicySchema.parse({ ...parsed.data, ...adjustments });
      const inserted = await client.query<HyperliquidPolicyRow>(
        `INSERT INTO hyperliquid_session_policies
           (session_id, wallet_address, coin, policy_json, policy_version, proposed_by, status, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, 1, 'user', 'proposed', $5)
         RETURNING proposal_id, session_id, wallet_address, coin, policy_json,
                   proposed_by, status, confirmed_at, expires_at, created_at`,
        [sessionId, wallet.data, original.coin, JSON.stringify(policy), original.expires_at],
      );
      const dto = inserted.rows[0] === undefined ? null : proposalDto(inserted.rows[0]);
      return dto === null
        ? databaseError("adjusted risk proposal did not validate", undefined, correlationId)
        : ok(dto);
    } catch (cause) {
      return databaseError("createAdjustedHyperliquidRiskProposal failed", cause, correlationId);
    }
  }, correlationId);
}

/** Activate exactly one reviewed proposal for the trusted session wallet. */
export async function activateHyperliquidRiskProposal(
  sessionId: string,
  proposalId: string,
  correlationId = HYPERLIQUID_DB_CORRELATION_ID,
): Promise<Result<HyperliquidRiskProposalDto, VexError>> {
  const wallet = await selectedEvmWalletAddress(sessionId);
  if (!wallet.ok) return wallet;
  if (wallet.data === null) {
    return err({
      code: "validation.invalid_input",
      domain: "hyperliquid",
      message: "Select an EVM wallet for this session before confirming Hyperliquid risk.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    });
  }
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      const proposal = await client.query<HyperliquidPolicyRow>(
        `SELECT proposal_id, session_id, wallet_address, coin, policy_json,
                proposed_by, status, confirmed_at, expires_at, created_at
         FROM hyperliquid_session_policies
         WHERE proposal_id = $1 AND session_id = $2 AND wallet_address = $3
           AND status = 'proposed' AND (expires_at IS NULL OR expires_at > NOW())
         FOR UPDATE`,
        [proposalId, sessionId, wallet.data],
      );
      const row = proposal.rows[0];
      if (row === undefined || !hyperliquidPolicySchema.safeParse(row.policy_json).success) {
        await client.query("ROLLBACK");
        return err({
          code: "validation.invalid_input",
          domain: "hyperliquid",
          message: "That Hyperliquid risk proposal is no longer available.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId,
        });
      }
      await client.query(
        `UPDATE hyperliquid_session_policies SET status = 'revoked'
         WHERE session_id = $1 AND wallet_address = $2 AND status = 'active'`,
        [sessionId, wallet.data],
      );
      const activated = await client.query<HyperliquidPolicyRow>(
        `UPDATE hyperliquid_session_policies
         SET status = 'active', confirmed_at = NOW()
         WHERE proposal_id = $1 AND session_id = $2 AND wallet_address = $3
           AND status = 'proposed'
         RETURNING proposal_id, session_id, wallet_address, coin, policy_json,
                   proposed_by, status, confirmed_at, expires_at, created_at`,
        [proposalId, sessionId, wallet.data],
      );
      await client.query("COMMIT");
      const dto = activated.rows[0] === undefined ? null : proposalDto(activated.rows[0]);
      return dto === null
        ? databaseError("activated risk proposal did not validate", undefined, correlationId)
        : ok(dto);
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      return databaseError("activateHyperliquidRiskProposal failed", cause, correlationId);
    }
  }, correlationId);
}

/**
 * Direct user-owned session caps. The policy table's active-row uniqueness is
 * preserved by revoking the prior active row in the same transaction before
 * inserting this immediately active user-originated row.
 */
export async function setHyperliquidSessionRiskPolicy(
  sessionId: string,
  input: Omit<HyperliquidSessionRiskPolicySetInput, "sessionId">,
  correlationId = HYPERLIQUID_DB_CORRELATION_ID,
): Promise<Result<HyperliquidRiskProposalDto, VexError>> {
  const wallet = await selectedEvmWalletAddress(sessionId);
  if (!wallet.ok) return wallet;
  if (wallet.data === null) {
    return err({
      code: "validation.invalid_input",
      domain: "hyperliquid",
      message: "Select an EVM wallet for this session before setting Hyperliquid risk.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    });
  }
  const policy = hyperliquidPolicySchema.parse(input);
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE hyperliquid_session_policies SET status = 'revoked'
         WHERE session_id = $1 AND wallet_address = $2 AND status = 'active'`,
        [sessionId, wallet.data],
      );
      const inserted = await client.query<HyperliquidPolicyRow>(
        `INSERT INTO hyperliquid_session_policies
           (session_id, wallet_address, coin, policy_json, policy_version, proposed_by, status, confirmed_at, expires_at)
         VALUES ($1, $2, 'ALL', $3::jsonb, 1, 'user', 'active', NOW(), NULL)
         RETURNING proposal_id, session_id, wallet_address, coin, policy_json,
                   proposed_by, status, confirmed_at, expires_at, created_at`,
        [sessionId, wallet.data, JSON.stringify(policy)],
      );
      await client.query("COMMIT");
      const dto = inserted.rows[0] === undefined ? null : proposalDto(inserted.rows[0]);
      return dto === null
        ? databaseError("direct session risk policy did not validate", undefined, correlationId)
        : ok(dto);
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      return databaseError("setHyperliquidSessionRiskPolicy failed", cause, correlationId);
    }
  }, correlationId);
}

/**
 * Process-restart fallback for manual Hypervexing re-entry. Any historical
 * policy row counts; status and selected-wallet changes must not erase that
 * session-level fact. Database failures collapse to false so callers fail
 * closed.
 */
export async function hasHyperliquidSessionPolicyHistory(sessionId: string): Promise<boolean> {
  const outcome = await withClient(async (client) => {
    try {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM hyperliquid_session_policies
           WHERE session_id = $1
         ) AS exists`,
        [sessionId],
      );
      return ok(result.rows[0]?.exists === true);
    } catch (cause) {
      return databaseError(
        "hasHyperliquidSessionPolicyHistory query failed",
        cause,
        HYPERLIQUID_DB_CORRELATION_ID,
      );
    }
  }, HYPERLIQUID_DB_CORRELATION_ID);
  return outcome.ok && outcome.data;
}

/** Resolve the panel snapshot from the trusted session wallet and active row. */
export async function getHyperliquidSessionRiskPolicy(
  sessionId: string,
  defaults: HyperliquidPolicy,
  correlationId = HYPERLIQUID_DB_CORRELATION_ID,
): Promise<Result<HyperliquidSessionRiskPolicyDto, VexError>> {
  const wallet = await selectedEvmWalletAddress(sessionId);
  if (!wallet.ok) return wallet;
  if (wallet.data === null) return ok(hyperliquidSessionRiskPolicyDtoSchema.parse({ policy: defaults, source: "defaults" }));
  return withClient(async (client) => {
    try {
      const result = await client.query<HyperliquidPolicyRow>(
        `SELECT proposal_id, session_id, wallet_address, coin, policy_json,
                proposed_by, status, confirmed_at, expires_at, created_at
         FROM hyperliquid_session_policies
         WHERE session_id = $1 AND wallet_address = $2 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId, wallet.data],
      );
      const active = result.rows[0] === undefined ? null : proposalDto(result.rows[0]);
      if (active === null) return ok(hyperliquidSessionRiskPolicyDtoSchema.parse({ policy: defaults, source: "defaults" }));
      return ok(hyperliquidSessionRiskPolicyDtoSchema.parse({
        policy: active.policy,
        source: active.proposedBy === "user" ? "user" : "proposal",
      }));
    } catch (cause) {
      return databaseError("getHyperliquidSessionRiskPolicy failed", cause, correlationId);
    }
  }, correlationId);
}
