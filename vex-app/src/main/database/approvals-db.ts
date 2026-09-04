/**
 * Approvals DB helper for the approval queue panels.
 *
 * Mirrors `sessions-db.ts` decoupling: own `pg.Client` per call. The
 * mapper here is the *only* place where `approval_queue.tool_call`
 * JSONB gets reduced to an allow-listed renderer DTO. Raw `tool_call`
 * (which can carry wallet addresses, amounts, transfer args) never
 * leaves this module.
 *
 *   approval_queue(
 *     id TEXT PK, tool_call JSONB, reasoning TEXT,
 *     status, session_id, tool_call_id,
 *     permission_at_enqueue, source, pending_context JSONB,
 *     created_at, resolved_at
 *   )
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  APPROVAL_REASONING_PREVIEW_MAX,
  approvalActionKindSchema,
  approvalDecisionSchema,
  approvalExecutionStatusSchema,
  approvalOriginSchema,
  type ApprovalOrigin,
  approvalPermissionSchema,
  approvalPreviewSchema,
  approvalRiskLevelSchema,
  approvalStatusSchema,
  requestedByClientSchema,
  type ApprovalActionKind,
  type ApprovalDecision,
  type ApprovalExecutionStatus,
  type ApprovalPendingGlobalDto,
  type ApprovalPermission,
  type ApprovalPreview,
  type ApprovalRiskLevel,
  type ApprovalStatus,
  type ApprovalSummaryDto,
} from "@shared/schemas/approvals.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

// `correlationId` intentionally omitted; `registerHandler` stamps
// `ctx.requestId` downstream. See `messages-db.ts` for full rationale.
function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "approvals",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[approvals-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "approvals",
    message: "Unable to load approvals.",
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
    log.warn("[approvals-db] buildPoolConfig threw", cause);
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
    log.warn("[approvals-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[approvals-db] client.end failed (non-fatal)", cause);
    }
  }
}

interface ApprovalRow {
  readonly id: string;
  readonly status: string;
  readonly session_id: string | null;
  readonly tool_call_id: string | null;
  readonly tool_call: unknown;
  readonly reasoning: string | null;
  readonly permission_at_enqueue: string;
  readonly created_at: string | Date;
  readonly resolved_at: string | Date | null;
  /**
   * Puzzle 5 phase 2 — `approval_intents` companion columns via LEFT JOIN.
   * Null when no companion intent row exists (back-compat with approvals
   * created before migration 024).
   */
  readonly intent_action_kind: string | null;
  readonly intent_risk_level: string | null;
  readonly intent_preview_json: unknown;
  readonly intent_expires_at: string | Date | null;
  readonly intent_decision: string | null;
  readonly intent_decision_reason: string | null;
  readonly intent_execution_status: string | null;
  /**
   * B0 provenance. `origin` is `NOT NULL` on the table but arrives NULL through
   * the LEFT JOIN when there is no companion intent row at all.
   */
  readonly intent_origin: string | null;
  readonly intent_project_id: string | null;
  /**
   * `policy_json ->> 'requestedByClient'`, extracted in SQL so the raw policy
   * blob never crosses into this process as an object to be re-projected. Null
   * for an agent-originated approval, for a Studio client that declared no
   * usable name, and for a row written before the field existed.
   */
  readonly intent_requested_by_client: string | null;
}

/**
 * SELECT projection — `approval_queue` left-joined on `approval_intents`.
 * Companion columns aliased with `intent_` prefix so the row mapper can
 * keep raw approval columns and intent columns visually separate.
 */
const APPROVAL_ROW_COLUMNS = [
  "q.id",
  "q.status",
  "q.session_id",
  "q.tool_call_id",
  "q.tool_call",
  "q.reasoning",
  "q.permission_at_enqueue",
  "q.created_at",
  "q.resolved_at",
  "i.action_kind AS intent_action_kind",
  "i.risk_level AS intent_risk_level",
  "i.preview_json AS intent_preview_json",
  "i.expires_at AS intent_expires_at",
  "i.decision AS intent_decision",
  "i.decision_reason AS intent_decision_reason",
  "i.execution_status AS intent_execution_status",
  "i.origin AS intent_origin",
  "i.project_id AS intent_project_id",
  "i.policy_json ->> 'requestedByClient' AS intent_requested_by_client",
].join(", ");

const APPROVAL_FROM_CLAUSE =
  "FROM approval_queue q LEFT JOIN approval_intents i ON i.approval_id = q.id";

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function normaliseStatus(raw: string): ApprovalStatus {
  const parsed = approvalStatusSchema.safeParse(raw);
  // Engine should only emit canonical statuses; an exotic value
  // collapses to `pending` so the renderer renders the row as actionable
  // rather than disappearing it silently. The structural log line on
  // unexpected values flows through the dispatcher path.
  return parsed.success ? parsed.data : "pending";
}

