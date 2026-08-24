/**
 * Sessions repo — session lifecycle, compaction, scope.
 *
 * Compaction model:
 *   - `setRollingSummary` updates only the summary text.
 *   - `archivePrefix` moves a bounded prefix of messages into `messages_archive`
 *     (partial compact) and sets the new live `message_count`. `token_count`
 *     is NOT reset here — it's overwritten by the next turn's prompt size in
 *     `turn.ts::updateTokenCount`.
 *   - `forkToolMessageToArchive` is the giant-tool fallback: it COPIES a single
 *     live row into `messages_archive` (same id, full payload) and overwrites
 *     the live row's `content` with a short placeholder. Used when a bloated
 *     tool output in the tail is the sole source of context pressure.
 *
 * Transaction coordination (PR2):
 *   `setRollingSummary` and `archivePrefix` accept an optional `PoolClient`.
 *   When provided, they run inside the caller's transaction instead of
 *   opening their own. `executeCompactNow` (Track 1) uses this to atomically
 *   apply the whole write phase (summary + generation bump + compact_jobs
 *   enqueue + archive) under a single BEGIN/COMMIT — a crash rolls back the
 *   entire set together.
 */

import type { PoolClient } from "pg";
import {
  executeWith,
  getPool,
  query,
  queryOne,
  queryOneWith,
  type Executor,
} from "../client.js";

export {
  archivePrefix,
  forkToolMessageToArchive,
} from "./sessions-archive.js";

interface SessionRow {
  id: string;
  scope: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  compacted: boolean;
  message_count: number;
  token_count: number;
  checkpoint_generation: number;
  /**
   * Session-level mode discriminator. `mapRow` normalises unexpected values
   * to `"agent"`.
   */
  mode?: string | null;
  /** Session-scoped approval policy: `restricted` (default) or `full`. */
  permission?: string | null;
  /** Snapshot of user-supplied goal at session creation; null for `agent` rows. */
  initial_goal?: string | null;
  /** Per-session selected wallet (id + address snapshot). Null = unselected. */
  selected_evm_wallet_id?: string | null;
  selected_evm_wallet_address?: string | null;
  selected_solana_wallet_id?: string | null;
  selected_solana_wallet_address?: string | null;
}

/**
 * Known values for `sessions.mode`. `"agent"` is a one-shot conversational
 * session (post-M12 rename from "chat"). `"mission"` is goal-driven and
 * runs in a loop with agent-self-scheduled wake via `LoopDefer`. Immutable
 * after session creation.
 */
export type SessionMode = "agent" | "mission";

/**
 * Session-scoped approval policy. `"restricted"` → every mutating tool
 * requires user approval. `"full"` → mutating tools auto-execute. Immutable
 * after session creation.
 */
export type SessionPermission = "restricted" | "full";

/** A session's pinned wallet choice: inventory id + on-chain address snapshot. */
export interface SessionWalletRef {
  id: string;
  address: string;
}

export interface Session {
  id: string;
  scope: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  compacted: boolean;
  messageCount: number;
  tokenCount: number;
  /**
   * Monotonic counter bumped once per successful checkpoint (see
   * `runCheckpointWriteTx`). Stamped on every session_memories row written
   * during that checkpoint so recall can surface recency as `gen:N`. Starts
   * at 0 for a freshly-created session; the first checkpoint lands rows at
   * generation 1.
   */
  checkpointGeneration: number;
  /**
   * Session-level mode. `"agent"` is one-shot conversational; `"mission"`
   * runs in a loop with agent self-scheduled wake. Immutable.
   */
  mode: SessionMode;
  /** Approval policy. Immutable. */
  permission: SessionPermission;
  /**
   * Snapshot of user intent at session creation. The negotiated/refined
   * mission contract goal lives on `missions.goal` and may differ from
   * this snapshot. `null` for `mode='agent'` sessions.
   */
  initialGoal: string | null;
  /**
   * Per-session wallet selection (puzzle 5 phase 5B). Immutable; set at
   * creation. `null` means no wallet of that family is selected → wallet tools
   * for that family fail closed.
   */
  selectedEvmWallet: SessionWalletRef | null;
  selectedSolanaWallet: SessionWalletRef | null;
}

