/**
 * Project scope edits (Vex Studio stage P): permission, wallet selection, agent
 * roster - all in one transaction, under optimistic concurrency.
 *
 * Two things make this module Studio-specific rather than a reuse of the
 * session wallet-scope helper:
 *
 *   1. `initializeSessionWalletScope` is an INITIALIZE-IF-EMPTY compare-and-set.
 *      It sets a family only while it is NULL and only while the session has no
 *      messages, and it is hard-coded to `scope = 'vex_app'`. A project's wallet
 *      scope is EDITABLE for the life of the project, including after its
 *      backing session has carried turns. This module therefore never calls it,
 *      and `main/database/sessions/wallet-scope.ts` is left exactly as it is -
 *      agent sessions keep their immutability.
 *   2. `project_wallets` is the authority. The backing session's four wallet
 *      columns and its `permission` are a MIRROR, updated here by a direct
 *      `UPDATE sessions ... WHERE id = $backing AND scope = 'vex_studio'`. The
 *      scope filter is what stops this path from ever touching an agent-mode
 *      session, whatever id it is handed.
 *
 * Concurrency: the guarded `UPDATE ... WHERE id = $1 AND scope_version = $2`
 * is the serialization point. Two concurrent edits both read version N; the
 * first commits N+1, the second matches zero rows and is refused by name with
 * `projects.scope_conflict` having written nothing. Last-write-wins is
 * deliberately not available here: a wallet selection and a permission are
 * authority, and silently overwriting somebody else's authority edit is exactly
 * the failure the version exists to prevent.
 *
 * Lock order (stage A3, binding): the backing session id is read OUTSIDE the
 * transaction because it is write-once and can never go stale; inside the
 * transaction the order is SESSION CONTROL LOCK -> the project's pending Studio
 * approval rows -> the `projects` row. It is the same order every A3
 * transaction takes (`engine/runtime/lease-and-status/session-control-lock.ts`),
 * which is what makes an approve racing a scope edit impossible to deadlock:
 * both take edge 0 first, so one of them simply waits.
 *
 * The refusal is INSIDE this transaction on purpose. A pending Studio approval
 * was granted authority under the version this edit is about to bump; refusing
 * it in a second transaction would leave a window in which it could still be
 * approved and dispatched under authority the user had already replaced.
 *
 * Commit gate: NOTHING is committed until the edit has been proved whole. The
 * mirror must have matched exactly one backing session, and the resulting
 * project must project cleanly through `buildProjectDtos` (the same wallet-drift
 * check every read applies). Either failure rolls the whole edit back, so the
 * caller's refusal and the database always agree that nothing was written.
 */

import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  VEX_STUDIO_SESSION_SCOPE,
  type ProjectDto,
  type ProjectUpdateScopeInput,
} from "@shared/schemas/projects.js";
import { log } from "../../logger/index.js";
import {
  projectBackingSessionIntegrityError,
  projectNotFoundError,
  projectScopeConflictError,
} from "../../studio/project-errors.js";
import {
  assertProjectsRootUnchanged,
  resolveProjectsRoot,
} from "../../studio/projects-root.js";
import {
  announceStudioRefusals,
  refusePendingStudioIntents,
  type RefusedStudioIntent,
} from "@vex-agent/engine/core/approval-runtime/studio/refuse.js";
import { acquireSessionControlLockOn } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { dbError, withClient } from "../sessions/connection.js";
import { buildProjectDtos } from "./read.js";
import {
  PROJECT_ROW_COLUMNS,
  PROJECT_WALLET_ROW_COLUMNS,
  type ProjectRow,
  type ProjectWalletRefs,
  type ProjectWalletRow,
} from "./mappers.js";

/**
 * Apply a scope edit.
 *
 * `walletRefs` is `null` when the caller is not changing the wallet selection.
 * When it is present the caller MUST already have resolved every id through the
 * inventory, exactly as the create path does; this module never resolves an id
 * itself, so a renderer-supplied address cannot reach the database here either.
 */
export async function updateProjectScope(
  input: ProjectUpdateScopeInput,
  walletRefs: ProjectWalletRefs | null,
  correlationId: string,
): Promise<Result<ProjectDto, VexError>> {
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return rootOutcome;
  const resolvedRoot = rootOutcome.data;

  return withClient(async (client) => {
    // Announced only after COMMIT. `runScopeTransaction` collects the rows it
    // refused and this releases the blocked MCP calls once the edit is durable;
    // a rolled-back edit announces nothing, because nothing was refused.
    let refused: readonly RefusedStudioIntent[] = [];
    try {
      const outcome = await runScopeTransaction(
        client,
        input,
        walletRefs,
        resolvedRoot,
        correlationId,
        (rows) => {
          refused = rows;
        },
      );
      if (outcome.ok) announceStudioRefusals(refused);
      return outcome;
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch (rbCause) {
        log.warn(
          "[projects-db] ROLLBACK after updateProjectScope failure failed",
          rbCause,
        );
      }
      return dbError("updateProjectScope transaction failed", cause);
    }
  });
}