function normalisePermission(raw: string): ApprovalPermission {
  const parsed = approvalPermissionSchema.safeParse(raw);
  return parsed.success ? parsed.data : "restricted";
}

/**
 * Best-effort tool identifier extraction from `tool_call` JSONB. Same
 * allowlist as the messages mapper: string fields only, never recurses
 * into nested objects, never returns the raw blob.
 */
function extractToolName(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const ns = typeof rec["namespace"] === "string" ? rec["namespace"] : null;
  const cmd = typeof rec["command"] === "string" ? rec["command"] : null;
  if (ns !== null && cmd !== null) return `${ns}:${cmd}`;
  if (cmd !== null) return cmd;
  const name = typeof rec["name"] === "string" ? rec["name"] : null;
  return name;
}

function reasoningPreview(raw: string | null): string {
  if (raw === null) return "";
  if (raw.length <= APPROVAL_REASONING_PREVIEW_MAX) return raw;
  return raw.slice(0, APPROVAL_REASONING_PREVIEW_MAX);
}

/**
 * Companion-column normalisers — return null when the LEFT JOIN found no
 * intent row OR when the value drifts outside the documented CHECK enum
 * (defense-in-depth against schema drift between agent migrations and the
 * mirrored copy in `vex-app/resources/migrations`).
 */
function normaliseIntentActionKind(raw: string | null): ApprovalActionKind | null {
  if (raw === null) return null;
  const parsed = approvalActionKindSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function normaliseIntentRiskLevel(raw: string | null): ApprovalRiskLevel | null {
  if (raw === null) return null;
  const parsed = approvalRiskLevelSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function normaliseIntentDecision(raw: string | null): ApprovalDecision | null {
  if (raw === null) return null;
  const parsed = approvalDecisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * An off-enum `origin` becomes NULL, NEVER `'agent'`.
 *
 * The default-to-agent shortcut is available and is wrong: it would relabel a
 * Studio-originated row - an EXTERNAL tool asking Vex's wallet to act - as one
 * Vex's own agent proposed, which is a lie about authority on a money path. A
 * null says "no provenance recorded", which is true and which the renderer can
 * present honestly.
 */
function normaliseIntentOrigin(raw: string | null): ApprovalOrigin | null {
  if (raw === null) return null;
  const parsed = approvalOriginSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function normaliseIntentExecutionStatus(
  raw: string | null,
): ApprovalExecutionStatus | null {
  if (raw === null) return null;
  const parsed = approvalExecutionStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Project the JSONB preview to the renderer-safe shape. Strict Zod parse
 * means a renderer never sees a preview that doesn't match
 * `approvalPreviewSchema` (Codex 2 phase-2 invariant: raw args / nested
 * blobs / bigint cannot leak via the preview path even if the engine writes
 * a malformed row).
 */
/**
 * The recorded MCP client name, or null.
 *
 * The engine already sanitized and bounded this value before storing it
 * (`sanitizeRequestingClientName`), and this is the READ side of a durable
 * column, so it is re-checked here rather than trusted: a row written by
 * another build, or edited, must not put control characters or an unbounded
 * string into a card a human decides from. Failing to null claims less, which
 * the renderer then states honestly.
 */
function normaliseRequestedByClient(raw: string | null): string | null {
  if (raw === null) return null;
  const parsed = requestedByClientSchema.safeParse(raw);
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}

function normaliseIntentPreview(raw: unknown): ApprovalPreview | null {
  if (raw === null || raw === undefined) return null;
  const parsed = approvalPreviewSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function toDto(row: ApprovalRow): ApprovalSummaryDto {
  const preview = normaliseIntentPreview(row.intent_preview_json);
  // Prefer the preview-resolved toolName over the legacy `tool_call` JSONB
  // extraction — for `execute_tool` wrappers the preview correctly carries
  // the TARGET toolId (e.g. `kyberswap.swap.sell`), whereas `tool_call.command`
  // is still `execute_tool` (Codex final review puzzle 5/2). Legacy rows
  // without a companion intent fall back to the JSONB extraction unchanged.
  const toolName = preview?.toolName ?? extractToolName(row.tool_call);
  return {
    id: row.id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName,
    status: normaliseStatus(row.status),
    permissionAtEnqueue: normalisePermission(row.permission_at_enqueue),
    createdAt: toIso(row.created_at),
    resolvedAt: toIsoOrNull(row.resolved_at),
    reasoningPreview: reasoningPreview(row.reasoning),
    actionKind: normaliseIntentActionKind(row.intent_action_kind),
    riskLevel: normaliseIntentRiskLevel(row.intent_risk_level),
    preview,
    expiresAt: toIsoOrNull(row.intent_expires_at),
    decision: normaliseIntentDecision(row.intent_decision),
    decisionReason: row.intent_decision_reason,
    executionStatus: normaliseIntentExecutionStatus(row.intent_execution_status),
    origin: normaliseIntentOrigin(row.intent_origin),
    projectId: row.intent_project_id,
    requestedByClient: normaliseRequestedByClient(row.intent_requested_by_client),
  };
}

export async function listPendingForSession(
  sessionId: string,
): Promise<Result<ReadonlyArray<ApprovalSummaryDto>, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<ApprovalRow>(
        `SELECT ${APPROVAL_ROW_COLUMNS}
           ${APPROVAL_FROM_CLAUSE}
          WHERE q.session_id = $1 AND q.status = 'pending'
          ORDER BY q.created_at ASC`,
        [sessionId],
      );
      return ok(result.rows.map(toDto));
    } catch (cause) {
      return dbError("listPendingForSession query failed", cause);
    }
  });
}

export async function getApprovalById(
  id: string,
): Promise<Result<ApprovalSummaryDto | null, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<ApprovalRow>(
        `SELECT ${APPROVAL_ROW_COLUMNS}
           ${APPROVAL_FROM_CLAUSE}
          WHERE q.id = $1
          LIMIT 1`,
        [id],
      );
      const row = result.rows[0];
      return ok(row ? toDto(row) : null);
    } catch (cause) {
      return dbError("getApprovalById query failed", cause);
    }
  });
}