function walletRef(
  id: string | null | undefined,
  address: string | null | undefined,
): SessionWalletRef | null {
  return id && address ? { id, address } : null;
}

function mapRow(r: SessionRow): Session {
  return {
    id: r.id,
    scope: r.scope,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    summary: r.summary,
    compacted: r.compacted,
    messageCount: r.message_count,
    tokenCount: r.token_count,
    checkpointGeneration: r.checkpoint_generation,
    mode: r.mode === "mission" ? "mission" : "agent",
    permission: r.permission === "full" ? "full" : "restricted",
    initialGoal: r.initial_goal ?? null,
    selectedEvmWallet: walletRef(r.selected_evm_wallet_id, r.selected_evm_wallet_address),
    selectedSolanaWallet: walletRef(r.selected_solana_wallet_id, r.selected_solana_wallet_address),
  };
}

export interface CreateSessionOptions {
  /** Mode is immutable per session. Defaults to `"agent"`. */
  mode?: SessionMode;
  /** Permission is immutable per session. Defaults to `"restricted"`. */
  permission?: SessionPermission;
  /**
   * Optional snapshot of the first mission goal. Mission sessions can be
   * created without it; GUI chat sets it on the first user turn.
   * Ignored for `mode === "agent"`.
   */
  initialGoal?: string | null;
  /**
   * Optional Executor — when provided, the insert runs inside the caller's
   * transaction. Mission session creation uses this to atomically insert
   * the `sessions` row + `missions` draft row.
   */
  executor?: Executor;
  /**
   * Per-session wallet selection, set atomically at creation and immutable
   * afterwards (puzzle 5 phase 5B). Typed pair objects, not loose ids.
   */
  selectedEvmWallet?: SessionWalletRef | null;
  selectedSolanaWallet?: SessionWalletRef | null;
}

/**
 * Create a session row. `ON CONFLICT DO NOTHING` keeps the first-writer-wins
 * semantics existing transports depend on. Mission rows may start without
 * `initialGoal`; setup/chat flows can fill it later.
 */