async function runScopeTransaction(
  client: Client,
  input: ProjectUpdateScopeInput,
  walletRefs: ProjectWalletRefs | null,
  resolvedRoot: string,
  correlationId: string,
  recordRefusals: (rows: readonly RefusedStudioIntent[]) => void,
): Promise<Result<ProjectDto, VexError>> {
  // Read the backing session BEFORE the transaction opens. `backing_session_id`
  // is written once, with the project, and never updated, so a value read
  // outside the transaction cannot go stale - and reading it inside would mean
  // locking the project row before the session control lock, which inverts the
  // global lock order.
  const backing = await client.query<{ backing_session_id: string }>(
    "SELECT backing_session_id FROM projects WHERE id = $1 AND deleted_at IS NULL",
    [input.projectId],
  );
  const backingSessionId = backing.rows[0]?.backing_session_id ?? null;

  await client.query("BEGIN");

  // Edge 0 of the global lock order, before any row lock. A missing project has
  // no session to key on; the guarded UPDATE below then matches zero rows and
  // reports `projects.not_found`, which is the same answer it always gave.
  if (backingSessionId !== null) {
    await acquireSessionControlLockOn(client, backingSessionId);
  }

  const rootCheck = await assertProjectsRootUnchanged(
    client,
    resolvedRoot,
    correlationId,
  );
  if (!rootCheck.ok) {
    await client.query("ROLLBACK");
    return rootCheck;
  }

  // Approval rows next, project row after. Every Studio approval still waiting
  // for a decision was granted authority under the version this edit replaces,
  // so it is refused HERE, in the transaction that bumps the version.
  recordRefusals(
    await refusePendingStudioIntents(
      client,
      { projectId: input.projectId },
      "scope_changed",
    ),
  );

  // Guarded update: the version match IS the concurrency control. `agents` and
  // `permission` use COALESCE so an omitted field keeps its stored value
  // without a second statement shape.
  const guarded = await client.query<ProjectRow>(
    `UPDATE projects
        SET permission = COALESCE($3, permission),
            agents = COALESCE($4, agents),
            scope_version = scope_version + 1,
            updated_at = NOW()
      WHERE id = $1 AND scope_version = $2 AND deleted_at IS NULL
      RETURNING ${PROJECT_ROW_COLUMNS}`,
    [
      input.projectId,
      input.expectedScopeVersion,
      input.permission ?? null,
      input.agents === undefined ? null : [...input.agents],
    ],
  );

  const row = guarded.rows[0];
  if (row === undefined) {
    // Zero rows means either "no such project" or "somebody edited first".
    // These are different situations with different remedies, so read the
    // current version inside the same transaction and say which one it is.
    const current = await client.query<{ scope_version: number }>(
      "SELECT scope_version FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [input.projectId],
    );
    await client.query("ROLLBACK");
    const actual = current.rows[0];
    if (actual === undefined) return err(projectNotFoundError(correlationId));
    return err(
      projectScopeConflictError(
        input.expectedScopeVersion,
        actual.scope_version,
        correlationId,
      ),
    );
  }

  if (walletRefs !== null) {
    for (const family of ["evm", "solana"] as const) {
      const ref = walletRefs[family];
      await client.query(
        `INSERT INTO project_wallets (project_id, family, wallet_id, address)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, family)
         DO UPDATE SET wallet_id = EXCLUDED.wallet_id, address = EXCLUDED.address`,
        [input.projectId, family, ref?.id ?? null, ref?.address ?? null],
      );
    }
  }

  // Mirror into the backing session. The `scope = 'vex_studio'` filter is the
  // guarantee that no agent-mode session can be written by this path. Wallet
  // columns are only mirrored when the selection actually changed, so an edit
  // that touches permission alone leaves them exactly as they were.
  const mirrored =
    walletRefs === null
      ? await client.query(
          `UPDATE sessions SET permission = $2
            WHERE id = $1 AND scope = $3`,
          [row.backing_session_id, row.permission, VEX_STUDIO_SESSION_SCOPE],
        )
      : await client.query(
          `UPDATE sessions
              SET permission = $2,
                  selected_evm_wallet_id = $3,
                  selected_evm_wallet_address = $4,
                  selected_solana_wallet_id = $5,
                  selected_solana_wallet_address = $6
            WHERE id = $1 AND scope = $7`,
          [
            row.backing_session_id,
            row.permission,
            walletRefs.evm?.id ?? null,
            walletRefs.evm?.address ?? null,
            walletRefs.solana?.id ?? null,
            walletRefs.solana?.address ?? null,
            VEX_STUDIO_SESSION_SCOPE,
          ],
        );

  // Exactly one row, or nothing happens. `projects.backing_session_id` is
  // UNIQUE and the session is created with the project in one transaction, so
  // any other count means the pair is broken. Committing a project whose
  // session did not receive the same permission and wallet scope would leave a
  // session-keyed gate deciding on stale authority, which is the one outcome
  // this mirror exists to prevent.
  if (mirrored.rowCount !== 1) {
    log.error(
      `[projects-db] backing-session mirror matched ${String(mirrored.rowCount)} rows, expected 1 ` +
        `projectId=${input.projectId} correlationId=${correlationId}`,
    );
    await client.query("ROLLBACK");
    return err(projectBackingSessionIntegrityError(correlationId));
  }

  const walletRows = await client.query<ProjectWalletRow>(
    `SELECT ${PROJECT_WALLET_ROW_COLUMNS} FROM project_wallets WHERE project_id = $1`,
    [input.projectId],
  );

  // Project BEFORE committing. `buildProjectDtos` verifies the stored wallet
  // selection against the inventory, and a drift there means this edit would
  // durably record a selection the app refuses to hand back. Projecting after
  // COMMIT would report the refusal while the write stood.
  const dtos = buildProjectDtos(
    [row],
    walletRows.rows,
    resolvedRoot,
    correlationId,
  );
  if (!dtos.ok) {
    await client.query("ROLLBACK");
    return dtos;
  }
  const dto = dtos.data[0];
  if (dto === undefined) {
    await client.query("ROLLBACK");
    return dbError(`updateProjectScope lost row id=${input.projectId}`);
  }

  await client.query("COMMIT");
  return ok(dto);
}
