/**
 * SEED ONE PENDING APPROVAL into an isolated run's database, and read its
 * settlement back.
 *
 * ## Why this exists at all
 *
 * There is no product path that CREATES an approval from the renderer, and
 * there must not be: an approval is raised by the engine or by the Studio MCP
 * surface, and the model may propose a tool call but never authorizes one
 * (rule 09). So a spec that needs to look at a pending approval in a real
 * window has exactly two options - drive a whole agent turn, or write the row
 * the engine would have written. This module does the second, against the
 * throwaway Postgres `vex-stack.ts` owns, using the same INSERT shape the
 * engine's own integration suite uses (`src/__tests__/integration/engine/
 * studio-dispatch-gate.int.test.ts`).
 *
 * ## What it deliberately does NOT do
 *
 * It does not decide anything. The decision path under test is the product's
 * (`approvals.reject` -> `prepareReject` -> the origin-aware rejection
 * dispatcher), and this module only reads the row back afterwards. A test-side
 * write of `decision` would be a second source of truth for the one fact the
 * walk is trying to prove.
 *
 * ## Ownership
 *
 * Every client is opened and closed by {@link withStackDatabase}; nothing here
 * hands a live connection to a caller, so a failing assertion inside the
 * callback still closes the socket.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

import { E2E_DB_NAME, E2E_DB_USER, type StartedVexIsolatedStack } from "./vex-stack.js";

/** The isolated Postgres is local and already up; a slow connect is a defect. */
const CONNECT_TIMEOUT_MS = 5_000;
/** Every statement here touches at most a handful of rows. */
const STATEMENT_TIMEOUT_MS = 10_000;

/** One project's identity, as the app minted it. */
export interface SeededProjectRow {
  readonly id: string;
  /** `projects.backing_session_id` - what a Studio intent must be keyed on. */
  readonly backingSessionId: string;
}

/** What a decided approval settled to, read straight from the two tables. */
export interface ApprovalSettlement {
  readonly queueStatus: string;
  readonly decision: string | null;
  readonly decisionReason: string | null;
  readonly executionStatus: string;
  readonly resolvedAt: string | null;
}

/**
 * Run `fn` against this run's throwaway Postgres.
 *
 * The connection is owned here: acquired, handed over, and closed on every
 * exit path including a thrown assertion.
 */
export async function withStackDatabase<T>(
  stack: StartedVexIsolatedStack,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const password = (await readFile(stack.pgPasswordPath, "utf8")).trim();
  const client = new Client({
    host: "127.0.0.1",
    port: stack.pgPort,
    database: E2E_DB_NAME,
    user: E2E_DB_USER,
    password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The project the app created under this name.
 *
 * @throws when no such row exists - the caller drove the creator, so a missing
 * row is the create path failing rather than a state to tolerate.
 */
export async function readProjectRow(
  client: Client,
  name: string,
): Promise<SeededProjectRow> {
  const result = await client.query<{ id: string; backing_session_id: string }>(
    "SELECT id, backing_session_id FROM projects WHERE name = $1",
    [name],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`no projects row named ${JSON.stringify(name)} after the creator reported success`);
  }
  return { id: row.id, backingSessionId: row.backing_session_id };
}

/** What the seeded approval says it wants to do. */
export interface PendingStudioApproval {
  readonly project: SeededProjectRow;
  /** Shown as the card's tool name; the DTO reads it from `preview_json`. */
  readonly toolName: string;
  /** The MCP client name the card attributes the request to. */
  readonly requestedByClient: string;
  /** Rendered in the card's critical-args well. */
  readonly criticalArgs: Readonly<Record<string, string>>;
}

/**
 * Write the pending pair - `approval_queue` plus its `approval_intents`
 * companion - exactly as a Studio MCP enqueue does.
 *
 * `risk_level: 'high'` and `action_kind: 'user_wallet_broadcast'` are not
 * decoration: both put the card behind the two-step confirm
 * (`ApprovalCard/risk.ts`), which is the state a money-path approval is
 * actually decided in.
 *
 * @returns the approval id, which is also the card's `data-approval-id`.
 */
export async function seedPendingStudioApproval(
  client: Client,
  approval: PendingStudioApproval,
): Promise<string> {
  const approvalId = randomUUID();
  const toolCallId = `call-${approvalId}`;
  await client.query(
    `INSERT INTO approval_queue
       (id, tool_call, reasoning, status, session_id, tool_call_id, source,
        permission_at_enqueue)
     VALUES ($1, $2::jsonb, $3, 'pending', $4, $5, 'studio_mcp', 'restricted')`,
    [
      approvalId,
      JSON.stringify({ namespace: "vex", command: approval.toolName }),
      "An MCP client asked Vex to sign a transfer.",
      approval.project.backingSessionId,
      toolCallId,
    ],
  );
  await client.query(
    `INSERT INTO approval_intents
       (approval_id, session_id, mission_run_id, tool_call_id, action_kind,
        risk_level, preview_json, policy_json, expires_at, execution_status,
        origin, project_id, scope_version_at_enqueue,
        dispatch_generation_at_enqueue)
     VALUES ($1, $2, NULL, $3, 'user_wallet_broadcast', 'high', $4::jsonb,
             $5::jsonb, NOW() + INTERVAL '1 hour', 'not_started', 'studio_mcp',
             $6, 1, 1)`,
    [
      approvalId,
      approval.project.backingSessionId,
      toolCallId,
      JSON.stringify({
        toolName: approval.toolName,
        namespace: "vex",
        criticalArgs: approval.criticalArgs,
      }),
      JSON.stringify({ requestedByClient: approval.requestedByClient }),
      approval.project.id,
    ],
  );
  return approvalId;
}

/** Read both halves of the row back, so a settlement is proven in the world. */
export async function readApprovalSettlement(
  client: Client,
  approvalId: string,
): Promise<ApprovalSettlement> {
  const result = await client.query<{
    status: string;
    resolved_at: Date | null;
    decision: string | null;
    decision_reason: string | null;
    execution_status: string;
  }>(
    `SELECT q.status, q.resolved_at, i.decision, i.decision_reason,
            i.execution_status
       FROM approval_queue q
       JOIN approval_intents i ON i.approval_id = q.id
      WHERE q.id = $1`,
    [approvalId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`approval ${approvalId} vanished from the queue`);
  }
  return {
    queueStatus: row.status,
    decision: row.decision,
    decisionReason: row.decision_reason,
    executionStatus: row.execution_status,
    resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
  };
}