export async function createSession(
  id: string,
  options: CreateSessionOptions = {},
): Promise<void> {
  const mode: SessionMode = options.mode ?? "agent";
  const permission: SessionPermission = options.permission ?? "restricted";
  const initialGoal: string | null = mode === "mission" ? (options.initialGoal ?? null) : null;
  const evm = options.selectedEvmWallet ?? null;
  const solana = options.selectedSolanaWallet ?? null;
  const executor: Executor = options.executor ?? getPool();
  await executeWith(
    executor,
    `INSERT INTO sessions
       (id, mode, permission, initial_goal,
        selected_evm_wallet_id, selected_evm_wallet_address,
        selected_solana_wallet_id, selected_solana_wallet_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      id, mode, permission, initialGoal,
      evm?.id ?? null, evm?.address ?? null,
      solana?.id ?? null, solana?.address ?? null,
    ],
  );
}

/**
 * Mark a session as ended. Idempotent — safe to call multiple times on a
 * session that has already been ended (only the first call writes a value).
 *
 * Used by hosts on disconnect/shutdown so the `sessions.ended_at` column
 * reflects session lifecycle. Vex Agent's chat / mission flows do not call
 * this — their sessions stay open until compaction.
 */
export async function endSession(id: string): Promise<void> {
  await executeWith(
    getPool(),
    "UPDATE sessions SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL",
    [id],
  );
}

export async function getSession(id: string): Promise<Session | null> {
  const row = await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id]);
  return row ? mapRow(row) : null;
}

/**
 * Whether a session is soft-deleted (OD-3 = BLOCK as evidence source). `mapRow`
 * / `getSession` deliberately do not surface `deleted_at`, so the S4 evidence
 * deref needs this dedicated check: a candidate whose evidence anchor traces to
 * a soft-deleted session must be rejected (`insufficient_evidence`). A row that
 * does not exist returns `false` (existence is a SEPARATE check the caller makes
 * via the execution anchor); this answers ONLY "is it soft-deleted".
 */
export async function isSessionSoftDeleted(id: string): Promise<boolean> {
  if (!id) return false;
  const row = await queryOne<{ deleted_at: string | null }>(
    "SELECT deleted_at FROM sessions WHERE id = $1",
    [id],
  );
  return row !== null && row.deleted_at !== null;
}

/**
 * Whether a session is still there to run a turn in: the row EXISTS and has not
 * been soft-deleted.
 *
 * Both halves are one question, and asking them separately is what produced the
 * live defect. A launch form's continuation kept being retried for a session the
 * user had deleted (`sessions:delete` at 22:22:54): each attempt rebuilt a
 * prompt from a history that was no longer readable and each attempt was
 * refused, once a minute, forever. `isSessionSoftDeleted` cannot answer it —
 * it returns `false` for a row that does not exist at all, which is the
 * opposite of what a resume needs to hear.
 *
 * `ended_at` is deliberately NOT consulted: an ended session is a finished
 * conversation, not a missing one, and a turn owed to it is still owed.
 */
export async function isSessionResumable(id: string): Promise<boolean> {
  if (!id) return false;
  const row = await queryOne<{ deleted_at: string | Date | null }>(
    "SELECT deleted_at FROM sessions WHERE id = $1",
    [id],
  );
  return row !== null && row.deleted_at === null;
}

/**
 * The AUTHORITATIVE wallet selection and permission of one session, read inside
 * the CALLER's transaction.
 *
 * The authority-fence read, and client-bound for the reason the whole fence
 * exists: `updateProjectScope` mirrors a Studio project's wallet selection and
 * permission onto its backing session INSIDE a transaction that takes the
 * session control lock first. A reader that takes the same lock in the same
 * transaction therefore sees either the pre-edit or the post-edit values and
 * never a value the edit is midway through replacing - which a pool-level read
 * on another connection could not promise.
 *
 * `null` means the session row is gone, which fails every comparison closed.
 */
export interface SessionWalletAuthority {
  readonly selectedEvmWalletAddress: string | null;
  readonly selectedSolanaWalletAddress: string | null;
  readonly permission: string | null;
}

export async function readSessionWalletAuthorityWith(
  client: PoolClient,
  id: string,
): Promise<SessionWalletAuthority | null> {
  const row = await queryOneWith<{
    selected_evm_wallet_address: string | null;
    selected_solana_wallet_address: string | null;
    permission: string | null;
  }>(
    client,
    `SELECT selected_evm_wallet_address, selected_solana_wallet_address, permission
       FROM sessions WHERE id = $1`,
    [id],
  );
  if (row === null) return null;
  return {
    selectedEvmWalletAddress: row.selected_evm_wallet_address,
    selectedSolanaWalletAddress: row.selected_solana_wallet_address,
    permission: row.permission,
  };
}

export async function setScope(id: string, scope: string): Promise<void> {
  await executeWith(getPool(), "UPDATE sessions SET scope = $1 WHERE id = $2", [scope, id]);
}

/** SET token count — latest prompt size for checkpoint pressure evaluation. Not cumulative. */
export async function updateTokenCount(id: string, tokenCount: number): Promise<void> {
  await executeWith(
    getPool(),
    "UPDATE sessions SET token_count = $2 WHERE id = $1",
    [id, tokenCount],
  );
}

/**
 * Persist the rolling session summary. Does NOT touch `token_count` or
 * `message_count`; those are partial-archive concerns and live on
 * `archivePrefix`.
 *
 * When `client` is provided, this runs inside the caller's transaction.
 * `executeCompactNow` uses this to group summary + generation bump +
 * compact_jobs enqueue + archive under a single atomic write.
 */
export async function setRollingSummary(
  id: string,
  summary: string,
  client?: PoolClient,
): Promise<void> {
  const exec: Executor = client ?? getPool();
  await executeWith(exec, "UPDATE sessions SET summary = $2 WHERE id = $1", [id, summary]);
}

export async function listSessions(scope?: string, limit = 50): Promise<Session[]> {
  const rows = scope
    ? await query<SessionRow>(
        "SELECT * FROM sessions WHERE scope = $1 ORDER BY started_at DESC LIMIT $2",
        [scope, limit],
      )
    : await query<SessionRow>(
        "SELECT * FROM sessions ORDER BY started_at DESC LIMIT $1",
        [limit],
      );
  return rows.map(mapRow);
}