export async function getHistoryForSession(
  sessionId: string,
  limit: number,
): Promise<Result<ReadonlyArray<ApprovalSummaryDto>, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<ApprovalRow>(
        `SELECT ${APPROVAL_ROW_COLUMNS}
           ${APPROVAL_FROM_CLAUSE}
          WHERE q.session_id = $1
          ORDER BY q.created_at DESC
          LIMIT $2`,
        [sessionId, limit],
      );
      return ok(result.rows.map(toDto));
    } catch (cause) {
      return dbError("getHistoryForSession query failed", cause);
    }
  });
}

/**
 * App-wide pending inbox — every `pending` approval across all sessions, plus
 * the display title of the owning session. Reuses the SAME allow-listed
 * `toDto` seam (raw `tool_call` JSONB never leaves this module) and the same
 * companion `approval_intents` LEFT JOIN, then joins `sessions` for the title.
 *
 * A1: the title mirrors the sidebar's `getSessionTitle` fallback
 * (`title` → `initial_goal`), resolved in SQL so a legacy row with no `title`
 * still shows its goal text. A5: a soft-deleted session (defensive — pending
 * approvals block delete) renders session-less.
 *
 * LIMIT 100 bounds the payload; the badge shows "99+" past that.
 */
const SESSION_TITLE_EXPR =
  "COALESCE(NULLIF(btrim(s.title), ''), NULLIF(btrim(s.initial_goal), ''))";

interface GlobalApprovalRow extends ApprovalRow {
  readonly session_title: string | null;
  readonly session_deleted_at: string | Date | null;
  readonly project_name: string | null;
}

function toGlobalDto(row: GlobalApprovalRow): ApprovalPendingGlobalDto {
  const base = toDto(row);
  // A5: if a row ever references a soft-deleted session, drop it to the
  // session-less presentation (fallback label, no "Open session") by nulling
  // both fields the renderer keys off.
  const sessionDeleted = row.session_deleted_at !== null;
  const sessionTitle =
    sessionDeleted || typeof row.session_title !== "string"
      ? null
      : row.session_title;
  return {
    ...base,
    sessionId: sessionDeleted ? null : base.sessionId,
    sessionTitle,
    // NOT nulled on a project tombstone, unlike `sessionTitle` on a deleted
    // session. A pending approval whose project was deleted still has to be
    // decidable, and "which project asked" is the fact that makes it so.
    projectName: row.project_name,
  };
}

export async function listPendingAllApprovals(): Promise<
  Result<ReadonlyArray<ApprovalPendingGlobalDto>, VexError>
> {
  return withClient(async (client) => {
    try {
      const result = await client.query<GlobalApprovalRow>(
        `SELECT ${APPROVAL_ROW_COLUMNS},
                ${SESSION_TITLE_EXPR} AS session_title,
                s.deleted_at AS session_deleted_at,
                p.name AS project_name
           ${APPROVAL_FROM_CLAUSE}
           LEFT JOIN sessions s ON s.id = q.session_id
           LEFT JOIN projects p ON p.id = i.project_id
          WHERE q.status = 'pending'
          ORDER BY q.created_at ASC
          LIMIT 100`,
      );
      return ok(result.rows.map(toGlobalDto));
    } catch (cause) {
      return dbError("listPendingAllApprovals query failed", cause);
    }
  });
}
